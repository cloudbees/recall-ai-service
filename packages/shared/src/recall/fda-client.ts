// openFDA API Client
// Connects to the FDA's open data API for drug, device, and food recall enforcement data
// Documentation: https://open.fda.gov/apis/
// Free API, no authentication required

export interface FDARecallResult {
  // OPTIONAL, despite appearances. The enforcement endpoints (drug, food) return
  // recall_number and event_id; device/recall.json returns neither — it identifies
  // records with cfres_id / product_res_number / res_event_number instead.
  //
  // These were declared required, which typechecked cleanly and was simply false.
  // That lie hid a bug which silently discarded every device recall.
  recall_number?: string;
  reason_for_recall: string;
  status: string;
  distribution_pattern: string;
  product_description: string;
  product_quantity: string;
  recalling_firm: string;
  city: string;
  state: string;
  classification: 'Class I' | 'Class II' | 'Class III';
  product_type: 'Drug' | 'Device' | 'Food';
  report_date: string;
  recall_initiation_date: string;
  voluntary_mandated: string;
  event_id?: string;
  // device/recall.json identifiers.
  cfres_id?: string;
  product_res_number?: string;
  res_event_number?: string;
  termination_date?: string;
}

/**
 * The identifier for an FDA record, whichever endpoint it came from.
 *
 * The enforcement endpoints (drug, food) use recall_number and event_id.
 * device/recall.json uses none of those — it has cfres_id, product_res_number and
 * res_event_number instead. Code that checked only the first two treated every
 * device record as unidentifiable, which caused silent data loss in dedupe and
 * `fda_undefined` ids downstream.
 *
 * Returns undefined only if the record carries no recognisable identifier at all.
 * Callers must handle that rather than interpolating it into a string.
 */
export function recallIdentifier(r: FDARecallResult): string | undefined {
  return (
    r.recall_number ||
    r.event_id ||
    r.product_res_number ||
    r.cfres_id ||
    r.res_event_number
  );
}

export interface FDASearchResponse {
  meta: {
    disclaimer: string;
    terms: string;
    license: string;
    last_updated: string;
    results: {
      skip: number;
      limit: number;
      total: number;
    };
  };
  results: FDARecallResult[];
}

export type FDAProductCategory = 'drug' | 'device' | 'food';

/**
 * Map from product categories used in the app to FDA enforcement endpoints
 */
const CATEGORY_TO_ENDPOINT: Record<string, FDAProductCategory[]> = {
  'Food & Beverages': ['food'],
  'Drugs & Pharmaceuticals': ['drug'],
  'Medical Devices': ['device'],
  'Cosmetics': ['drug'],
};

/**
 * FDA enforcement endpoint URLs by product category
 */
const FDA_ENDPOINTS: Record<FDAProductCategory, string> = {
  drug: 'https://api.fda.gov/drug/enforcement.json',
  device: 'https://api.fda.gov/device/recall.json',
  food: 'https://api.fda.gov/food/enforcement.json',
};

export interface FDASearchOptions {
  productDescription?: string;
  recallingFirm?: string;
  state?: string;
  classification?: 'Class I' | 'Class II' | 'Class III';
  categories?: FDAProductCategory[];
  limit?: number;
  skip?: number;
}

/**
 * openFDA API Client for drug, device, and food recall data
 */
const MAX_ATTEMPTS = Number(process.env.FDA_MAX_ATTEMPTS ?? 3);

/**
 * openFDA API key. Optional — without it the limit is 1,000 requests/day per IP,
 * and every attendee shares one NAT gateway address. With it, 120,000/day per key.
 *
 * `unset` is how Unify stores "not configured yet", since it will not save an empty
 * variable value. Treated as absent so the client falls back to unauthenticated
 * rather than sending the literal word as a key.
 */
const API_KEY =
  process.env.FDA_API_KEY && process.env.FDA_API_KEY !== 'unset'
    ? process.env.FDA_API_KEY
    : undefined;

/**
 * Thrown when openFDA rate limits us and retries did not clear it.
 *
 * Distinct from "no results" ON PURPOSE. Returning [] for a 429 makes a throttled
 * request indistinguishable from a genuine empty result, which reaches the user as
 * "no recalls found" — the most misleading failure this client can produce, and the
 * one that cost a morning of debugging when a different bug produced the same
 * symptom.
 */
