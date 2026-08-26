// Anthropic Claude API Client
// Supports Haiku (fast/cheap), Sonnet (balanced), and Opus (powerful) models

// Types for tool_use support
// Custom tool: you define and execute it
export interface AnthropicCustomTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

// Server tool: Anthropic executes it server-side (e.g., web search)
export interface AnthropicServerTool {
  type: string; // e.g., 'web_search_20250305'
  name: string;
  max_uses?: number;
}

export type AnthropicTool = AnthropicCustomTool | AnthropicServerTool;

export interface ToolCallRecord {
  tool: string;
  input: Record<string, unknown>;
  output: string;
}

export interface ToolUseResponse {
  content: string;
  toolCalls: ToolCallRecord[];
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}

// Token usage tracker - accumulates across all API calls
export const tokenTracker = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  callCount: 0,
  byModel: {} as Record<string, { input: number; output: number; calls: number }>,

  add(model: string, inputTokens: number, outputTokens: number) {
    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
    this.callCount++;

    if (!this.byModel[model]) {
      this.byModel[model] = { input: 0, output: 0, calls: 0 };
    }
    this.byModel[model].input += inputTokens;
    this.byModel[model].output += outputTokens;
    this.byModel[model].calls++;
  },

  reset() {
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.callCount = 0;
    this.byModel = {};
  },

  estimateCost(): number {
    // Pricing per million tokens (as of 2025)
    const pricing: Record<string, { input: number; output: number }> = {
      'claude-opus-4-6': { input: 15, output: 75 },
      'claude-opus-4-5-20251101': { input: 15, output: 75 },
      'claude-sonnet-4-5-20250929': { input: 3, output: 15 },
      'claude-sonnet-4-20250514': { input: 3, output: 15 },
      'claude-haiku-4-20250414': { input: 0.25, output: 1.25 },
    };

    let totalCost = 0;
    for (const [model, usage] of Object.entries(this.byModel)) {
      const price = pricing[model] || { input: 3, output: 15 }; // default to Sonnet pricing
      totalCost += (usage.input / 1_000_000) * price.input;
      totalCost += (usage.output / 1_000_000) * price.output;
    }
    return totalCost;
  },

  log() {
    console.log(`[Token Usage] Total: ${this.totalInputTokens.toLocaleString()} input, ${this.totalOutputTokens.toLocaleString()} output (${this.callCount} calls)`);
    console.log(`[Token Usage] Estimated cost: $${this.estimateCost().toFixed(4)}`);
    for (const [model, usage] of Object.entries(this.byModel)) {
      const shortModel = model.replace('claude-', '').replace('-20250514', '').replace('-20251101', '').replace('-20250929', '');
      console.log(`[Token Usage]   ${shortModel}: ${usage.input.toLocaleString()} in, ${usage.output.toLocaleString()} out (${usage.calls} calls)`);
    }
  }
};

export interface AnthropicConfig {
  apiKey?: string;
  model?:
    | 'claude-opus-4-6'              // Opus 4.6 - most powerful, for complex reasoning + tool use
    | 'claude-opus-4-5-20251101'      // Opus 4.5
    | 'claude-sonnet-4-5-20250929'    // Sonnet 4.5 - latest Sonnet
    | 'claude-sonnet-4-20250514'      // Sonnet 4 - recommended for most tasks
    | 'claude-haiku-4-20250414'       // Haiku 4 - fast and cheap
    | 'claude-3-5-sonnet-20241022'    // Sonnet 3.5 - fallback
    | 'claude-3-5-haiku-20241022'     // Haiku 3.5 - fallback
    | 'claude-3-haiku-20240307'       // Legacy
    | 'claude-3-sonnet-20240229';     // Legacy
  maxTokens?: number;
  temperature?: number;
}

export interface AnthropicMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AnthropicResponse {
  content: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  model: string;
  stopReason?: string;
}

/**
 * Wire format returned by POST /v1/messages.
 *
 * Declared explicitly because this module now lives in @recall/shared, which
 * compiles against the Node lib rather than the DOM lib. `Response.json()`
 * resolves to `unknown` under Node's types and to `any` under the DOM's, so
 * while this file lived in the Next.js app these accesses were silently
 * untyped. Nothing about the parsing changed — it is just checked now.
 */
