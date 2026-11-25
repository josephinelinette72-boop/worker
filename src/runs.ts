/**
 * Agent runs: start `claude -p` for an agent, turn its stream-json output
 * into simple events, keep them for the page, and save them to runs/.
 *
 * Every run is locked down the same way:
 *   --tools ""            no built-in tools: no shell, no file reading or writing
 *   --strict-mcp-config   only the agent's own MCP server, nothing from settings
 *   --allowedTools        that server's tools (plus web search for marketing)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export type AgentId = 'ops' | 'marketing';

export type RunEvent =
  | { kind: 'start'; at: string; model?: string; tools: string[] }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; input: unknown }
  | { kind: 'result'; id: string; text: string; isError: boolean }
  | { kind: 'done'; ok: boolean; turns?: number; durationMs?: number; summary?: string }
  | { kind: 'error'; text: string }
  /** Sent to the page once the process has exited. Not saved. */
  | { kind: 'end'; status: RunInfo['status'] };

export type RunInfo = {
  id: string;
  agent: AgentId;
  title: string;
  status: 'running' | 'done' | 'failed' | 'stopped';
  startedAt: string;
  endedAt?: string;
};

type Run = RunInfo & { events: RunEvent[]; listeners: Set<(e: RunEvent) => void>; child?: ChildProcess };

export type RunSpec = {
  agent: AgentId;
  title: string;
  cwd: string;
  prompt: string;
  agentName: string;
  mcpServer: string;
  extraTools?: string[];
  env?: Record<string, string>;
};

const MAX_EVENTS = 3000;
const MAX_RESULT_CHARS = 6000;

export function claudeArgs(spec: RunSpec): string[] {
  const builtIn = spec.extraTools ?? [];
  return [
    '-p',
    '--agent', spec.agentName,
    '--tools', builtIn.join(','),
    '--strict-mcp-config',
    '--mcp-config', path.join(spec.cwd, '.mcp.json'),
    '--allowedTools', [`mcp__${spec.mcpServer}`, ...builtIn].join(','),
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
    spec.prompt,
  ];
}

/** stream-json line → zero or more simple events. */
export function translate(line: string, serverPrefix: string): RunEvent[] {
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  const strip = (name: string) => name.replace(serverPrefix, '');
  if (e.type === 'system' && e.subtype === 'init') {
    return [{ kind: 'start', at: new Date().toISOString(), model: e.model as string | undefined, tools: ((e.tools as string[]) ?? []).map(strip) }];
  }
  if (e.type === 'result') {
    return [
      {
        kind: 'done',
        ok: e.subtype === 'success' && e.is_error !== true,
        turns: e.num_turns as number | undefined,
        durationMs: e.duration_ms as number | undefined,
        summary: typeof e.result === 'string' ? e.result : undefined,
      },
    ];
  }
  const message = e.message as { content?: unknown } | undefined;
  if (!message || !Array.isArray(message.content)) return [];
  const out: RunEvent[] = [];
  for (const block of message.content as Array<Record<string, unknown>>) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) out.push({ kind: 'text', text: block.text });
    if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) out.push({ kind: 'thinking', text: block.thinking });
    if (block.type === 'tool_use') out.push({ kind: 'tool', id: String(block.id), name: strip(String(block.name)), input: block.input });
    if (block.type === 'tool_result') {
      const content = block.content;
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((c: { text?: string }) => c.text ?? '').join('\n')
          : JSON.stringify(content);
      out.push({ kind: 'result', id: String(block.tool_use_id), text: text.slice(0, MAX_RESULT_CHARS), isError: block.is_error === true });
    }
  }
  return out;
}

export class RunManager {
  private runs = new Map<string, Run>();

  constructor(private readonly claudeBin: () => string | undefined, private readonly runsDir: string) {
    mkdirSync(runsDir, { recursive: true });
    this.loadHistory();
  }

