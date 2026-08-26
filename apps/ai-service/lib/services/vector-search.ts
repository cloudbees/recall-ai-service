// Vector search service — pgvector cosine similarity queries
// All queries filter by companyId before vector scan (multi-tenant isolation)

import db from '@recall/shared/db';
import { sql } from 'kysely';
import { embedQuery, toVectorString } from '@recall/shared/services/embeddings';

export interface RegulationSearchResult {
  id: string;
  citation: string;
  title: string;
  agency: string;
  regulationSummary: unknown;
  distance: number;
}

export interface ObligationSearchResult {
  id: string;
  requirementId: string;
  citation: string;
  title: string;
  agency: string;
  obligationText: string;
  distance: number;
}

export interface DocumentSearchResult {
  id: string;
  documentId: string;
  filename: string;
  chunkText: string;
  chunkIndex: number;
  distance: number;
}

export interface SearchAllOptions {
  regulationLimit?: number;
  obligationLimit?: number;
  documentLimit?: number;
}

export interface SearchAllResult {
  regulations: RegulationSearchResult[];
  obligations: ObligationSearchResult[];
  documents: DocumentSearchResult[];
}

/**
 * Layer 1: Search regulation summaries
 */
export async function searchRegulations(
  query: string,
  companyId: string,
  limit = 10
): Promise<RegulationSearchResult[]> {
  const queryEmbedding = await embedQuery(query);
  const vectorStr = toVectorString(queryEmbedding);

  const results = await sql<RegulationSearchResult>`
    SELECT
      id,
      citation,
      title,
      agency,
      "regulationSummary",
      embedding <=> ${vectorStr}::vector AS distance
    FROM requirements
    WHERE "companyId" = ${companyId}
      AND embedding IS NOT NULL
    ORDER BY distance ASC
    LIMIT ${limit}
  `.execute(db);

  return results.rows;
}

/**
 * Layer 2: Search individual obligations (joins to requirements for citation)
 */
export async function searchObligations(
  query: string,
  companyId: string,
  limit = 10
): Promise<ObligationSearchResult[]> {
  const queryEmbedding = await embedQuery(query);
  const vectorStr = toVectorString(queryEmbedding);

  const results = await sql<ObligationSearchResult>`
    SELECT
      oe.id,
      oe."requirementId",
      r.citation,
      r.title,
      r.agency,
      oe."obligationText",
      oe.embedding <=> ${vectorStr}::vector AS distance
    FROM obligation_embeddings oe
    JOIN requirements r ON r.id = oe."requirementId"
    WHERE oe."companyId" = ${companyId}
      AND oe.embedding IS NOT NULL
    ORDER BY distance ASC
    LIMIT ${limit}
  `.execute(db);

  return results.rows;
}

/**
 * Layer 3: Search document chunks (joins to documents for filename)
 */
export async function searchDocuments(
  query: string,
  companyId: string,
  limit = 10
): Promise<DocumentSearchResult[]> {
  const queryEmbedding = await embedQuery(query);
  const vectorStr = toVectorString(queryEmbedding);

  // Search both document chunks and document-level embeddings
  const results = await sql<DocumentSearchResult>`
    (
      SELECT
        dc.id,
        dc."documentId",
        d.filename,
        dc."chunkText",
        dc."chunkIndex",
        dc.embedding <=> ${vectorStr}::vector AS distance
      FROM document_chunks dc
      JOIN documents d ON d.id = dc."documentId"
      WHERE dc."companyId" = ${companyId}
        AND dc.embedding IS NOT NULL
    )
    UNION ALL
    (
      SELECT
        d.id,
        d.id AS "documentId",
        d.filename,
        LEFT(d."extractedText", 2000) AS "chunkText",
        0 AS "chunkIndex",
        d.embedding <=> ${vectorStr}::vector AS distance
      FROM documents d
      WHERE d."companyId" = ${companyId}
        AND d.embedding IS NOT NULL
    )
    ORDER BY distance ASC
    LIMIT ${limit}
  `.execute(db);

  return results.rows;
}

/**
 * Combined search: embeds query ONCE, runs all three layers in parallel
 */
export async function searchAll(
  query: string,
  companyId: string,
  options?: SearchAllOptions
): Promise<SearchAllResult> {
  const queryEmbedding = await embedQuery(query);
  const vectorStr = toVectorString(queryEmbedding);

  const regLimit = options?.regulationLimit ?? 10;
  const oblLimit = options?.obligationLimit ?? 10;
  const docLimit = options?.documentLimit ?? 10;

  // Run all three searches in parallel with pre-computed embedding
  const [regulations, obligations, documents] = await Promise.all([
    sql<RegulationSearchResult>`
      SELECT
        id, citation, title, agency, "regulationSummary",
        embedding <=> ${vectorStr}::vector AS distance
      FROM requirements
      WHERE "companyId" = ${companyId} AND embedding IS NOT NULL
      ORDER BY distance ASC
      LIMIT ${regLimit}
    `.execute(db).then(r => r.rows),

    sql<ObligationSearchResult>`
      SELECT
        oe.id, oe."requirementId", r.citation, r.title, r.agency,
        oe."obligationText",
        oe.embedding <=> ${vectorStr}::vector AS distance
      FROM obligation_embeddings oe
      JOIN requirements r ON r.id = oe."requirementId"
      WHERE oe."companyId" = ${companyId} AND oe.embedding IS NOT NULL
      ORDER BY distance ASC
      LIMIT ${oblLimit}
    `.execute(db).then(r => r.rows),

    sql<DocumentSearchResult>`
      (
        SELECT
          dc.id, dc."documentId", d.filename, dc."chunkText", dc."chunkIndex",
          dc.embedding <=> ${vectorStr}::vector AS distance
        FROM document_chunks dc
        JOIN documents d ON d.id = dc."documentId"
        WHERE dc."companyId" = ${companyId} AND dc.embedding IS NOT NULL
      )
      UNION ALL
      (
        SELECT
          d.id, d.id AS "documentId", d.filename,
          LEFT(d."extractedText", 2000) AS "chunkText", 0 AS "chunkIndex",
          d.embedding <=> ${vectorStr}::vector AS distance
        FROM documents d
        WHERE d."companyId" = ${companyId} AND d.embedding IS NOT NULL
      )
      ORDER BY distance ASC
      LIMIT ${docLimit}
    `.execute(db).then(r => r.rows),
  ]);

  return { regulations, obligations, documents };
}
