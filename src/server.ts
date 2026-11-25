/**
 * Agent Console: a local web page for the ops and marketing agents.
 *
 *   npm start            then open http://localhost:4747
 *
 * The agents run through Claude Code on your Claude plan (no API key).
 *
 * Safety for a server that can start agents:
 *   - listens on 127.0.0.1 only, so other computers cannot reach it;
 *   - checks the Host header, so a web page cannot reach it via a DNS trick;
 *   - every API call needs a random token that is only inside this page, so
 *     other websites open in your browser cannot start runs or approve posts.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { claudeStatus, findClaude, type ClaudeStatus } from './claude.js';
import { marketingData, opsData } from './data.js';
import { RunManager, type AgentId, type RunEvent } from './runs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.CONSOLE_PORT ?? 4747);
const WALLET_DIR = process.env.WALLET_DIR ?? path.join(homedir(), 'wallet');
const MARKETING_DIR = process.env.MARKETING_DIR ?? path.join(homedir(), 'marketing-agent');
const TOKEN = randomBytes(24).toString('hex');

// The ops agent's standard task, from the wallet project itself so the wording never drifts.
const { HEALTH_CHECK_TASK } = (await import(path.join(WALLET_DIR, 'agents', 'ops', 'prompt.ts'))) as { HEALTH_CHECK_TASK: string };

const claudeBin = findClaude();
let status: ClaudeStatus | undefined;
const runs = new RunManager(() => claudeBin, path.join(ROOT, 'runs'));
const ops = opsData(WALLET_DIR);
const marketing = existsSync(MARKETING_DIR) ? await marketingData(MARKETING_DIR) : undefined;

/** Public, non-secret settings from the wallet's .env (never RPC URLs: they can hold API keys). */
function walletSettings() {
  const file = path.join(WALLET_DIR, '.env');
  const values: Record<string, string> = {};
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*(CHAIN|PROPERTY_ADDRESS|OFFERING_ADDRESS|SAFE_ADDRESS|OPS_CONNECT)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) values[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
    }
  }
  return {
    connected: values.OPS_CONNECT?.toLowerCase() === 'true',
    chain: values.CHAIN || 'anvil',
    property: values.PROPERTY_ADDRESS,
    offering: values.OFFERING_ADDRESS,
    safe: values.SAFE_ADDRESS,
  };
}

// --- HTTP helpers ------------------------------------------------------------

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json') {
  const text = type === 'application/json' ? JSON.stringify(body) : String(body);
  res.writeHead(status, {
    'content-type': `${type}; charset=utf-8`,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
  });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new HttpError(413, 'Request too large.');
  }
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, 'Body is not JSON.');
  }
}

