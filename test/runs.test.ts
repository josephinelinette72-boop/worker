import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeArgs, translate } from '../src/runs.ts';

const base = { agent: 'ops' as const, title: 't', cwd: '/w', prompt: 'go', agentName: 'ops-agent', mcpServer: 'ops' };

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

test('ops runs get no built-in tools and only their own MCP server', () => {
  const args = claudeArgs(base);
  assert.equal(flag(args, '--tools'), '');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(flag(args, '--mcp-config'), '/w/.mcp.json');
  assert.equal(flag(args, '--allowedTools'), 'mcp__ops');
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.ok(!args.some((a) => /bypass/i.test(a)));
});

test('marketing runs add only the web tools', () => {
  const args = claudeArgs({ ...base, mcpServer: 'marketing', extraTools: ['WebSearch', 'WebFetch'] });
  assert.equal(flag(args, '--tools'), 'WebSearch,WebFetch');
  assert.equal(flag(args, '--allowedTools'), 'mcp__marketing,WebSearch,WebFetch');
});

test('stream-json lines become simple events', () => {
  const p = 'mcp__ops__';
  assert.deepEqual(translate('not json', p), []);
  const init = translate(JSON.stringify({ type: 'system', subtype: 'init', model: 'm', tools: ['mcp__ops__get_context'] }), p);
  assert.equal(init[0]?.kind, 'start');
  assert.deepEqual((init[0] as { tools: string[] }).tools, ['get_context']);

  const assistant = translate(
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't1', name: 'mcp__ops__check_accounting', input: {} }] },
    }),
    p,
  );
  assert.deepEqual(assistant.map((e) => e.kind), ['text', 'tool']);
  assert.equal((assistant[1] as { name: string }).name, 'check_accounting');

  const result = translate(
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }] }] } }),
    p,
  );
  assert.deepEqual(result, [{ kind: 'result', id: 't1', text: 'ok', isError: false }]);

  const done = translate(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, duration_ms: 10, result: 'x' }), p);
  assert.equal(done[0]?.kind, 'done');
  assert.equal((done[0] as { ok: boolean }).ok, true);
});