interface AnthropicContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
  [key: string]: unknown;
}

interface AnthropicApiResponse {
  model: string;
  stop_reason: string | null;
  // The Messages API always returns usage on a 2xx; non-2xx throws above.
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  content: AnthropicContentBlock[];
}

/** A content block the API guarantees carries a tool name and input. */
interface AnthropicToolUseBlock extends AnthropicContentBlock {
  name: string;
  input: Record<string, unknown>;
}

/**
 * Type predicate narrowing a content block to a tool-use block of the given
 * type, so `name` and `input` are known-present at the call sites below.
 */
function isToolUseBlock(blockType: string) {
  return (b: AnthropicContentBlock): b is AnthropicToolUseBlock =>
    b.type === blockType && typeof b.name === 'string';
}

export class AnthropicClient {
  private apiKey: string;
  private baseUrl = 'https://api.anthropic.com/v1/messages';
  private defaultModel = 'claude-sonnet-4-20250514'; // Sonnet 4 - best balance of quality/cost

  constructor(config?: AnthropicConfig) {
    // Try to get API key from environment variable first
    this.apiKey = config?.apiKey || process.env.ANTHROPIC_API_KEY || '';

    if (config?.model) {
      this.defaultModel = config.model;
    }
  }

  /**
   * Check if API key is configured
   */
  isConfigured(): boolean {
    return this.apiKey.length > 0 && this.apiKey !== 'YOUR_API_KEY_HERE';
  }

