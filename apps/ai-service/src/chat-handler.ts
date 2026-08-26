// Recall Advisor chat handler.
//
// Moved from app/api/chat/route.ts in the monolith. Behaviour is preserved; the
// only structural change is that identity and company context now arrive from
// Core API over HTTP rather than being resolved from a session here.
//
// The recall.recallAdvisor gate lives in THIS service, not in Core API's proxy.
// That is deliberate: turning the flag off must darken the component that owns
// the capability. Core API must not duplicate or short-circuit the check.

import Rox from 'rox-node';
import { setFmCustomProperties } from '@recall/shared/fm';
import { opusClient } from '@recall/shared/ai/anthropic-client';
import type { AnthropicMessage } from '@recall/shared/ai/anthropic-client';
import db from '@recall/shared/db';
import { sql } from 'kysely';
import { getComplianceStats } from '@recall/shared/services/requirements';

import {
  createMessage,
  getConversationMessages,
  generateConversationId,
} from '../lib/services/chat.ts';
import { getToolDefinitions, createToolExecutor } from '../lib/services/agent-tools.ts';
import { recallMemory, formatMemoriesForPrompt } from '../lib/services/user-memory.ts';

/** Identity and company context resolved by Core API and forwarded here. */
export interface ChatContext {
  userId: string;
  email?: string;
  companyId: string;
  employeeCount?: number;
  naicsCode?: string;
  state?: string;
}

export interface ChatRequest {
  message: string;
  conversationId?: string;
  context: ChatContext;
}

export interface ChatResult {
  response: string;
  messageId: string;
  conversationId: string;
  toolsUsed: string[];
  model: string;
}

