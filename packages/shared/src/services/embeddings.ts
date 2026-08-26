// Voyage AI 3 embedding service for pgvector semantic search
// 1024 dimensions, cosine similarity, ~$0.06/1M tokens

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_MODEL = 'voyage-3';
const EMBEDDING_DIMENSIONS = 1024;
const MAX_BATCH_SIZE = 128; // Voyage AI max per request
const BATCH_DELAY_MS = 200; // Rate limiting between batches

function getApiKey(): string {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) {
    throw new Error('VOYAGE_API_KEY environment variable is not set');
  }
  return key;
}

interface VoyageResponse {
  data: Array<{ embedding: number[]; index: number }>;
  usage: { total_tokens: number };
}

/**
 * Call Voyage AI embeddings API
 */
async function callVoyageAPI(
  texts: string[],
  inputType: 'document' | 'query'
): Promise<number[][]> {
  const response = await fetch(VOYAGE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({
      model: VOYAGE_MODEL,
      input: texts,
      input_type: inputType,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Voyage AI API error: ${response.status} ${errorText}`);
  }

  // Cast required: this package compiles against the Node lib, where
  // Response.json() resolves to `unknown` rather than the DOM lib's `any`.
  const data = (await response.json()) as VoyageResponse;
  console.log(`[Voyage AI] Embedded ${texts.length} texts, ${data.usage.total_tokens} tokens`);

  // Sort by index to ensure order matches input
  return data.data
    .sort((a, b) => a.index - b.index)
    .map(d => d.embedding);
}

/**
 * Embed a single text as a document (for storage)
 */
export async function embed(text: string): Promise<number[]> {
  const results = await callVoyageAPI([text], 'document');
  return results[0];
}

/**
 * Embed a batch of texts as documents (for storage)
 * Auto-splits into chunks of MAX_BATCH_SIZE with rate limiting
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length <= MAX_BATCH_SIZE) {
    return callVoyageAPI(texts, 'document');
  }

  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);
    const embeddings = await callVoyageAPI(batch, 'document');
    allEmbeddings.push(...embeddings);

    // Rate limiting between batches
    if (i + MAX_BATCH_SIZE < texts.length) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  return allEmbeddings;
}

/**
 * Embed a query text (uses input_type: 'query' for better retrieval)
 */
export async function embedQuery(query: string): Promise<number[]> {
  const results = await callVoyageAPI([query], 'query');
  return results[0];
}

/**
 * Convert a number array to pgvector string format: '[0.1,0.2,0.3,...]'
 */
export function toVectorString(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

/**
 * Convert pgvector string format back to number array
 */
export function fromVectorString(vectorStr: string): number[] {
  // pgvector format: '[0.1,0.2,0.3,...]'
  const inner = vectorStr.replace(/^\[/, '').replace(/\]$/, '');
  return inner.split(',').map(Number);
}

export { EMBEDDING_DIMENSIONS };
