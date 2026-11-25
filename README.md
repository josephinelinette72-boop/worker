# Agent Console

A web page on your own computer for running and supervising your AI agents:

- **Operations**: the rental operations agent. Run a health check or ask anything
  about running tokenized rentals, and watch every step live. Read its reports
  (playbooks, checklists, health checks), alerts, and drafted Safe transactions.
  It works from expertise until your app's data is connected.
- **Marketing**: build a full campaign for anything. Watch it research and write,
  then approve or reject it (with a reason it learns from), copy any piece, or
  export the whole thing.
- **History**: replay any past run step by step.

The agents run through **Claude Code on your Claude plan** (Pro or Max). You
don't need an API key. Runs count toward your plan's usage limits.

## Start it

```bash
cd ~/agent-console
npm install          # first time only
npm start
```

Then open **http://localhost:4747** in your browser. On Windows with WSL,
the Windows browser reaches it at the same address.

The ops agent needs no chain until you connect your app (`OPS_CONNECT=true` in
`~/wallet/.env`). After that, start the chain first.

## How it is locked down

Each run starts `claude -p` with:

| Flag | Effect |
|---|---|
| `--tools` limited to `WebSearch,WebFetch` (marketing: optional) | No shell, no file reading or writing |
| `--strict-mcp-config --mcp-config <project>/.mcp.json` | Only that agent's own tool server |
| `--allowedTools mcp__ops` / `mcp__marketing` | Those tools run without prompts; nothing else exists |

So the ops agent can only search the web, read the chain (once connected), and
write reports, alerts, and proposal files. It has no key and cannot send a transaction. The marketing
agent can only search the web, read a brand pack if you chose one, and submit
campaigns. Every campaign must pass the honesty check, and nothing is published
without your click.
`test/runs.test.ts` checks these flags.

The page itself listens on `127.0.0.1` only, so other computers can't reach it.
It rejects requests that don't name `localhost` (which blocks DNS-rebinding
tricks), and every API call needs a random token that only this page has, so
other websites in your browser can't start runs or approve posts.

## Settings (environment variables)

| Variable | Default |
|---|---|
| `CONSOLE_PORT` | `4747` |
| `WALLET_DIR` | `~/wallet` |
| `MARKETING_DIR` | `~/marketing-agent` |
| `CLAUDE_BIN` | found automatically (PATH, `~/.local/bin`, or the VS Code extension) |

Run logs are saved in `runs/` (one JSON-lines file per run).
