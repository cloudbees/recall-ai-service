// Chat message service — CRUD for chat_messages table

import db from '@recall/shared/db';
import type { MessageRole } from '@recall/shared/db';
import crypto from 'crypto';

export interface CreateMessageParams {
  userId: string;
  companyId: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  toolCalls?: unknown;
  citedRegulations?: unknown;
  citedDocuments?: unknown;
  model?: string;
  tokenUsage?: { inputTokens: number; outputTokens: number };
  latencyMs?: number;
}

export interface ChatMessage {
  id: string;
  userId: string;
  companyId: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  toolCalls: unknown | null;
  citedRegulations: unknown | null;
  citedDocuments: unknown | null;
  model: string | null;
  tokenUsage: unknown | null;
  latencyMs: number | null;
  createdAt: Date;
}

/**
 * Insert a chat message into chat_messages table
 */
export async function createMessage(params: CreateMessageParams): Promise<ChatMessage> {
  const result = await db
    .insertInto('chat_messages')
    .values({
      userId: params.userId,
      companyId: params.companyId,
      conversationId: params.conversationId,
      role: params.role,
      content: params.content,
      toolCalls: params.toolCalls ? JSON.stringify(params.toolCalls) : null,
      citedRegulations: params.citedRegulations ? JSON.stringify(params.citedRegulations) : null,
      citedDocuments: params.citedDocuments ? JSON.stringify(params.citedDocuments) : null,
      model: params.model || null,
      tokenUsage: params.tokenUsage ? JSON.stringify(params.tokenUsage) : null,
      latencyMs: params.latencyMs || null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  return result as unknown as ChatMessage;
}

/**
 * Get messages for a conversation, ordered by createdAt ASC (oldest first)
 */
export async function getConversationMessages(
  conversationId: string,
  limit = 20
): Promise<ChatMessage[]> {
  const results = await db
    .selectFrom('chat_messages')
    .selectAll()
    .where('conversationId', '=', conversationId)
    .orderBy('createdAt', 'asc')
    .limit(limit)
    .execute();

  return results as unknown as ChatMessage[];
}

/**
 * Get recent conversations for a user/company with last message preview
 */
export async function getRecentConversations(
  companyId: string,
  userId: string,
  limit = 10
): Promise<{ conversationId: string; lastMessage: string; lastAt: Date }[]> {
  const results = await db
    .selectFrom('chat_messages')
    .select([
      'conversationId',
      'content',
      'createdAt',
    ])
    .where('companyId', '=', companyId)
    .where('userId', '=', userId)
    .where('conversationId', 'is not', null)
    .orderBy('createdAt', 'desc')
    .limit(limit * 2) // Fetch extra to deduplicate
    .execute();

  // Deduplicate by conversationId, keeping the latest message
  const seen = new Map<string, { conversationId: string; lastMessage: string; lastAt: Date }>();
  for (const row of results) {
    if (row.conversationId && !seen.has(row.conversationId)) {
      seen.set(row.conversationId, {
        conversationId: row.conversationId,
        lastMessage: row.content.substring(0, 100),
        lastAt: row.createdAt,
      });
    }
    if (seen.size >= limit) break;
  }

  return Array.from(seen.values());
}

/**
 * Generate a new conversation ID
 */
export function generateConversationId(): string {
  return crypto.randomUUID();
}