  list(): RunInfo[] {
    return [...this.runs.values()]
      .map(({ id, agent, title, status, startedAt, endedAt }) => ({ id, agent, title, status, startedAt, endedAt }))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  active(agent: AgentId): RunInfo | undefined {
    return this.list().find((r) => r.agent === agent && r.status === 'running');
  }

  start(spec: RunSpec): RunInfo {
    const bin = this.claudeBin();
    if (!bin) throw new Error('Claude Code was not found. Set CLAUDE_BIN.');
    if (this.active(spec.agent)) throw new Error(`The ${spec.agent} agent is already running.`);
    if (!existsSync(path.join(spec.cwd, '.mcp.json'))) throw new Error(`${spec.cwd}/.mcp.json is missing.`);

    const id = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${spec.agent}-${randomBytes(2).toString('hex')}`;
    const run: Run = { id, agent: spec.agent, title: spec.title, status: 'running', startedAt: new Date().toISOString(), events: [], listeners: new Set() };
    this.runs.set(id, run);
    this.save(run, { kind: 'meta', ...this.info(run) });

    const child = spawn(bin, claudeArgs(spec), {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    run.child = child;

    const prefix = `mcp__${spec.mcpServer}__`;
    let buffer = '';
    let stderr = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        for (const event of translate(line, prefix)) this.emit(run, event);
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.on('error', (error) => this.emit(run, { kind: 'error', text: error.message }));
    child.on('close', (code) => {
      if (run.status === 'running') {
        const sawDone = run.events.some((e) => e.kind === 'done');
        if (code !== 0 && !sawDone) this.emit(run, { kind: 'error', text: stderr.trim() || `Claude Code exited with code ${code}` });
        const ok = run.events.some((e) => e.kind === 'done' && e.ok);
        run.status = ok ? 'done' : 'failed';
      }
      run.endedAt = new Date().toISOString();
      run.child = undefined;
      this.save(run, { kind: 'meta', ...this.info(run) });
      for (const l of run.listeners) l({ kind: 'end', status: run.status });
      run.listeners.clear();
    });
    return this.info(run);
  }

  stop(id: string): void {
    const run = this.runs.get(id);
    if (!run?.child) return;
    run.status = 'stopped';
    run.child.kill('SIGTERM');
    this.emit(run, { kind: 'error', text: 'Stopped by you.' });
  }

  /** Past events, then live ones. Returns an unsubscribe function. */
  subscribe(id: string, listener: (e: RunEvent) => void): (() => void) | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;
    for (const e of run.events) listener(e);
    if (run.status !== 'running') {
      listener({ kind: 'end', status: run.status });
      return () => {};
    }
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  private info(run: Run): RunInfo {
    const { id, agent, title, status, startedAt, endedAt } = run;
    return { id, agent, title, status, startedAt, endedAt };
  }

  private emit(run: Run, event: RunEvent): void {
    if (run.events.length < MAX_EVENTS) run.events.push(event);
    this.save(run, event);
    for (const l of run.listeners) l(event);
  }

  private save(run: Run, record: object): void {
    appendFileSync(path.join(this.runsDir, `${run.id}.jsonl`), `${JSON.stringify(record)}\n`);
  }

  /** Reload the last 30 runs from disk so history survives a restart. */
  private loadHistory(): void {
    const files = readdirSync(this.runsDir).filter((f) => f.endsWith('.jsonl')).sort().slice(-30);
    for (const f of files) {
      const lines = readFileSync(path.join(this.runsDir, f), 'utf8').split('\n').filter(Boolean);
      let meta: RunInfo | undefined;
      const events: RunEvent[] = [];
      for (const line of lines) {
        const rec = JSON.parse(line) as { kind: string } & Record<string, unknown>;
        if (rec.kind === 'meta') {
          const { kind: _k, ...rest } = rec;
          meta = rest as unknown as RunInfo;
        } else if (events.length < MAX_EVENTS) events.push(rec as unknown as RunEvent);
      }
      if (!meta) continue;
      // A run that was live when the console stopped did not finish.
      if (meta.status === 'running') meta.status = 'stopped';
      this.runs.set(meta.id, { ...meta, events, listeners: new Set() });
    }
  }
}
