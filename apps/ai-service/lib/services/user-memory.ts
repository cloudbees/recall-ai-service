// User Intelligence Layer — per-user memory across conversations
// Stores facts the agent learns about a user, embedded for semantic recall

import db from '@recall/shared/db';
import type { MemoryCategory } from '@recall/shared/db';
import { embed, embedQuery, toVectorString } from '@recall/shared/services/embeddings';
import { sql } from 'kysely';

export interface SaveMemoryParams {
  userId: string;
  category: MemoryCategory;
  fact: string;
  source?: string;
  conversationId?: string;
  expiresAt?: Date;
}

export interface MemoryResult {
  id: string;
  category: MemoryCategory;
  fact: string;
  source: string;
  createdAt: Date;
  updatedAt: Date;
  distance?: number;
}

/**
 * Save a fact about a user. Upserts on (userId, md5(fact)) — duplicate facts
 * just refresh updatedAt. Embedding is generated fire-and-forget.
 */
export async function saveMemory(params: SaveMemoryParams): Promise<MemoryResult> {
  const { userId, category, fact, source = 'agent', conversationId, expiresAt } = params;

  const result = await sql<MemoryResult>`
    INSERT INTO user_memory ("userId", category, fact, source, "conversationId", "expiresAt")
    VALUES (${userId}::uuid, ${category}, ${fact}, ${source}, ${conversationId ?? null}, ${expiresAt?.toISOString() ?? null}::timestamptz)
    ON CONFLICT ("userId", md5(fact)) DO UPDATE SET
      "updatedAt" = NOW(),
      category = EXCLUDED.category,
      source = EXCLUDED.source,
      "conversationId" = COALESCE(EXCLUDED."conversationId", user_memory."conversationId")
    RETURNING id, category, fact, source, "createdAt", "updatedAt"
  `.execute(db);

  const memory = result.rows[0];
  console.log(`[UserMemory] Saved: [${category}] "${fact.substring(0, 80)}..." for user ${userId.substring(0, 8)}`);

  // Fire-and-forget: embed the fact for semantic recall
  embedMemory(memory.id, category, fact).catch(err =>
    console.error(`[UserMemory] Embedding failed for ${memory.id}:`, err)
  );

  return memory;
}

/**
 * Generate and store embedding for a memory fact.
 * Embeds "category: fact" combined for better domain-specific retrieval.
 */
async function embedMemory(memoryId: string, category: string, fact: string): Promise<void> {
  const textToEmbed = `${category}: ${fact}`;
  const embedding = await embed(textToEmbed);
  const vectorStr = toVectorString(embedding);

  await sql`
    UPDATE user_memory SET embedding = ${vectorStr}::vector WHERE id = ${memoryId}::uuid
  `.execute(db);
}

/**
 * Recall memories relevant to a query using cosine similarity.
 * Used for auto-recall at conversation start and explicit recall_memory tool.
 */
export async function recallMemory(
  userId: string,
  query: string,
  options?: { limit?: number; maxDistance?: number; category?: MemoryCategory }
): Promise<MemoryResult[]> {
  const { limit = 5, maxDistance = 0.45, category } = options || {};

  const queryEmbedding = await embedQuery(query);
  const vectorStr = toVectorString(queryEmbedding);

  let q = sql<MemoryResult & { distance: number }>`
    SELECT id, category, fact, source, "createdAt", "updatedAt",
           embedding <=> ${vectorStr}::vector AS distance
    FROM user_memory
    WHERE "userId" = ${userId}::uuid
      AND embedding IS NOT NULL
      AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
  `;

  if (category) {
    q = sql<MemoryResult & { distance: number }>`
      SELECT id, category, fact, source, "createdAt", "updatedAt",
             embedding <=> ${vectorStr}::vector AS distance
      FROM user_memory
      WHERE "userId" = ${userId}::uuid
        AND embedding IS NOT NULL
        AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
        AND category = ${category}
    `;
  }

  const result = await sql<MemoryResult & { distance: number }>`
    SELECT * FROM (${q}) sub
    WHERE distance < ${maxDistance}
    ORDER BY distance ASC
    LIMIT ${limit}
  `.execute(db);

  console.log(`[UserMemory] Recall for user ${userId.substring(0, 8)}: ${result.rows.length} memories (query: "${query.substring(0, 60)}")`);
  return result.rows;
}

/**
 * Format recalled memories for injection into the system prompt.
 * Returns empty string if no memories — keeps prompt clean.
 */
export function formatMemoriesForPrompt(memories: MemoryResult[]): string {
  if (memories.length === 0) return '';

  const lines = memories.map(m => `- [${m.category}] ${m.fact}`);
  return `## What I Remember About You\n${lines.join('\n')}\n`;
}

/**
 * List all non-expired memories for a user. For admin/debug use.
 */
export async function getUserMemories(
  userId: string,
  options?: { category?: MemoryCategory; limit?: number }
): Promise<MemoryResult[]> {
  const { category, limit = 50 } = options || {};

  let query = db
    .selectFrom('user_memory')
    .select(['id', 'category', 'fact', 'source', 'createdAt', 'updatedAt'])
    .where('userId', '=', userId)
    .where(eb => eb.or([
      eb('expiresAt', 'is', null),
      eb('expiresAt', '>', new Date()),
    ]))
    .orderBy('updatedAt', 'desc')
    .limit(limit);

  if (category) {
    query = query.where('category', '=', category);
  }

  return await query.execute();
}

/**
 * Delete a memory with ownership check.
 */
export async function deleteMemory(memoryId: string, userId: string): Promise<boolean> {
  const result = await db
    .deleteFrom('user_memory')
    .where('id', '=', memoryId)
    .where('userId', '=', userId)
    .executeTakeFirst();

  return Number(result.numDeletedRows ?? 0) > 0;
}
