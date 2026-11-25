/**
 * Finding and checking Claude Code, which runs the agents on your Claude plan.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** CLAUDE_BIN, then PATH, then the usual install folders, then the copy inside the VS Code extension. */
export function findClaude(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env.CLAUDE_BIN?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const onPath = spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).stdout.trim();
  if (onPath) return onPath;
  for (const candidate of [path.join(homedir(), '.local', 'bin', 'claude'), path.join(homedir(), '.claude', 'local', 'claude')]) {
    if (existsSync(candidate)) return candidate;
  }
  for (const root of [path.join(homedir(), '.vscode-server', 'extensions'), path.join(homedir(), '.vscode', 'extensions')]) {
    if (!existsSync(root)) continue;
    const versions = readdirSync(root)
      .filter((d) => d.startsWith('anthropic.claude-code-'))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) {
      const bin = path.join(root, v, 'resources', 'native-binary', 'claude');
      if (existsSync(bin)) return bin;
    }
  }
  return undefined;
}

export type ClaudeStatus = {
  found: boolean;
  version?: string;
  loggedIn?: boolean;
  plan?: string;
  problem?: string;
};

export function claudeStatus(bin: string | undefined): ClaudeStatus {
  if (!bin) {
    return { found: false, problem: 'Claude Code was not found. Install it, or set CLAUDE_BIN to the claude binary.' };
  }
  const version = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15_000 }).stdout.trim();
  const auth = spawnSync(bin, ['auth', 'status'], { encoding: 'utf8', timeout: 15_000 });
  try {
    const parsed = JSON.parse(auth.stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
    return {
      found: true,
      version,
      loggedIn: parsed.loggedIn === true,
      plan: parsed.subscriptionType ?? parsed.authMethod,
      problem: parsed.loggedIn ? undefined : 'Claude Code is not logged in. Run: claude auth login',
    };
  } catch {
    return { found: true, version, problem: 'Could not read Claude Code login status.' };
  }
}
