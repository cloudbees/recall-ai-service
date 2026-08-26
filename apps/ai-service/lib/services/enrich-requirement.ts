// Single-requirement enrichment pipeline
// Runs the same 3-call Opus analysis as the discovery pipeline, but for one recall.
// Used when the recall advisor creates a recall — enriches it from stub to full.

import { opusClient } from '@recall/shared/ai/anthropic-client';
import { fdaClient } from '@recall/shared/recall/fda-client';
import { embedRequirement } from '@recall/shared/services/requirements';
import db from '@recall/shared/db';
import { sql } from 'kysely';

interface CompanyProfile {
  companyName: string;
  naicsCode: string;
  state: string | null;
  employeeCount: number | null;
  websiteAnalysis: {
    products?: string[];
    services?: string[];
    activities?: string[];
    potentialHazards?: string[];
    industryKeywords?: string[];
  } | null;
}

/**
 * Enrich a single requirement with the full Opus analysis pipeline.
 *
 * Three Claude calls:
 * 1. UNDERSTAND — Extract scope, applicability, key requirements, exemptions, thresholds
 * 2. SCORE — Score against company profile (confidence, appliesTo, triggers, reasoning)
 * 3. EXTRACT OBLIGATIONS — Extract time-based/frequency-based obligations with subsections
 *
 * Then updates the requirement in the database and re-embeds.
 */
