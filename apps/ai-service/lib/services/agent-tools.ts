// Agent tools for the Recall Advisor (Opus 4.6 with tool_use)
// Defines tool schemas + executor function with companyId closure for multi-tenant isolation

import type { AnthropicTool } from '@recall/shared/ai/anthropic-client';
import { searchAll, searchDocuments } from './vector-search.ts';
import { fdaClient } from '@recall/shared/recall/fda-client';
import { createRequirement } from '@recall/shared/services/requirements';
import { createDocument, embedDocument } from '@recall/shared/services/documents';
import { enrichRequirement } from './enrich-requirement.ts';
import { saveMemory, recallMemory } from './user-memory.ts';
import type { MemoryCategory } from '@recall/shared/db';
import db from '@recall/shared/db';
import { sql } from 'kysely';

/**
 * Get the tool definitions for the Anthropic API
 */
export function getToolDefinitions(): AnthropicTool[] {
  return [
    {
      name: 'search_recalls',
      description:
        "Search the user's discovered recalls and response actions using semantic similarity. Use when the user asks about recalls, affected products, or response obligations.",
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query describing what recalls or response actions to find',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_recall',
      description:
        "Retrieve the full details of a specific recall by its recall number. Use when you need the complete recall information to answer a detailed question.",
      input_schema: {
        type: 'object',
        properties: {
          recallNumber: {
            type: 'string',
            description: 'The recall number (e.g., "F-1234-2026", "D-0567-2025")',
          },
        },
        required: ['recallNumber'],
      },
    },
    {
      name: 'search_documents',
      description:
        "Search the user's uploaded documents (response plans, audit checklists, notification letters, etc.) using semantic similarity.",
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query describing what document content to find',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'fetch_fda',
      description:
        'Fetch current recall data from the official FDA database. Use when you need to verify a recall or get the latest information about a specific recall number.',
      input_schema: {
        type: 'object',
        properties: {
          recallNumber: {
            type: 'string',
            description: 'The recall number to look up (e.g., "F-1234-2026")',
          },
        },
        required: ['recallNumber'],
      },
    },
    {
      name: 'check_recent_recalls',
      description:
        'Get recent FDA and CPSC recall data for a product category. Use when discussing recall trends or recent activity for the user\'s product categories.',
      input_schema: {
        type: 'object',
        properties: {
          productCategory: {
            type: 'string',
            description: 'The product category to search for recent recalls (e.g., "Food & Beverages", "Medical Devices", "Drugs & Pharmaceuticals")',
          },
        },
        required: [],
      },
    },
    {
      name: 'create_recall',
      description:
        "Add a recall to the user's tracking dashboard. Use ONLY when the user explicitly authorizes it (e.g., 'yes add that', 'go ahead', 'create it'). Always recommend first, then create only with permission.",
      input_schema: {
        type: 'object',
        properties: {
          recallNumber: {
            type: 'string',
            description: 'The recall number (e.g., "F-1234-2026", "CPSC-25-123")',
          },
          title: {
            type: 'string',
            description: 'Short descriptive title (e.g., "Salmonella contamination in frozen meals", "Defective battery in wireless charger")',
          },
          agency: {
            type: 'string',
            enum: ['FDA', 'CPSC'],
            description: 'The recall agency',
          },
          reasoning: {
            type: 'string',
            description: 'Why this recall is relevant to the company — reference specific products, suppliers, or distribution channels discussed in conversation',
          },
          priority: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description: 'Priority based on risk and relevance to the company',
          },
        },
        required: ['recallNumber', 'title', 'agency', 'reasoning'],
      },
    },
    {
      name: 'generate_document',
      description:
        "Generate and SAVE a recall response document (notification letter, response plan, checklist) to the user's document library. You MUST call this tool whenever the user asks you to create, write, draft, or generate a document. Put the full document content in the 'content' parameter — do NOT write the document in your chat response instead. The document is linked to a recall and becomes searchable.",
      input_schema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Document title (e.g., "Customer Notification Letter", "Corrective Action Plan")',
          },
          content: {
            type: 'string',
            description: 'The full document content in markdown format. Write a complete, professional compliance document — not a stub or outline.',
          },
          requirementCitation: {
            type: 'string',
            description: 'The recall number this document supports (e.g., "F-1234-2026"). Used to link the document to the correct recall.',
          },
        },
        required: ['title', 'content'],
      },
    },
    {
      name: 'save_memory',
      description:
        "Save a fact about this user for future conversations. USE when the user reveals: supply chain details, product lines, distribution channels, supplier relationships, past recall incidents, team members/roles, processes, or communication preferences. Write in second person ('You have...', 'Your company...'). Be specific and concise (1-2 sentences). Do NOT save trivial conversation details.",
      input_schema: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['facility', 'compliance', 'preference', 'process', 'personnel'],
            description: 'Category: facility (site/warehouse details), compliance (recall deadlines/status), preference (communication style), process (supply chain/distribution), personnel (team/roles)',
          },
          fact: {
            type: 'string',
            description: 'The fact to remember, written in second person. E.g., "You distribute products from 3 regional warehouses" or "Your company imports children\'s toys from Shenzhen suppliers"',
          },
        },
        required: ['category', 'fact'],
      },
    },
    {
      name: 'recall_memory',
      description:
        "Search your memory for facts about this user. Auto-recalled memories are already in the system prompt — use this tool for explicit lookups on topics not covered by the auto-recalled set, or to search a specific category.",
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What to search for in memory (e.g., "product lines", "suppliers", "team members")',
          },
          category: {
            type: 'string',
            enum: ['facility', 'compliance', 'preference', 'process', 'personnel'],
            description: 'Optional category filter to narrow the search',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'search_conversations',
      description:
        "Search this user's past conversation history. Use when the user references something from a prior chat (e.g., 'what did we discuss last time?', 'remember when I asked about...') or when you want to check conversation history for context.",
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query to find in past conversations',
          },
        },
        required: ['query'],
      },
    },
    // Web search — server-side tool, executed by Anthropic (no API key needed)
    {
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 5,
    },
  ];
}

