// Recall Advisor AI service — internal HTTP API.
//
// Not exposed through ingress. Core API is the only caller: it authenticates the
// user, resolves companyId and the company profile, and forwards both here.
//
// This service owns the recall.recallAdvisor gate (see chat-handler.ts), which
// is why it initialises its own rox-node SDK with the shared FM_KEY.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { initFM } from '@recall/shared/fm';
import { handleChat, ChatError, type ChatRequest } from './chat-handler.ts';

const PORT = Number(process.env.PORT ?? 8080);
const MAX_BODY_BYTES = 1_000_000;

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ChatError('Request body too large', 413);
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ChatError('Request body is not valid JSON', 400);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';

  try {
    if (method === 'GET' && (path === '/healthz' || path === '/')) {
      return send(res, 200, { ok: true });
    }

    if (method === 'POST' && path === '/chat') {
      const body = (await readJsonBody(req)) as ChatRequest;
      const result = await handleChat(body);
      return send(res, 200, result);
    }

    return send(res, 404, { error: 'Not found' });
  } catch (error) {
    // ChatError carries the status the monolith returned for this condition —
    // notably 403 when recall.recallAdvisor is off, which Core API relays
    // unchanged so the browser sees the same response as before.
    if (error instanceof ChatError) {
      return send(res, error.status, { error: error.message });
    }
    console.error('[ai-service] Error:', error);
    if (!res.headersSent) {
      send(res, 500, {
        error: `Chat failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  }
});

// Tool-use conversations run several model round trips.
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 65_000;

// Register flags and connect to Feature Management before serving. Without
// FM_KEY this logs and falls through to code defaults, which for
// recall.recallAdvisor means the flag reads false and chat returns 403 — the
// same behaviour the monolith had.
await initFM();

server.listen(PORT, () => {
  console.log(`[ai-service] Recall Advisor listening on :${PORT}`);
});

function shutdown(signal: string) {
  console.log(`[ai-service] ${signal} received, closing server`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