export async function enrichRequirement(requirementId: string): Promise<void> {
  const startTime = performance.now();

  // Load the requirement
  const requirement = await db
    .selectFrom('requirements')
    .selectAll()
    .where('id', '=', requirementId)
    .executeTakeFirst();

  if (!requirement) {
    console.error(`[Enrich] Requirement ${requirementId} not found`);
    return;
  }

  console.log(`[Enrich] Starting enrichment for ${requirement.citation} — ${requirement.title}`);

  // Load company profile
  const company = await db
    .selectFrom('companies')
    .select(['companyName', 'naicsCode', 'state', 'employeeCount', 'websiteAnalysis'])
    .where('id', '=', requirement.companyId)
    .executeTakeFirst();

  if (!company) {
    console.error(`[Enrich] Company ${requirement.companyId} not found`);
    return;
  }

  const profile: CompanyProfile = {
    companyName: company.companyName,
    naicsCode: company.naicsCode,
    state: company.state,
    employeeCount: company.employeeCount,
    websiteAnalysis: company.websiteAnalysis
      ? (typeof company.websiteAnalysis === 'string'
          ? JSON.parse(company.websiteAnalysis)
          : company.websiteAnalysis) as CompanyProfile['websiteAnalysis']
      : null,
  };

  // Step 1: Fetch recall details from FDA using the recall number (stored in citation field)
  let recallText: string | null = null;

  try {
    const fdaResults = await fdaClient.search({
      productDescription: requirement.citation,
      limit: 5,
    });

    // Try to find an exact match by recall number
    const match = fdaResults.find(r =>
      r.recall_number?.toLowerCase() === requirement.citation.toLowerCase() ||
      r.event_id?.toLowerCase() === requirement.citation.toLowerCase()
    );

    if (match) {
      recallText = [
        `Recall Number: ${match.recall_number}`,
        `Status: ${match.status}`,
        `Classification: ${match.classification}`,
        `Product Type: ${match.product_type}`,
        `Recalling Firm: ${match.recalling_firm}`,
        `City/State: ${match.city}, ${match.state}`,
        `Report Date: ${match.report_date}`,
        `Initiation Date: ${match.recall_initiation_date}`,
        `Voluntary/Mandated: ${match.voluntary_mandated}`,
        match.termination_date ? `Termination Date: ${match.termination_date}` : '',
        `Product Description: ${match.product_description}`,
        `Reason for Recall: ${match.reason_for_recall}`,
        `Distribution Pattern: ${match.distribution_pattern}`,
        `Product Quantity: ${match.product_quantity}`,
      ].filter(Boolean).join('\n');
      console.log(`[Enrich] Fetched FDA recall data for ${requirement.citation}`);
    } else if (fdaResults.length > 0) {
      // Use first result as best match
      const first = fdaResults[0];
      recallText = [
        `Recall Number: ${first.recall_number}`,
        `Status: ${first.status}`,
        `Classification: ${first.classification}`,
        `Product Type: ${first.product_type}`,
        `Recalling Firm: ${first.recalling_firm}`,
        `Product Description: ${first.product_description}`,
        `Reason for Recall: ${first.reason_for_recall}`,
        `Distribution Pattern: ${first.distribution_pattern}`,
      ].join('\n');
      console.log(`[Enrich] Using closest FDA match for ${requirement.citation}`);
    }
  } catch (err) {
    console.warn(`[Enrich] FDA fetch failed for ${requirement.citation}:`, err);
  }

  if (!recallText || recallText.length < 50) {
    console.warn(`[Enrich] No recall data available for ${requirement.citation}, skipping enrichment`);
    return;
  }

  // Build company context strings
  const wa = profile.websiteAnalysis;
  const products = [...(wa?.products || []), ...(wa?.services || [])];
  const activities = wa?.activities || [];
  const hazards = wa?.potentialHazards || [];
  const keywords = wa?.industryKeywords || [];
  const productCategory = profile.naicsCode || 'Unknown';

  try {
    // =========================================================================
    // Call 1: UNDERSTAND the recall
    // =========================================================================
    const understandPrompt = `You are an expert product safety consultant.

Analyze the following product recall and extract key information about its scope and impact.

RECALL: ${requirement.citation} - ${requirement.title}

FULL RECALL DETAILS:
${recallText}

Analyze this recall and extract:
1. SCOPE: What products are affected by this recall?
2. WHO IT APPLIES TO: What types of companies in the supply chain are affected (manufacturers, distributors, retailers)?
3. KEY REQUIREMENTS: What are the main response actions required?
4. EXEMPTIONS: Are any product variants or lot numbers excluded?
5. THRESHOLDS: Any quantities, date ranges, or distribution regions that define the recall scope?

Be precise - use specific details from the recall data where possible.

Respond in JSON format:
{
  "scope": "Brief description of what products/lots this recall covers",
  "whoItAppliesTo": "Specific description of affected companies in the supply chain",
  "keyRequirements": ["Action item 1", "Action item 2", ...],
  "exemptions": ["Exemption 1", "Exemption 2", ...],
  "thresholds": ["Scope detail 1", "Scope detail 2", ...]
}`;

    const understandResponse = await opusClient.ask(understandPrompt, {
      maxTokens: 2000,
      temperature: 0.1,
    });

    let regulationSummary: {
      scope: string;
      whoItAppliesTo: string;
      keyRequirements: string[];
      exemptions: string[];
      thresholds: string[];
    } | null = null;

    try {
      const jsonMatch = understandResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        regulationSummary = JSON.parse(jsonMatch[0]);
      }
    } catch {
      console.warn(`[Enrich] Failed to parse understanding for ${requirement.citation}`);
    }

    // =========================================================================
    // Call 2: SCORE relevance to company
    // =========================================================================
    const companyContextStr = `
COMPANY INFORMATION:
- Company Name: ${profile.companyName}
- Products/Services: ${products.join(', ') || 'Unknown'}
- Activities: ${activities.join(', ') || 'Unknown'}
- Identified Hazards: ${hazards.join(', ') || 'Unknown'}
- Industry Keywords: ${keywords.join(', ') || 'Unknown'}
- Employee Count: ${profile.employeeCount || 'Unknown'}
- State: ${profile.state || 'Unknown'}`;

    const scorePrompt = `You are an expert product safety consultant determining how relevant a product recall is to a specific company's supply chain.

RECALL: ${requirement.citation} - ${requirement.title}

RECALL SUMMARY:
${regulationSummary ? `
- Scope: ${regulationSummary.scope}
- Applies To: ${regulationSummary.whoItAppliesTo}
- Key Actions: ${regulationSummary.keyRequirements?.join('; ') || 'N/A'}
- Exemptions: ${regulationSummary.exemptions?.join('; ') || 'None listed'}
- Scope Details: ${regulationSummary.thresholds?.join('; ') || 'None listed'}
` : `Title: ${requirement.title}`}

PRODUCT CATEGORY: ${productCategory}
${companyContextStr}

TASK: Determine how relevant this recall is to this company based on their products, supply chain role, and distribution region.

SCORING GUIDELINES:
- 90-100: Recall directly affects this company's products or suppliers
- 70-89: Recall likely affects this company, strong product/supplier overlap
- 50-69: Recall may affect this company, some product category overlap
- 30-49: Recall might affect this company under certain conditions
- 10-29: Recall unlikely to affect this company, minimal overlap
- 0-9: Recall does not affect this type of company

Consider:
1. Does the company's product category match the recalled products?
2. Is the company in the recall's distribution region?
3. Could the company be a distributor or retailer of the recalled product?
4. Does the company use the recalled product as a component or input?

Be rigorous and evidence-based. If unsure, score lower.

Respond in JSON:
{
  "confidence": 0-100,
  "appliesTo": "Explanation of why this recall is or isn't relevant to this company",
  "triggers": ["Relevance factor 1", "Relevance factor 2", ...],
  "reasoning": "Your step-by-step reasoning for this score"
}`;

    const scoreResponse = await opusClient.ask(scorePrompt, {
      maxTokens: 1500,
      temperature: 0.1,
    });

    let confidence = requirement.confidence || 85;
    let appliesTo = requirement.appliesTo || '';
    let triggers: string[] = [];
    let reasoning = requirement.reasoning || '';

    try {
      const jsonMatch = scoreResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const score = JSON.parse(jsonMatch[0]);
        confidence = score.confidence;
        appliesTo = score.appliesTo;
        triggers = score.triggers || [];
        reasoning = score.reasoning;
      }
    } catch {
      console.warn(`[Enrich] Failed to parse score for ${requirement.citation}`);
    }

    // =========================================================================
    // Call 3: EXTRACT response actions (if confidence >= 30)
    // =========================================================================
    let possibleObligations: {
      description: string;
      frequency: string;
      condition: string;
      citationSubsection: string;
    }[] = [];

    if (confidence >= 30) {
      try {
        const obligationsPrompt = `You are a product safety expert. You have already determined that this recall is relevant to the company. Now extract all required response actions from the recall data.

RECALL: ${requirement.citation} - ${requirement.title}

RECALL DATA:
${recallText}

For each required action, extract:
- description: What must be done (e.g., "Remove affected products from shelves", "Notify customers who purchased the product")
- frequency: Timeline or deadline ("immediately", "within 24 hours", "within 30 days", "ongoing until resolved", etc.)
- condition: Under what specific circumstances this action applies. Be precise about scope (e.g., "Only for products with lot numbers 2024A-2024F", "Only for retailers in affected distribution area")
- citationSubsection: The type of action (e.g., "consumer notification", "product removal", "reporting", "remedy fulfillment")

Include actions for:
1. Consumer notification requirements
2. Product removal/quarantine timelines
3. Reporting requirements to the agency
4. Remedy procedures (refund, replacement, repair)
5. Documentation and record-keeping

If no specific actions can be determined, return an empty array.

Respond in JSON: { "possibleObligations": [...] }`;

        const obligationsResponse = await opusClient.ask(obligationsPrompt, {
          maxTokens: 2000,
          temperature: 0.1,
        });

        const oblMatch = obligationsResponse.match(/\{[\s\S]*\}/);
        if (oblMatch) {
          const parsed = JSON.parse(oblMatch[0]);
          possibleObligations = parsed.possibleObligations || [];
        }
      } catch {
        console.warn(`[Enrich] Failed to extract actions for ${requirement.citation}`);
      }
    }

    // =========================================================================
    // Update the requirement with all enriched data
    // =========================================================================
    await db
      .updateTable('requirements')
      .set({
        fullText: recallText,
        regulationSummary: regulationSummary ? JSON.stringify(regulationSummary) : undefined,
        confidence,
        appliesTo,
        triggers: JSON.stringify(triggers),
        reasoning,
        possibleObligations: JSON.stringify(possibleObligations),
        source: 'recall_advisor',
      })
      .where('id', '=', requirementId)
      .execute();

    // Re-embed with the enriched data
    const updated = await db
      .selectFrom('requirements')
      .selectAll()
      .where('id', '=', requirementId)
      .executeTakeFirstOrThrow();

    await embedRequirement(updated);

    const elapsed = Math.round(performance.now() - startTime);
    console.log(`[Enrich] Completed ${requirement.citation}: relevance=${confidence}%, actions=${possibleObligations.length}, ${elapsed}ms`);

  } catch (error) {
    console.error(`[Enrich] Error enriching ${requirement.citation}:`, error);
  }
}