/**
 * Create a tool executor closure with companyId baked in
 */
export function createToolExecutor(
  companyId: string,
  context?: { naicsCode?: string; state?: string; userId?: string; conversationId?: string }
): (name: string, input: Record<string, unknown>) => Promise<string> {
  return async (name: string, input: Record<string, unknown>): Promise<string> => {
    console.log(`[Agent Tool] ${name}`, JSON.stringify(input).substring(0, 200));

    switch (name) {
      case 'search_recalls': {
        const query = input.query as string;
        if (!query) return 'Error: query is required';

        const results = await searchAll(query, companyId, {
          regulationLimit: 5,
          obligationLimit: 8,
          documentLimit: 3,
        });

        let output = '';

        if (results.regulations.length > 0) {
          output += '## Matching Recalls\n\n';
          for (const reg of results.regulations) {
            output += `**${reg.citation}** — ${reg.title}\n`;
            output += `Agency: ${reg.agency} | Relevance: ${(1 - reg.distance).toFixed(2)}\n`;
            if (reg.regulationSummary) {
              const summary = typeof reg.regulationSummary === 'string'
                ? reg.regulationSummary
                : JSON.stringify(reg.regulationSummary);
              output += `Summary: ${summary.substring(0, 500)}\n`;
            }
            output += '\n';
          }
        }

        if (results.obligations.length > 0) {
          output += '## Matching Response Actions\n\n';
          for (const obl of results.obligations) {
            output += `**${obl.citation}** — ${obl.title}\n`;
            output += `Action: ${obl.obligationText}\n`;
            output += `Relevance: ${(1 - obl.distance).toFixed(2)}\n\n`;
          }
        }

        if (results.documents.length > 0) {
          output += '## Related Documents\n\n';
          for (const doc of results.documents) {
            output += `**${doc.filename}** (chunk ${doc.chunkIndex})\n`;
            output += `${doc.chunkText.substring(0, 300)}\n`;
            output += `Relevance: ${(1 - doc.distance).toFixed(2)}\n\n`;
          }
        }

        return output || 'No matching recalls, response actions, or documents found.';
      }

      case 'get_recall': {
        const recallNumber = input.recallNumber as string;
        if (!recallNumber) return 'Error: recallNumber is required';

        // Query requirements table by recall number (stored in citation field) + companyId
        const results = await db
          .selectFrom('requirements')
          .selectAll()
          .where('companyId', '=', companyId)
          .where(sql`LOWER(citation)`, 'like', `%${recallNumber.toLowerCase()}%`)
          .execute();

        if (results.length === 0) {
          return `No recall found matching "${recallNumber}" in your tracking dashboard. Try search_recalls for a broader search, or fetch_fda to get the data from the official FDA database.`;
        }

        let output = '';
        for (const req of results) {
          output += `# ${req.citation} — ${req.title}\n\n`;
          output += `**Agency:** ${req.agency}\n`;
          output += `**Status:** ${req.status || 'pending'}\n`;
          output += `**Relevance:** ${req.confidence}%\n`;
          if (req.notes) output += `**Notes:** ${req.notes}\n`;
          if (req.dueDate) output += `**Response Deadline:** ${req.dueDate}\n`;
          if (req.frequency) output += `**Review Frequency:** ${req.frequency}\n`;
          output += '\n';

          if (req.fullText) {
            output += `## Full Recall Details\n\n${(req.fullText as string).substring(0, 30000)}\n\n`;
          } else if (req.regulationSummary) {
            const summary = typeof req.regulationSummary === 'string'
              ? req.regulationSummary
              : JSON.stringify(req.regulationSummary, null, 2);
            output += `## Recall Summary\n\n${summary}\n\n`;
          }

          if (req.possibleObligations) {
            const obligations = typeof req.possibleObligations === 'string'
              ? JSON.parse(req.possibleObligations)
              : req.possibleObligations;
            if (Array.isArray(obligations) && obligations.length > 0) {
              output += `## Required Response Actions\n\n`;
              for (const obl of obligations) {
                output += `- **${obl.description}**\n`;
                if (obl.frequency) output += `  Timeline: ${obl.frequency}\n`;
                if (obl.condition) output += `  Condition: ${obl.condition}\n`;
                if (obl.citationSubsection) output += `  Reference: ${obl.citationSubsection}\n`;
              }
              output += '\n';
            }
          }
        }

        return output;
      }

      case 'search_documents': {
        const query = input.query as string;
        if (!query) return 'Error: query is required';

        const results = await searchDocuments(query, companyId, 5);

        if (results.length === 0) {
          return 'No matching documents found. The user may not have uploaded any documents yet.';
        }

        let output = '## Document Search Results\n\n';
        for (const doc of results) {
          output += `**${doc.filename}** (chunk ${doc.chunkIndex})\n`;
          output += `Relevance: ${(1 - doc.distance).toFixed(2)}\n`;
          output += `Content:\n${doc.chunkText.substring(0, 1000)}\n\n`;
        }

        return output;
      }

      case 'fetch_fda': {
        const recallNumber = input.recallNumber as string;
        if (!recallNumber) return 'Error: recallNumber is required';

        try {
          // Search across all FDA endpoints for this recall number
          const results = await fdaClient.search({
            productDescription: recallNumber,
            limit: 5,
          });

          // Also try a direct search by filtering results
          const match = results.find(r =>
            r.recall_number?.toLowerCase() === recallNumber.toLowerCase() ||
            r.event_id?.toLowerCase() === recallNumber.toLowerCase()
          );

          if (match) {
            let output = `# FDA Recall: ${match.recall_number}\n\n`;
            output += `**Status:** ${match.status}\n`;
            output += `**Classification:** ${match.classification}\n`;
            output += `**Product Type:** ${match.product_type}\n`;
            output += `**Recalling Firm:** ${match.recalling_firm}\n`;
            output += `**City/State:** ${match.city}, ${match.state}\n`;
            output += `**Report Date:** ${match.report_date}\n`;
            output += `**Initiation Date:** ${match.recall_initiation_date}\n`;
            output += `**Voluntary/Mandated:** ${match.voluntary_mandated}\n`;
            if (match.termination_date) output += `**Termination Date:** ${match.termination_date}\n`;
            output += `\n**Product Description:**\n${match.product_description}\n`;
            output += `\n**Reason for Recall:**\n${match.reason_for_recall}\n`;
            output += `\n**Distribution Pattern:**\n${match.distribution_pattern}\n`;
            output += `\n**Product Quantity:** ${match.product_quantity}\n`;
            return output;
          }

          if (results.length > 0) {
            let output = `# FDA Search Results (${results.length} recalls found)\n\nNo exact match for "${recallNumber}", but found related recalls:\n\n`;
            for (const r of results.slice(0, 5)) {
              output += `**${r.recall_number}** — ${r.recalling_firm}\n`;
              output += `Classification: ${r.classification} | Status: ${r.status}\n`;
              output += `Product: ${r.product_description?.substring(0, 200)}\n\n`;
            }
            return output;
          }

          return `No FDA recall found matching "${recallNumber}". The recall number may be incorrect or the FDA API may be temporarily unavailable.`;
        } catch (error) {
          console.error('[Agent Tool] fetch_fda error:', error);
          return `Error fetching FDA data: ${error instanceof Error ? error.message : 'Unknown error'}`;
        }
      }

      case 'check_recent_recalls': {
        const productCategory = input.productCategory as string | undefined;

        try {
          const results = await fdaClient.searchByCategory(
            productCategory || '',
            { limit: 10 }
          );

          if (results.length === 0) {
            return `No recent FDA recalls found${productCategory ? ` for "${productCategory}"` : ''}. The FDA API may be temporarily unavailable or there are no recent recalls in this category.`;
          }

          let output = `## Recent FDA Recalls${productCategory ? ` — ${productCategory}` : ''}\n\n`;
          output += `Found ${results.length} recent recalls:\n\n`;

          for (const r of results) {
            output += `**${r.recall_number}** — ${r.recalling_firm}\n`;
            output += `Classification: ${r.classification} | Status: ${r.status} | Type: ${r.product_type}\n`;
            output += `Date: ${r.report_date} | ${r.voluntary_mandated}\n`;
            output += `Product: ${r.product_description?.substring(0, 200)}\n`;
            output += `Reason: ${r.reason_for_recall?.substring(0, 200)}\n\n`;
          }

          return output;
        } catch (error) {
          console.error('[Agent Tool] check_recent_recalls error:', error);
          return `Error fetching recent recalls: ${error instanceof Error ? error.message : 'Unknown error'}`;
        }
      }

      case 'create_recall': {
        const recallNumber = input.recallNumber as string;
        const title = input.title as string;
        const agency = input.agency as string;
        const reasoning = input.reasoning as string;
        const priority = (input.priority as string) || 'medium';

        if (!recallNumber || !title || !agency) {
          return 'Error: recallNumber, title, and agency are required';
        }

        if (!['FDA', 'CPSC'].includes(agency)) {
          return `Error: agency must be FDA or CPSC (got "${agency}")`;
        }

        try {
          // Check for duplicates
          const existing = await db
            .selectFrom('requirements')
            .select(['id', 'citation', 'title'])
            .where('companyId', '=', companyId)
            .where(sql`LOWER(citation)`, 'like', `%${recallNumber.toLowerCase()}%`)
            .executeTakeFirst();

          if (existing) {
            return `Recall "${existing.citation} — ${existing.title}" is already tracked on your dashboard. No duplicate created.`;
          }

          const requirement = await createRequirement({
            discoveryId: null,
            companyId,
            citation: recallNumber,
            title,
            agency: agency as 'FDA' | 'CPSC',
            confidence: 85,
            reasoning,
            source: 'recall_advisor',
            status: 'pending',
            priority: priority as 'high' | 'medium' | 'low',
            notes: `Added by Recall Advisor: ${reasoning}`,
          });

          console.log(`[Agent Tool] Created recall: ${requirement.id} — ${recallNumber}`);

          // Fire-and-forget: run the full enrichment pipeline (FDA fetch + 3 Opus calls)
          // This populates recall details, response actions, relevance scoring, etc.
          enrichRequirement(requirement.id).catch(err =>
            console.error(`[Agent Tool] Enrichment failed for ${requirement.id}:`, err)
          );

          return `Successfully added "${recallNumber} — ${title}" to your tracking dashboard.\n\n- **ID:** ${requirement.id}\n- **Agency:** ${agency}\n- **Status:** pending\n- **Priority:** ${priority}\n- **Source:** Recall Advisor recommendation\n\nThe recall is now tracked and will appear on your dashboard. Full analysis (recall details, response actions, relevance scoring) is running in the background and will be available shortly.`;
        } catch (error) {
          console.error('[Agent Tool] create_recall error:', error);
          return `Error creating recall: ${error instanceof Error ? error.message : 'Unknown error'}`;
        }
      }

      case 'generate_document': {
        const docTitle = input.title as string;
        const content = input.content as string;
        const requirementCitation = input.requirementCitation as string | undefined;

        if (!docTitle || !content) {
          return 'Error: title and content are required';
        }

        if (!context?.userId) {
          return 'Error: user context not available for document creation';
        }

        try {
          // Find the linked requirement if citation provided
          let requirementId: string | null = null;
          if (requirementCitation) {
            const req = await db
              .selectFrom('requirements')
              .select(['id'])
              .where('companyId', '=', companyId)
              .where(sql`LOWER(citation)`, 'like', `%${requirementCitation.toLowerCase().replace(/\s+cfr\s+/i, ' CFR ')}%`)
              .executeTakeFirst();
            requirementId = req?.id || null;
          }

          // Create the document record
          const filename = `${docTitle.replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '-')}.txt`;
          const s3Key = `agent-generated/${companyId}/${crypto.randomUUID()}-${filename}`;
          const fileSizeBytes = Buffer.byteLength(content, 'utf-8');

          const doc = await createDocument({
            userId: context.userId,
            companyId,
            requirementId: requirementId || '',
            filename,
            fileType: 'TXT',
            s3Key,
            fileSizeBytes,
          });

          // Set the extracted text directly (no S3 upload needed — content is the text)
          await sql`
            UPDATE documents SET "extractedText" = ${content} WHERE id = ${doc.id}::uuid
          `.execute(db);

          // Fire-and-forget: embed the document for semantic search
          embedDocument(doc.id).catch((err: unknown) =>
            console.error(`[Agent Tool] Failed to embed document ${doc.id}:`, err)
          );

          console.log(`[Agent Tool] Generated document: ${doc.id} — ${docTitle} (${fileSizeBytes} bytes)`);
          return `Document "${docTitle}" has been created and saved.\n\n- **Document ID:** ${doc.id}\n- **Filename:** ${filename}\n- **Size:** ${fileSizeBytes.toLocaleString()} bytes\n${requirementId ? `- **Linked to:** ${requirementCitation}\n` : '- **Not linked to a specific requirement** (citation not found in matrix)\n'}\n\nThe document is now searchable and will appear in document search results. The full content has been embedded for semantic search.`;
        } catch (error) {
          console.error('[Agent Tool] generate_document error:', error);
          return `Error generating document: ${error instanceof Error ? error.message : 'Unknown error'}`;
        }
      }

      case 'save_memory': {
        const category = input.category as MemoryCategory;
        const fact = input.fact as string;

        if (!category || !fact) return 'Error: category and fact are required';
        if (!context?.userId) return 'Error: user context not available';

        try {
          const memory = await saveMemory({
            userId: context.userId,
            category,
            fact,
            source: 'agent',
            conversationId: context.conversationId,
          });

          return `Saved to memory: [${category}] "${fact}" (ID: ${memory.id})`;
        } catch (error) {
          console.error('[Agent Tool] save_memory error:', error);
          return `Error saving memory: ${error instanceof Error ? error.message : 'Unknown error'}`;
        }
      }

      case 'recall_memory': {
        const query = input.query as string;
        const category = input.category as MemoryCategory | undefined;

        if (!query) return 'Error: query is required';
        if (!context?.userId) return 'Error: user context not available';

        try {
          const memories = await recallMemory(context.userId, query, {
            limit: 10,
            maxDistance: 0.5,
            category,
          });

          if (memories.length === 0) {
            return 'No matching memories found for this user.';
          }

          let output = '## Recalled Memories\n\n';
          for (const m of memories) {
            const age = Math.round((Date.now() - new Date(m.createdAt).getTime()) / (1000 * 60 * 60 * 24));
            output += `- [${m.category}] ${m.fact} (${age}d ago, relevance: ${(1 - (m.distance || 0)).toFixed(2)})\n`;
          }
          return output;
        } catch (error) {
          console.error('[Agent Tool] recall_memory error:', error);
          return `Error recalling memory: ${error instanceof Error ? error.message : 'Unknown error'}`;
        }
      }

      case 'search_conversations': {
        const query = input.query as string;
        if (!query) return 'Error: query is required';
        if (!context?.userId) return 'Error: user context not available';

        try {
          const results = await sql<{
            id: string;
            role: string;
            content: string;
            conversationId: string;
            createdAt: Date;
          }>`
            SELECT id, role, content, "conversationId", "createdAt"
            FROM chat_messages
            WHERE "userId" = ${context.userId}::uuid
              AND content ILIKE ${'%' + query + '%'}
            ORDER BY "createdAt" DESC
            LIMIT 10
          `.execute(db);

          if (results.rows.length === 0) {
            return `No past conversations found matching "${query}".`;
          }

          let output = `## Past Conversations (${results.rows.length} matches)\n\n`;
          for (const msg of results.rows) {
            const date = new Date(msg.createdAt).toLocaleDateString();
            const snippet = msg.content.length > 300
              ? msg.content.substring(0, 300) + '...'
              : msg.content;
            output += `**[${msg.role}]** ${date} (conv: ${msg.conversationId?.substring(0, 8) || 'unknown'})\n${snippet}\n\n`;
          }
          return output;
        } catch (error) {
          console.error('[Agent Tool] search_conversations error:', error);
          return `Error searching conversations: ${error instanceof Error ? error.message : 'Unknown error'}`;
        }
      }

      // web_search is a server-side tool — Anthropic executes it, no executor case needed

      default:
        return `Unknown tool: ${name}`;
    }
  };
}