export class FDARateLimitError extends Error {
  // Declared and assigned separately, not as constructor parameter properties:
  // those emit runtime code, which `erasableSyntaxOnly` forbids because Node's
  // native type stripping cannot execute them. tsc alone would have accepted the
  // shorter form and the failure would have appeared at boot.
  readonly category: string;
  readonly attempts: number;

  constructor(category: string, attempts: number) {
    super(`openFDA rate limited ${category} after ${attempts} attempts`);
    this.name = 'FDARateLimitError';
    this.category = category;
    this.attempts = attempts;
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * openFDA allows 240 requests/minute and 1,000/day per IP without a key, or
 * 120,000/day with one. Every attendee shares one NAT gateway address, so the
 * per-minute limit is the one a workshop hits — and it clears within the minute,
 * which makes it worth waiting out.
 *
 * Respects Retry-After when present, otherwise exponential backoff with jitter so
 * simultaneous attendees do not retry in lockstep.
 */
function retryDelayMs(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 65_000);
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), 65_000);
  }
  const base = 2_000 * Math.pow(4, attempt);   // 2s, 8s, 32s
  return Math.min(base, 32_000) + Math.floor(Math.random() * 1_000);
}

export class FDAClient {
  /**
   * Resolve product category strings to FDA endpoint categories
   */
  resolveCategories(productCategory?: string): FDAProductCategory[] {
    if (!productCategory) {
      return ['drug', 'device', 'food']; // Search all by default
    }

    const mapped = CATEGORY_TO_ENDPOINT[productCategory];
    if (mapped) return mapped;

    // Fallback: search all endpoints
    return ['drug', 'device', 'food'];
  }

  /**
   * Build an openFDA search query string from options
   * openFDA uses a specific query syntax: field:"value"+AND+field:"value"
   */
  private buildSearchQuery(options: FDASearchOptions, broad: boolean = false): string {
    const parts: string[] = [];

    if (options.productDescription && !broad) {
      parts.push(`product_description:"${options.productDescription}"`);
    }
    if (options.recallingFirm) {
      parts.push(`recalling_firm:"${options.recallingFirm}"`);
    }
    if (options.state && !broad) {
      parts.push(`state:"${options.state}"`);
    }
    if (options.classification) {
      parts.push(`classification:"${options.classification}"`);
    }

    // If no specific filters, return a broad search
    if (parts.length === 0) {
      return '';
    }

    return parts.join('+AND+');
  }

  /**
   * Search a single FDA endpoint
   */
  private async searchEndpoint(
    category: FDAProductCategory,
    options: FDASearchOptions
  ): Promise<FDARecallResult[]> {
    // A rate-limit error propagates: retrying broadly here would fire another
    // request into a limit openFDA has just reported.
    const results = await this.fetchEndpoint(category, options);

    // If narrow search returned nothing, retry with broad search (drop product description and state filters)
    if (results.length === 0 && (options.productDescription || options.state)) {
      console.log(`[FDA] Narrow search returned 0 results for ${category}, retrying with broad search...`);
      return this.fetchEndpoint(category, options, true);
    }

    return results;
  }