/** Caller-error; server.ts maps this to `status`. */
export class ChatError extends Error {
  // Declared explicitly rather than as a constructor parameter property:
  // parameter properties emit runtime code, so they are not erasable and Node's
  // type stripping rejects them. Enforced by erasableSyntaxOnly in tsconfig.
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function handleChat(req: ChatRequest): Promise<ChatResult> {
  const startTime = performance.now();
  const { context } = req;

  if (!context?.userId || !context?.companyId) {
    throw new ChatError('userId and companyId context are required', 400);
  }

  const companyId = context.companyId;

  // Set FM custom properties for targeting BEFORE flag evaluation, using the
  // context Core API forwarded.
  setFmCustomProperties({
    companyId,
    employeeCount: context.employeeCount,
    naicsCode: context.naicsCode,
    state: context.state,
    userId: context.userId,
    email: context.email,
    isLoggedIn: true,
  });

  // FM gate — recallAdvisor (Enterprise-targeted kill switch).
  // Owned by this service; see the note at the top of the file.
  if (!Rox.dynamicApi.isEnabled('recall.recallAdvisor', false)) {
    throw new ChatError('Recall Advisor is not enabled for your account', 403);
  }

  const message = req.message;
  if (!message || typeof message !== 'string' || !message.trim()) {
    throw new ChatError('Message is required', 400);
  }

  const conversationId = req.conversationId || generateConversationId();

  // Fetch company profile
  const company = await db
    .selectFrom('companies')
    .select(['companyName', 'naicsCode', 'state', 'employeeCount', 'website'])
    .where('id', '=', companyId)
    .executeTakeFirst();

  const stats = await getComplianceStats(companyId);

  // Upcoming deadlines (next 30 days)
  const today = new Date().toISOString().split('T')[0];
  const thirtyDays = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const deadlines = await db
    .selectFrom('requirements')
    .where('companyId', '=', companyId)
    .where('calendarTracking', '=', true)
    .where(sql`"dueDate"::text`, '>=', today)
    .where(sql`"dueDate"::text`, '<=', thirtyDays)
    .orderBy(sql`"dueDate"`, 'asc')
    .select(['citation', 'title', 'dueDate', 'status', 'frequency'])
    .execute();

  // Auto-recall user memories
  let memorySection = '';
  try {
    const memories = await recallMemory(context.userId, message.trim(), {
      limit: 5,
      maxDistance: 0.45,
    });
    memorySection = formatMemoriesForPrompt(memories);
  } catch (error) {
    console.error('[ai-service] Memory recall error (non-fatal):', error);
  }

  const deadlinesList = deadlines.length > 0
    ? deadlines.map(d => `- ${d.citation}: ${d.title} \u2014 due ${d.dueDate} (${d.status || 'pending'}, ${d.frequency || 'one-time'})`).join('\n')
    : 'No deadlines in the next 30 days.';

  // Count by agency
  const agencyCounts = await db
    .selectFrom('requirements')
    .select([
      'agency',
      sql<number>`COUNT(*)::int`.as('count'),
    ])
    .where('companyId', '=', companyId)
    .groupBy('agency')
    .execute();

  const agencyMap: Record<string, number> = {};
  for (const row of agencyCounts) {
    agencyMap[row.agency] = row.count;
  }

  const sessionEmail = context.email;

  const systemPrompt = `You are the Recall Advisor for the Product Recall Tracker — a web application that helps companies discover and manage product recalls from the FDA and CPSC that affect their supply chain.

You are serving ${sessionEmail || 'a product safety manager'} at ${company?.companyName || 'their company'}.

Company Profile:
- Product Category: ${company?.naicsCode || 'Unknown'}
- State: ${company?.state || 'Unknown'}
- Employees: ${company?.employeeCount || 'Unknown'}
- Website: ${company?.website || 'N/A'}

${memorySection}Recall Summary:
- ${stats.total} recalls across ${Object.keys(agencyMap).length} agencies (${agencyMap['FDA'] || 0} FDA, ${agencyMap['CPSC'] || 0} CPSC)
- Response rate: ${stats.complianceRate}%
- ${stats.nonCompliant} unresolved, ${stats.pending} pending review

Response Deadlines (next 30 days):
${deadlinesList}

## Verification Protocol — FOLLOW THIS

Classify every question by stakes level and act accordingly:

**HIGH-STAKES** (specific recall details, response deadlines, consumer notification requirements, affected product lot numbers, health/safety risk levels, any data the user might act on):
→ ALWAYS use tools FIRST. Do NOT answer from training alone.
→ Search the user's data (search_recalls) → verify against full details (get_recall or fetch_fda) → cite the specific recall number and classification.
→ For recall trend questions, call check_recent_recalls for real data.
→ For state-specific requirements, call web_search to find state consumer protection requirements.

**MEDIUM-STAKES** (general product safety questions, "tell me about...", process explanations):
→ Use tools when the user's tracked recalls or specific recall numbers are relevant.
→ Cross-reference your answer with search_recalls to surface the user's specific tracked recalls.

**LOW-STAKES** (greetings, definitions of common terms, general product safety concepts):
→ Training data is fine. No tools needed.

## Absolute Rules — NEVER VIOLATE

1. NEVER fabricate a recall number, classification, affected product list, deadline, or health risk assessment. If you haven't seen it in tool output, say "I'd need to verify that."
2. NEVER invent recalls that don't exist. If search_recalls returns nothing, say so.
3. When citing a specific recall (e.g., F-1234-2026), you MUST have seen that recall in tool output from this conversation.
4. If you're uncertain about a recall detail, classification, or deadline — say so and offer to look it up. Never guess.

## Tool-Specific Guidance

**check_recent_recalls**: Use when discussing recall trends, recent activity, or "what recalls have been issued recently." Returns real FDA and CPSC recall data for the user's product categories.

**web_search**: Use for state-specific consumer protection requirements, recent recall announcements, enforcement actions, or anything not in the FDA/CPSC databases. The user is in ${company?.state || 'Unknown'} — include state name in search queries for state-specific questions.

**create_recall**: Adds a recall to the user's tracking dashboard. CRITICAL RULES:
- NEVER call this without explicit user authorization. Always RECOMMEND first, explain why it's relevant to their supply chain, then ask "Would you like me to add this to your dashboard?"
- Only call after the user says "yes", "add it", "go ahead", "create it", or similar explicit approval.
- Provide clear reasoning that references the user's specific situation (products, suppliers, distribution channels discussed).
- If you identify multiple relevant recalls, list them all and ask which ones to add — don't create them one by one without permission.

**generate_document**: Generates and saves a recall response document (notification letter, corrective action plan, audit checklist) to the user's document library. CRITICAL RULES:
- When the user asks you to CREATE, GENERATE, WRITE, or DRAFT a document (notification, response plan, checklist, report, template), you MUST call this tool to SAVE it. Do NOT write the full document content in your chat response — put it in the tool's "content" parameter so it gets persisted to the document library.
- If the user hasn't explicitly asked for a document but you think one would help, RECOMMEND it first and describe what it would cover. Create only after they agree.
- Write COMPLETE, professional documents in the "content" field — not outlines or stubs. These are real recall response documents the user will rely on.
- Include company-specific details from the conversation (company name, products, suppliers, distribution channels discussed).
- Link to the relevant recall via requirementCitation so the document is connected to the right recall in the dashboard.
- Format the "content" in clear markdown with headers, numbered steps, tables, and checklists as appropriate.
- After calling the tool successfully, tell the user the document was saved and give a brief summary of what it contains. Do NOT repeat the full document in chat — it's already saved.

**save_memory**: Save facts about this user for future conversations. USE when the user reveals:
supply chain details, product lines, distribution channels, supplier relationships, past recall incidents, team members, processes, preferences.
Do NOT save trivial conversation details. Write in second person ("You have...", "Your company..."). Be specific (1-2 sentences).

**recall_memory**: Search memory for facts about this user. Auto-recalled memories are
already in your prompt above. Use this for explicit lookups on topics not covered.

**search_conversations**: Search this user's past conversations. Use when they reference
something from a prior chat or you want to check conversation history.

## Structured Output Templates

When the user's question matches a template pattern, produce structured output using the indicated format. Populate with REAL data from tools — do not fill templates with placeholder text.

**Recall Response Procedure** — Trigger: recall, contamination, defect, "what do I do"
Format: Immediate Actions (numbered) → Affected Products (from search_recalls/fetch_fda) → Reporting Deadlines (specific hours/days) → Consumer Notification Checklist
Tools: search_recalls, fetch_fda, web_search (for state reporting)

**Customer Notification Plan** — Trigger: notification, customer, communication
Format: Notification Channels → Message Templates → Timeline → Affected Customer Segments → Follow-Up Actions
Tools: search_recalls, get_recall

**Corrective Action Plan** — Trigger: corrective action, remedy, refund, replacement
Format: Recall Details → Root Cause Categories → Corrective Actions (table: action | responsible | deadline) → Verification Steps → Remedy Documentation
Tools: get_recall, fetch_fda

**Supply Chain Audit Checklist** — Trigger: audit, supplier, verification
Format: Supplier Assessment Criteria (table: check item | standard | frequency | responsible) → Documentation Requirements → Risk Scoring
Tools: search_recalls (query: relevant product/supplier terms)

**Recall Coverage Analysis** — Trigger: coverage, "what are we missing", overall status
Format: Summary Statistics → Unresolved Recalls (table with status) → Pending Reviews → Priority Actions → Recommended Next Steps
Tools: search_recalls

Adapt these templates to the situation — they are guidance, not rigid schemas. If a question partially matches, use relevant sections.

## General Response Guidelines

- Cite specific recall numbers and classifications when referencing recalls.
- Keep answers practical and actionable, not academic.
- When referencing tracked recalls, note their response status (pending, in_progress, resolved, unresolved).
- Format for readability — use lists, headers, tables, and checklists.
- Responses may be copied to email or messenger. Keep them clean and self-contained.`;

  // Conversation history
  const history = await getConversationMessages(conversationId, 20);
  const historyMessages: AnthropicMessage[] = history.map(msg => ({
    role: msg.role === 'USER' ? 'user' : 'assistant',
    content: msg.content,
  }));

  const messages: AnthropicMessage[] = [
    ...historyMessages,
    { role: 'user', content: message.trim() },
  ];

  // Save user message
  await createMessage({
    userId: context.userId,
    companyId,
    conversationId,
    role: 'USER',
    content: message.trim(),
  });

  // Call Opus with tools
  const tools = getToolDefinitions();
  const toolExecutor = createToolExecutor(companyId, {
    naicsCode: company?.naicsCode || undefined,
    state: company?.state || undefined,
    userId: context.userId,
    conversationId,
  });

  const result = await opusClient.sendMessageWithTools(messages, tools, toolExecutor, {
    system: systemPrompt,
    maxTokens: 4096,
    temperature: 0.3,
    maxToolRounds: 5,
  });

  const latencyMs = Math.round(performance.now() - startTime);

  // Save assistant response
  const toolsUsed = result.toolCalls.map(tc => tc.tool);
  const assistantMsg = await createMessage({
    userId: context.userId,
    companyId,
    conversationId,
    role: 'ASSISTANT',
    content: result.content,
    toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
    model: result.model,
    tokenUsage: result.usage,
    latencyMs,
  });

  console.log(`[ai-service] ${sessionEmail} | ${conversationId} | ${result.model} | ${result.usage.inputTokens}in/${result.usage.outputTokens}out | ${latencyMs}ms | tools: ${toolsUsed.join(', ') || 'none'}`);

  return {
    response: result.content,
    messageId: assistantMsg.id,
    conversationId,
    toolsUsed: [...new Set(toolsUsed)],
    model: result.model,
  };
}