function tokenOk(given: string | null | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

const str = (v: unknown, max = 4000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// --- Routes ------------------------------------------------------------------

async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
  const method = req.method ?? 'GET';
  const p = url.pathname;

  if (p === '/api/status' && method === 'GET') {
    status ??= claudeStatus(claudeBin);
    return send(res, 200, {
      claude: status,
      wallet: { dir: WALLET_DIR, ...walletSettings() },
      marketing: { dir: MARKETING_DIR, available: Boolean(marketing) },
    });
  }

  // Runs
  if (p === '/api/runs' && method === 'GET') return send(res, 200, runs.list());
  if (p === '/api/runs' && method === 'POST') {
    const body = await readJson(req);
    const agent = body.agent as AgentId;
    if (agent === 'ops') {
      const question = str(body.question);
      const info = runs.start({
        agent,
        title: question ? `Question: ${question.slice(0, 80)}` : 'Health check',
        cwd: WALLET_DIR,
        agentName: 'ops-agent',
        mcpServer: 'ops',
        extraTools: ['WebSearch', 'WebFetch'],
        prompt: question || HEALTH_CHECK_TASK,
      });
      return send(res, 201, info);
    }
    if (agent === 'marketing') {
      if (!marketing) throw new HttpError(400, `No marketing project at ${MARKETING_DIR}.`);
      const subject = str(body.subject, 500);
      if (!subject) throw new HttpError(400, 'Say what the campaign is for.');
      const brandId = str(body.brand, 60);
      const brand = brandId ? marketing.loadBrand(brandId) : undefined;
      const web = body.web !== false;
      const info = runs.start({
        agent,
        title: `Campaign: ${subject.slice(0, 80)}`,
        cwd: MARKETING_DIR,
        agentName: 'marketing-agent',
        mcpServer: 'marketing',
        extraTools: web ? ['WebSearch', 'WebFetch'] : [],
        env: { MARKETING_BRAND: brand?.id ?? '' },
        prompt: marketing.task({ subject, brief: str(body.brief, 2000), brand, web }),
      });
      return send(res, 201, info);
    }
    throw new HttpError(400, 'Unknown agent.');
  }
  const stopMatch = /^\/api\/runs\/([\w-]+)\/stop$/.exec(p);
  if (stopMatch && method === 'POST') {
    runs.stop(stopMatch[1]!);
    return send(res, 200, { ok: true });
  }
  const eventsMatch = /^\/api\/runs\/([\w-]+)\/events$/.exec(p);
  if (eventsMatch && method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    const write = (e: RunEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    const unsubscribe = runs.subscribe(eventsMatch[1]!, (e) => {
      write(e);
      if (e.kind === 'end') res.end();
    });
    if (!unsubscribe) {
      write({ kind: 'error', text: 'No such run.' });
      write({ kind: 'end', status: 'failed' });
      return res.end();
    }
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
    return;
  }

  // Ops output
  if (p === '/api/ops/reports' && method === 'GET') return send(res, 200, ops.reports());
  const reportMatch = /^\/api\/ops\/reports\/([\w.-]+)$/.exec(p);
  if (reportMatch && method === 'GET') return send(res, 200, { markdown: ops.report(reportMatch[1]!) });
  if (p === '/api/ops/alerts' && method === 'GET') return send(res, 200, ops.alerts());
  if (p === '/api/ops/proposals' && method === 'GET') return send(res, 200, ops.proposals());

  // Marketing queue
  if (!marketing && p.startsWith('/api/marketing/')) throw new HttpError(400, `No marketing project at ${MARKETING_DIR}.`);
  if (p === '/api/marketing/brands' && method === 'GET') return send(res, 200, marketing!.brands());
  if (p === '/api/marketing/campaigns' && method === 'GET') return send(res, 200, marketing!.campaigns());
  const reviewMatch = /^\/api\/marketing\/campaigns\/([\w-]+)\/review$/.exec(p);
  if (reviewMatch && method === 'POST') {
    const body = await readJson(req);
    const decision = body.decision === 'approve' ? 'approve' : body.decision === 'reject' ? 'reject' : undefined;
    if (!decision) throw new HttpError(400, 'decision must be approve or reject.');
    return send(res, 200, marketing!.review(reviewMatch[1]!, decision, str(body.reason, 1000)));
  }
  if (p === '/api/marketing/publish' && method === 'POST') return send(res, 200, await marketing!.publish());

  throw new HttpError(404, 'Not found.');
}

const STATIC: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html'],
  '/app.js': ['app.js', 'text/javascript'],
  '/app.css': ['app.css', 'text/css'],
};

const server = createServer(async (req, res) => {
  try {
    // Only this computer, by name. Blocks DNS-rebinding pages.
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `localhost:${PORT}` && host !== `127.0.0.1:${PORT}`) throw new HttpError(403, 'Open this page at http://localhost:' + PORT);
    const url = new URL(req.url ?? '/', `http://${host}`);

    if (url.pathname.startsWith('/api/')) {
      const given = req.headers['x-console-token'] ?? url.searchParams.get('token');
      if (!tokenOk(Array.isArray(given) ? given[0] : given)) throw new HttpError(401, 'Missing or wrong console token. Reload the page.');
      return await api(req, res, url);
    }
    const asset = STATIC[url.pathname];
    if (!asset || req.method !== 'GET') throw new HttpError(404, 'Not found.');
    let body = readFileSync(path.join(ROOT, 'public', asset[0]), 'utf8');
    if (asset[0] === 'index.html') body = body.replace('__CONSOLE_TOKEN__', TOKEN);
    return send(res, 200, body, asset[1]);
  } catch (error) {
    const code = error instanceof HttpError ? error.status : 500;
    if (!res.headersSent) send(res, code, { error: error instanceof Error ? error.message : String(error) });
    else res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Agent Console: http://localhost:${PORT}`);
  console.log(`  Claude Code: ${claudeBin ?? 'NOT FOUND (set CLAUDE_BIN)'}`);
  console.log(`  Wallet:      ${WALLET_DIR}`);
  console.log(`  Marketing:   ${marketing ? MARKETING_DIR : `not found at ${MARKETING_DIR}`}`);
  console.log('Press Ctrl+C to stop. Runs in progress stop with it.');
});