  private async fetchEndpoint(
    category: FDAProductCategory,
    options: FDASearchOptions,
    broad: boolean = false,
    attempt: number = 0
  ): Promise<FDARecallResult[]> {
    const baseUrl = FDA_ENDPOINTS[category];
    const searchQuery = this.buildSearchQuery(options, broad);
    const limit = options.limit || 20;
    const skip = options.skip || 0;

    // openFDA's docs specify api_key BEFORE other parameters such as search.
    const auth = API_KEY ? `api_key=${encodeURIComponent(API_KEY)}&` : '';
    let url = `${baseUrl}?${auth}limit=${limit}&skip=${skip}`;
    if (searchQuery) {
      url += `&search=${encodeURIComponent(searchQuery)}`;
    }

    // Log the URL WITHOUT the key. It was previously echoed whole, so adding an
    // api_key parameter would have written a credential into every pod log and
    // into the workflow output attendees can read.
    console.log(
      `[FDA] Searching ${category}${broad ? ' (broad)' : ''}: ` +
      url.replace(/api_key=[^&]*&?/, '') + (API_KEY ? ' (authenticated)' : '')
    );

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15000), // 15 second timeout
      });

      if (!response.ok) {
        // openFDA returns 404 when no results are found — a real answer.
        if (response.status === 404) {
          console.log(`[FDA] No results for ${category}${broad ? ' (broad)' : ''}`);
          return [];
        }

        // 429 is rate limiting, 5xx is usually transient. Both are worth waiting
        // out rather than reporting as "no recalls".
        if (response.status === 429 || response.status >= 500) {
          if (attempt < MAX_ATTEMPTS - 1) {
            const wait = retryDelayMs(response, attempt);
            console.warn(
              `[FDA] ${category} got ${response.status}; retrying in ` +
              `${Math.round(wait / 1000)}s (attempt ${attempt + 1}/${MAX_ATTEMPTS})`
            );
            await sleep(wait);
            return this.fetchEndpoint(category, options, broad, attempt + 1);
          }
          if (response.status === 429) {
            console.error(
              `[FDA] ${category} RATE LIMITED after ${MAX_ATTEMPTS} attempts. ` +
              `openFDA allows 1,000 requests/day per IP without an API key, and every ` +
              `attendee shares one NAT gateway address. Set FDA_API_KEY to raise that ` +
              `to 120,000/day.`
            );
            throw new FDARateLimitError(category, MAX_ATTEMPTS);
          }
        }

        console.warn(`[FDA] ${category} search failed: ${response.status}`);
        return [];
      }

      // Cast required: under the Node lib (this package is server-only)
      // Response.json() resolves to `unknown`, not `any` as it did under the DOM lib.
      const data = (await response.json()) as FDASearchResponse;

      // Tag each result with its product type
      const productTypeMap: Record<FDAProductCategory, FDARecallResult['product_type']> = {
        drug: 'Drug',
        device: 'Device',
        food: 'Food',
      };

      return (data.results || []).map(result => ({
        ...result,
        product_type: result.product_type || productTypeMap[category],
      }));
    } catch (error) {
      // Must propagate: swallowing this would turn a throttled request back
      // into a silent empty result, which is what this class exists to prevent.
      if (error instanceof FDARateLimitError) throw error;
      console.error(`[FDA] Error searching ${category}:`, error);
      return [];
    }
  }

  /**
   * Search across FDA enforcement endpoints
   * Queries all relevant endpoints (or specific ones based on product category)
   * and merges results
   */
  async search(options: FDASearchOptions = {}): Promise<FDARecallResult[]> {
    const categories = options.categories || ['drug', 'device', 'food'];

    // Query all relevant endpoints in parallel
    const promises = categories.map(category =>
      this.searchEndpoint(category, options)
    );

    // allSettled, not all: one rate-limited endpoint must not discard results
    // from the others, and the summary line has to distinguish "nothing matched"
    // from "we never got an answer".
    const settled = await Promise.allSettled(promises);
    const results = settled.map(r => (r.status === 'fulfilled' ? r.value : []));
    const throttled = settled.filter(
      r => r.status === 'rejected' && r.reason instanceof FDARateLimitError
    ).length;
    for (const r of settled) {
      if (r.status === 'rejected' && !(r.reason instanceof FDARateLimitError)) {
        console.error('[FDA] endpoint failed:', r.reason);
      }
    }

    // Flatten and deduplicate by recall_number
    const allResults: FDARecallResult[] = [];
    const seen = new Set<string>();

    for (const categoryResults of results) {
      for (const result of categoryResults) {
        // Every endpoint names its identifier differently. device/recall.json has
        // no recall_number and no event_id at all, so a key built from only
        // those two is undefined for every device record.
        const key = recallIdentifier(result);

        // A record with no recognisable identifier is KEPT, not dropped. The
        // previous `if (key && ...)` discarded it, turning an unrecognised ID
        // format into silent data loss that reached the user as "no recalls
        // found" with nothing logged. Losing a duplicate is a far smaller
        // problem than losing every result.
        if (!key) {
          allResults.push(result);
          continue;
        }
        if (!seen.has(key)) {
          seen.add(key);
          allResults.push(result);
        }
      }
    }

    if (throttled > 0) {
      console.error(
        `[FDA] ${throttled}/${categories.length} endpoint(s) were RATE LIMITED. ` +
        `Results below are incomplete — this is not "no recalls found".`
      );
    }
    console.log(
      `[FDA] Total results across ${categories.length} endpoints: ${allResults.length}` +
      (throttled > 0 ? ` (${throttled} rate limited)` : '')
    );
    return allResults;
  }

  /**
   * Search by product category string (maps to the correct endpoints)
   */
  async searchByCategory(
    productCategory: string,
    options: Omit<FDASearchOptions, 'categories'> = {}
  ): Promise<FDARecallResult[]> {
    const categories = this.resolveCategories(productCategory);
    return this.search({ ...options, categories });
  }
}

// Export singleton instance
export const fdaClient = new FDAClient();