  /**
   * Send a message to Claude
   */
  async sendMessage(
    messages: AnthropicMessage[],
    options?: {
      model?: string;
      maxTokens?: number;
      temperature?: number;
      system?: string;
      signal?: AbortSignal;
    }
  ): Promise<AnthropicResponse> {
    if (!this.isConfigured()) {
      console.warn('Anthropic API key not configured. Cannot process request.');
      return {
        content: 'ERROR: Anthropic API key not configured. Please add your API key to use this feature.',
        model: 'none'
      };
    }

    // Check if already aborted before making request
    if (options?.signal?.aborted) {
      throw new DOMException('Request aborted', 'AbortError');
    }

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: options?.model || this.defaultModel,
          max_tokens: options?.maxTokens || 1000,
          temperature: options?.temperature || 0.3, // Lower temperature for more consistent regulatory responses
          system: options?.system,
          messages: messages.filter(m => m.role !== 'system') // System message goes in separate field
        }),
        signal: options?.signal
      });

      if (!response.ok) {
        throw new Error(`Anthropic API error: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as AnthropicApiResponse;

      // Track token usage
      const inputTokens = data.usage.input_tokens;
      const outputTokens = data.usage.output_tokens;
      tokenTracker.add(data.model, inputTokens, outputTokens);

      return {
        content: data.content[0]?.text ?? '',
        usage: {
          inputTokens,
          outputTokens
        },
        model: data.model,
        stopReason: data.stop_reason ?? undefined
      };
    } catch (error) {
      // Re-throw AbortError so callers can handle cancellation
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      console.error('Anthropic API error:', error);
      // Return error response
      return {
        content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        model: 'error'
      };
    }
  }

  /**
   * Quick method for single question/answer
   */
  async ask(
    prompt: string,
    options?: {
      model?: string;
      maxTokens?: number;
      temperature?: number;
      system?: string;
      signal?: AbortSignal;
    }
  ): Promise<string> {
    const response = await this.sendMessage(
      [{ role: 'user', content: prompt }],
      options
    );
    return response.content;
  }

  // Removed mock response function - real API key required

  /**
   * Send a message with tool definitions, handling the tool_use loop.
   * Executes tools via the provided callback and re-sends until end_turn or max rounds.
   */
  async sendMessageWithTools(
    messages: AnthropicMessage[],
    tools: AnthropicTool[],
    executeToolCall: (name: string, input: Record<string, unknown>) => Promise<string>,
    options?: {
      model?: string;
      maxTokens?: number;
      temperature?: number;
      system?: string;
      maxToolRounds?: number;
    }
  ): Promise<ToolUseResponse> {
    if (!this.isConfigured()) {
      return {
        content: 'ERROR: Anthropic API key not configured.',
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        model: 'none',
      };
    }

    const model = options?.model || this.defaultModel;
    const maxRounds = options?.maxToolRounds ?? 5;
    const allToolCalls: ToolCallRecord[] = [];
    let totalInput = 0;
    let totalOutput = 0;

    // Build the messages array for the API (content can be string or content blocks)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let apiMessages: any[] = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role, content: m.content }));

    for (let round = 0; round < maxRounds; round++) {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: options?.maxTokens || 4096,
          temperature: options?.temperature ?? 0.3,
          system: options?.system,
          messages: apiMessages,
          tools,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Anthropic API error: ${response.status} ${errText}`);
      }

      const data = (await response.json()) as AnthropicApiResponse;

      // Accumulate usage
      totalInput += data.usage?.input_tokens || 0;
      totalOutput += data.usage?.output_tokens || 0;
      tokenTracker.add(data.model, data.usage?.input_tokens || 0, data.usage?.output_tokens || 0);

      // If stop_reason is end_turn (or not tool_use), extract text and return
      if (data.stop_reason !== 'tool_use') {
        const textContent = (data.content ?? [])
          .filter(b => b.type === 'text')
          .map(b => b.text ?? '')
          .join('');

        return {
          content: textContent,
          toolCalls: allToolCalls,
          usage: { inputTokens: totalInput, outputTokens: totalOutput },
          model: data.model,
        };
      }

      // Log server tool calls (e.g., web_search) — executed by Anthropic, results already in response
      const serverToolBlocks = data.content.filter(isToolUseBlock('server_tool_use'));
      for (const block of serverToolBlocks) {
        allToolCalls.push({
          tool: block.name,
          input: block.input ?? {},
          output: '[server-executed]',
        });
      }

      // Handle custom tool_use blocks (we execute these)
      const toolUseBlocks = data.content.filter(isToolUseBlock('tool_use'));

      // Append the assistant message (with all content blocks including tool_use + server results)
      apiMessages.push({ role: 'assistant', content: data.content });

      // Execute each tool call and build tool_result messages
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolResults: any[] = [];
      for (const block of toolUseBlocks) {
        let output: string;
        try {
          output = await executeToolCall(block.name, block.input);
        } catch (err) {
          output = `Error executing tool ${block.name}: ${err instanceof Error ? err.message : 'Unknown error'}`;
        }

        allToolCalls.push({
          tool: block.name,
          input: block.input,
          output,
        });

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: output,
        });
      }

      // Append tool results as a user message
      apiMessages.push({ role: 'user', content: toolResults });
    }

    // If we hit max rounds, return whatever we have
    return {
      content: '[Agent reached maximum tool rounds without completing response]',
      toolCalls: allToolCalls,
      usage: { inputTokens: totalInput, outputTokens: totalOutput },
      model,
    };
  }

  /**
   * Estimate cost for API usage
   */
  estimateCost(usage: { inputTokens: number; outputTokens: number }, model?: string): number {
    const activeModel = model || this.defaultModel;

    // Pricing per million tokens (as of 2024)
    const pricing: Record<string, { input: number; output: number }> = {
      'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },
      'claude-3-sonnet-20240229': { input: 3, output: 15 },
      'claude-3-opus-20240229': { input: 15, output: 75 }
    };

    const modelPricing = pricing[activeModel] || pricing['claude-3-haiku-20240307'];

    const inputCost = (usage.inputTokens / 1_000_000) * modelPricing.input;
    const outputCost = (usage.outputTokens / 1_000_000) * modelPricing.output;

    return inputCost + outputCost;
  }
}

// Export singleton instances
// Sonnet 4 - for general tasks, keyword generation, initial scoring
export const sonnetClient = new AnthropicClient({ model: 'claude-sonnet-4-20250514' });

// Opus 4.6 - for compliance agent (tool use, complex reasoning)
export const opusClient = new AnthropicClient({ model: 'claude-opus-4-6' });