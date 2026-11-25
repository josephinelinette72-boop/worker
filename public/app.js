// Agent Console page. Plain JavaScript, no build step.
//
// Everything the agents write is untrusted (they read blockchain data and the
// web), so this file only ever inserts it as text. The one exception is the
// Markdown renderer, which escapes every character before adding formatting.
'use strict';

const TOKEN = document.querySelector('meta[name="console-token"]').content;
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- helpers

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-console-token': TOKEN, ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

/** el('div', {class: 'x'}, 'text', childNode): text children are always text nodes. */
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function showMessage(message, good = false) {
  const banner = $('banner');
  banner.textContent = message instanceof Error ? message.message : String(message);
  banner.classList.toggle('good', good);
  banner.hidden = false;
  clearTimeout(showMessage.timer);
  showMessage.timer = setTimeout(() => (banner.hidden = true), 8000);
}
const showError = (error) => showMessage(error, false);

const short = (addr) => (addr && addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr || '');
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '');

async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const old = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => (button.textContent = old), 1500);
  } catch {
    showError('The browser blocked the clipboard. Select the text and copy it by hand.');
  }
}

// ---------------------------------------------------------------- markdown (safe subset)

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function inline(s) {
  // s is already escaped. Only add tags around escaped text.
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function markdown(src) {
  const lines = escapeHtml(src).split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push(`<pre>${code.join('\n')}</pre>`);
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().slice(1, -1).split('|').map((c) => inline(c.trim()));
      const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
      const [head, ...rest] = body;
      out.push(
        `<div class="table"><table><thead><tr>${cells(head).map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>` +
          rest.map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('') +
          '</tbody></table></div>',
      );
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''));
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|```|\s*\||\s*([-*]|\d+\.)\s)/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('');
}

function mdNode(src, cls = 'md') {
  const div = el('div', { class: cls });
  div.innerHTML = markdown(src); // safe: markdown() escapes all input first
  return div;
}

// ---------------------------------------------------------------- run feed

function describeArgs(name, input) {
  if (!input || typeof input !== 'object') return '';
  if (name === 'submit_campaign') return `${input.name || ''} · ${(input.assets || []).length} pieces`;
  if (name === 'notify_human') return `[${input.severity}] ${input.title}`;
  if (name === 'save_report') return input.title || '';
  if (name === 'WebSearch') return input.query || '';
  if (name === 'WebFetch') return input.url || '';
  const parts = Object.entries(input).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return parts.join(' ');
}

function resultTag(name, text, isError) {
  if (isError || /^Error:/.test(text)) return el('span', { class: 'tag bad' }, 'error');
  if (/^No app data is connected/.test(text)) return el('span', { class: 'tag wait' }, 'no app data yet');
  if (name === 'submit_campaign') {
    try {
      const r = JSON.parse(text);
      return r.accepted ? el('span', { class: 'tag ok' }, '✓ queued for review') : el('span', { class: 'tag bad' }, '✗ honesty check: rewrite');
    } catch { /* not JSON */ }
  }
  if (name === 'check_accounting') {
    try {
      const r = JSON.parse(text);
      return r.alerts ? el('span', { class: 'tag bad' }, `${r.alerts} alert(s)`) : el('span', { class: 'tag ok' }, 'all ok');
    } catch { /* not JSON */ }
  }
  return el('span', { class: 'tag ok' }, 'done');
}

function prettyResult(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

/** Renders events into a feed list. Returns a function that takes one event. */
function feedRenderer(list, onEnd) {
  list.replaceChildren();
  const tools = new Map();
  const startedAt = Date.now();
  const stick = () => {
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    return () => { if (nearBottom) list.scrollTop = list.scrollHeight; };
  };
  return (e) => {
    const scroll = stick();
    switch (e.kind) {
      case 'start':
        list.append(el('li', { class: 'ev-start' }, `Started${e.model ? ` · ${e.model}` : ''} · tools: ${e.tools.join(', ') || 'none'}`));
        break;
      case 'thinking':
        list.append(el('li', { class: 'ev-thinking' }, e.text));
        break;
      case 'text':
        list.append(el('li', { class: 'ev-text' }, mdNode(e.text)));
        break;
      case 'tool': {
        const tag = el('span', { class: 'tag wait' }, 'running…');
        const body = el('div');
        const details = el('details', {},
          el('summary', {}, el('span', { class: 'name' }, `→ ${e.name}`), el('span', { class: 'args' }, describeArgs(e.name, e.input)), tag),
          el('pre', {}, JSON.stringify(e.input, null, 2)),
          body,
        );
        tools.set(e.id, { name: e.name, tag, body });
        list.append(el('li', { class: 'ev-tool' }, details));
        break;
      }
      case 'result': {
        const t = tools.get(e.id);
        if (!t) break;
        t.tag.replaceWith(resultTag(t.name, e.text, e.isError));
        t.body.append(el('pre', {}, prettyResult(e.text)));
        break;
      }
      case 'done': {
        const secs = e.durationMs ? Math.round(e.durationMs / 1000) : Math.round((Date.now() - startedAt) / 1000);
        list.append(el('li', { class: 'ev-end' }, `${e.ok ? 'Finished' : 'Ended with a problem'} · ${secs}s${e.turns ? ` · ${e.turns} turns` : ''}`));
        break;
      }
      case 'error':
        list.append(el('li', { class: 'ev-error' }, e.text));
        break;
      case 'end':
        if (onEnd) onEnd(e.status);
        break;
    }
    scroll();
  };
}

/** Follow a run live (or replay a finished one). */
function follow(runId, { list, status, stop, title, label, onEnd }) {
  if (title) title.textContent = label || 'Run';
  const setStatus = (s) => {
    if (!status) return;
    status.className = `status ${s}`;
    status.textContent = { running: 'Running', done: 'Done', failed: 'Failed', stopped: 'Stopped' }[s] || s;
  };
  setStatus('running');
  if (stop) {
    stop.hidden = false;
    stop.onclick = () => api(`/api/runs/${runId}/stop`, { method: 'POST' }).catch(showError);
  }
  const source = new EventSource(`/api/runs/${runId}/events?token=${encodeURIComponent(TOKEN)}`);
  const finish = (final) => {
    setStatus(final);
    if (stop) stop.hidden = true;
    source.close();
    if (onEnd) onEnd(final);
  };
  // The server replays the whole run on every connection, so after a dropped
  // connection the browser reconnects and the feed is rebuilt from scratch.
  let render = feedRenderer(list, finish);
  source.onopen = () => { render = feedRenderer(list, finish); };
  source.onmessage = (m) => render(JSON.parse(m.data));
  return source;
}

// ---------------------------------------------------------------- status bar

async function loadStatus() {
  const s = await api('/api/status');
  const pills = [];
  const c = s.claude;
  if (!c.found) pills.push(el('span', { class: 'pill bad' }, 'Claude Code not found'));
  else if (!c.loggedIn) pills.push(el('span', { class: 'pill bad' }, 'Claude Code: not logged in'));
  else pills.push(el('span', { class: 'pill ok', title: `Claude Code ${c.version || ''}` }, `Claude Code · ${c.plan || 'logged in'}`));
  pills.push(
    s.wallet.connected
      ? el('span', { class: 'pill ok', title: s.wallet.property || '' }, `App data: ${s.wallet.chain}${s.wallet.property ? ` · ${short(s.wallet.property)}` : ''}`)
      : el('span', { class: 'pill' }, 'App data: not connected'),
  );
  $('pills').replaceChildren(...pills);
  $('data-line').replaceChildren(
    s.wallet.connected
      ? el('span', {}, `Live data: ${s.wallet.chain}${s.wallet.property ? `, property ${short(s.wallet.property)}` : ''}.`)
      : el('span', { class: 'muted' }, 'Live app data: not connected yet, so answers come from expertise. Set OPS_CONNECT=true in ~/wallet/.env to connect.'),
  );
  if (c.problem) showError(c.problem);
}

// ---------------------------------------------------------------- tabs

function selectTab(buttons, attr, value, onShow) {
  for (const b of buttons) b.setAttribute('aria-selected', String(b.dataset[attr] === value));
  onShow(value);
}

const views = ['ops', 'marketing', 'history'];
for (const b of document.querySelectorAll('.tabs button')) {
  b.addEventListener('click', () =>
    selectTab(document.querySelectorAll('.tabs button'), 'view', b.dataset.view, (v) => {
      for (const id of views) $(`view-${id}`).hidden = id !== v;
      if (v === 'history') loadRuns().catch(showError);
      if (v === 'marketing') loadCampaigns().catch(showError);
      try { localStorage.setItem('console-view', v); } catch { /* storage off */ }
    }),
  );
}

// ---------------------------------------------------------------- operations

for (const b of document.querySelectorAll('#view-ops .subtabs button')) {
  b.addEventListener('click', () =>
    selectTab(document.querySelectorAll('#view-ops .subtabs button'), 'sub', b.dataset.sub, (s) => {
      for (const id of ['reports', 'alerts', 'proposals']) $(`sub-${id}`).hidden = id !== s;
    }),
  );
}

async function loadOps() {
  const [reports, alerts, proposals] = await Promise.all([api('/api/ops/reports'), api('/api/ops/alerts'), api('/api/ops/proposals')]);

  const rl = $('reports-list');
  rl.replaceChildren(
    ...(reports.length
      ? reports.map((r, idx) => {
          const li = el('li', { class: 'pick' }, el('div', {}, r.title), el('div', { class: 'meta' }, r.name.replace('.md', '').replace('T', ' ')));
          li.addEventListener('click', () => openReport(r.name, li).catch(showError));
          if (idx === 0 && !rl.dataset.opened) queueMicrotask(() => openReport(r.name, li).catch(showError));
          return li;
        })
      : [el('li', { class: 'empty' }, 'No reports yet. Run a health check.')]),
  );

  $('alerts-count').textContent = alerts.length ? String(alerts.length) : '';
  $('alerts-list').replaceChildren(
    ...(alerts.length
      ? alerts.map((a) =>
          el('li', {},
            el('div', {}, el('span', { class: `sev ${a.severity}` }, a.severity), a.title),
            el('div', { class: 'meta' }, `${when(a.at)} · ${a.chain || ''}`),
            a.details ? mdNode(a.details) : null,
          ),
        )
      : [el('li', { class: 'empty' }, 'No alerts.')]),
  );

  $('proposals-count').textContent = proposals.length ? String(proposals.length) : '';
  $('proposals-list').replaceChildren(
    ...(proposals.length
      ? proposals.map((p) => {
          const tx = (p.file.transactions || [])[0] || {};
          const json = JSON.stringify(p.file, null, 2);
          const copyBtn = el('button', { class: 'small' }, 'Copy JSON');
          copyBtn.addEventListener('click', () => copy(json, copyBtn));
          return el('li', {},
            el('div', {}, el('strong', {}, p.file.meta?.name || p.name)),
            el('div', { class: 'meta' }, `chain ${p.file.chainId} · to ${short(tx.to)} · value ${tx.value} wei · ${new Date(p.file.createdAt).toLocaleString()}`),
            el('p', {}, p.file.meta?.description || ''),
            el('div', { class: 'row' }, copyBtn),
            el('details', {}, el('summary', { class: 'muted' }, 'Show file'), el('pre', {}, json)),
          );
        })
      : [el('li', { class: 'empty' }, 'No proposals. The agent drafts one only with live data and clear evidence.')]),
  );
}

async function openReport(name, li) {
  $('reports-list').dataset.opened = '1';
  for (const x of $('reports-list').children) x.classList.toggle('active', x === li);
  const { markdown: md } = await api(`/api/ops/reports/${encodeURIComponent(name)}`);
  $('report-view').replaceChildren(mdNode(md));
}

async function startOps(question) {
  try {
    const run = await api('/api/runs', { method: 'POST', body: JSON.stringify({ agent: 'ops', question }) });
    showOpsRun(run);
  } catch (error) { showError(error); }
}

function showOpsRun(run) {
  $('ops-feed-card').hidden = false;
  $('ops-health').disabled = true;
  follow(run.id, {
    list: $('ops-feed'), status: $('ops-feed-status'), stop: $('ops-stop'), title: $('ops-feed-title'), label: run.title,
    onEnd: () => {
      $('ops-health').disabled = false;
      delete $('reports-list').dataset.opened;
      loadOps().catch(showError);
    },
  });
}

$('ops-health').addEventListener('click', () => startOps(''));
$('ops-ask').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const q = $('ops-question').value.trim();
  if (q) startOps(q);
});

// ---------------------------------------------------------------- marketing

let queueTab = 'pending';
for (const b of document.querySelectorAll('#view-marketing .subtabs button')) {
  b.addEventListener('click', () =>
    selectTab(document.querySelectorAll('#view-marketing .subtabs button'), 'q', b.dataset.q, (q) => {
      queueTab = q;
      loadCampaigns().catch(showError);
    }),
  );
}

async function loadBrands() {
  const brands = await api('/api/marketing/brands');
  const select = $('mkt-brand');
  const current = select.value;
  select.replaceChildren(
    el('option', { value: '' }, 'None: anything goes'),
    ...brands.map((b) => el('option', { value: b.id }, `${b.name}${b.regulated ? ' (regulated)' : ''}`)),
  );
  select.value = current;
}

function assetCard(a, index) {
  const copyBtn = el('button', { class: 'small' }, 'Copy');
  copyBtn.addEventListener('click', () => copy([a.title, a.body].filter(Boolean).join('\n\n'), copyBtn));
  return el('li', { class: 'asset' },
    el('div', { class: 'asset-head' },
      el('span', { class: 'channel' }, a.channel),
      el('span', { class: 'when' }, [`#${index + 1}`, a.when].filter(Boolean).join(' · ')),
      a.channel === 'x' ? el('span', { class: 'muted small-text' }, `${a.body.length}/280`) : null,
      copyBtn,
    ),
    a.title ? el('div', { class: 'asset-title' }, a.title) : null,
    el('div', { class: 'draft-body' }, a.body),
    a.imagePrompt ? el('div', { class: 'draft-why' }, `Image: ${a.imagePrompt}`) : null,
  );
}

function campaignCard(c, status) {
  const actions = el('div', { class: 'draft-actions' });
  if (status === 'pending') {
    const reason = el('input', { placeholder: 'Why reject? The agent learns from this.', hidden: true });
    const approve = el('button', { class: 'ok' }, 'Approve');
    const reject = el('button', { class: 'bad' }, 'Reject');
    const confirm = el('button', { class: 'bad', hidden: true }, 'Confirm reject');
    approve.addEventListener('click', () => review(c.id, 'approve'));
    reject.addEventListener('click', () => { reason.hidden = false; confirm.hidden = false; reject.hidden = true; reason.focus(); });
    confirm.addEventListener('click', () => review(c.id, 'reject', reason.value));
    actions.append(approve, reject, reason, confirm);
  }
  const copyAll = el('button', { class: 'small' }, 'Copy whole campaign');
  copyAll.addEventListener('click', () => copy(c.markdown, copyAll));
  actions.append(copyAll);

  return el('li', { class: 'draft' },
    el('div', { class: 'draft-head' },
      el('span', { class: 'draft-title' }, c.name),
      c.brand ? el('span', { class: 'channel' }, c.brand) : null,
      el('span', { class: 'muted small-text' }, when(c.createdAt)),
      c.publishedAt ? el('span', { class: 'tag ok' }, 'exported') : null,
    ),
    el('div', { class: 'muted' }, c.subject),
    el('dl', { class: 'facts' },
      el('dt', {}, 'Goal'), el('dd', {}, c.goal),
      el('dt', {}, 'Audience'), el('dd', {}, c.audience),
      el('dt', {}, 'Key message'), el('dd', {}, c.keyMessage),
    ),
    mdNode(c.strategy),
    el('details', { class: 'more' },
      el('summary', {}, `Timeline (${c.timeline.length})`),
      el('ul', {}, c.timeline.map((t) => el('li', {}, el('strong', {}, `${t.when}: `), t.what))),
    ),
    el('ul', { class: 'assets' }, c.assets.map(assetCard)),
    el('details', { class: 'more' },
      el('summary', {}, 'Measuring it, budget, sources'),
      el('ul', {}, c.metrics.map((m) => el('li', {}, m))),
      c.budgetNotes ? el('p', {}, `Budget: ${c.budgetNotes}`) : null,
      c.sources?.length ? el('ul', {}, c.sources.map((s) => el('li', {}, s))) : null,
    ),
    c.compliance?.notes ? el('div', { class: 'draft-note' }, `Reviewer notes: ${c.compliance.notes}`) : null,
    status === 'rejected' && c.review?.reason ? el('div', { class: 'draft-note' }, `Rejected: ${c.review.reason}`) : null,
    actions,
  );
}

async function loadCampaigns() {
  const q = await api('/api/marketing/campaigns');
  for (const s of ['pending', 'approved', 'rejected']) $(`q-${s}`).textContent = q[s].length ? String(q[s].length) : '';
  $('publish-row').hidden = queueTab !== 'approved' || !q.approved.some((c) => !c.publishedAt);
  const items = q[queueTab];
  const empty = {
    pending: 'Nothing to review. Build a campaign.',
    approved: 'Nothing approved yet.',
    rejected: 'Nothing rejected.',
  }[queueTab];
  $('campaigns').replaceChildren(...(items.length ? items.map((c) => campaignCard(c, queueTab)) : [el('li', { class: 'empty' }, empty)]));
}

async function review(id, decision, reason) {
  try {
    await api(`/api/marketing/campaigns/${id}/review`, { method: 'POST', body: JSON.stringify({ decision, reason }) });
    await loadCampaigns();
  } catch (error) { showError(error); }
}

$('publish-btn').addEventListener('click', async () => {
  try {
    const done = await api('/api/marketing/publish', { method: 'POST' });
    showMessage(`${done.length} campaign(s) written to marketing-agent/outbox/.`, true);
    await loadCampaigns();
  } catch (error) { showError(error); }
});

$('mkt-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const subject = $('mkt-subject').value.trim();
  if (!subject) return showError('Say what the campaign is for.');
  try {
    const run = await api('/api/runs', {
      method: 'POST',
      body: JSON.stringify({
        agent: 'marketing',
        subject,
        brief: $('mkt-brief').value,
        brand: $('mkt-brand').value,
        web: $('mkt-web').checked,
      }),
    });
    showMarketingRun(run);
  } catch (error) { showError(error); }
});

function showMarketingRun(run) {
  $('mkt-feed-card').hidden = false;
  const submit = $('mkt-form').querySelector('button[type="submit"]');
  submit.disabled = true;
  follow(run.id, {
    list: $('mkt-feed'), status: $('mkt-feed-status'), stop: $('mkt-stop'), title: $('mkt-feed-title'), label: run.title,
    onEnd: () => { submit.disabled = false; loadCampaigns().catch(showError); },
  });
}

// ---------------------------------------------------------------- history

async function loadRuns() {
  const runs = await api('/api/runs');
  $('runs-list').replaceChildren(
    ...(runs.length
      ? runs.map((r) => {
          const li = el('li', { class: 'pick' },
            el('div', {}, el('span', { class: `status ${r.status}` }, r.status), ' ', r.title),
            el('div', { class: 'meta' }, `${r.agent} · ${when(r.startedAt)}`),
          );
          li.addEventListener('click', () => {
            for (const x of $('runs-list').children) x.classList.toggle('active', x === li);
            follow(r.id, { list: $('history-feed') });
          });
          return li;
        })
      : [el('li', { class: 'empty' }, 'No runs yet.')]),
  );
}

// ---------------------------------------------------------------- start

(async function init() {
  try {
    await loadStatus();
    await Promise.all([loadOps(), loadBrands()]);
    await loadCampaigns();
    // Re-attach to a run that is still going (for example after a reload).
    const runs = await api('/api/runs');
    const ops = runs.find((r) => r.agent === 'ops' && r.status === 'running');
    const mkt = runs.find((r) => r.agent === 'marketing' && r.status === 'running');
    if (ops) showOpsRun(ops);
    if (mkt) showMarketingRun(mkt);
    let saved;
    try { saved = localStorage.getItem('console-view'); } catch { /* storage off */ }
    if (saved && views.includes(saved)) document.querySelector(`.tabs button[data-view="${saved}"]`).click();
  } catch (error) {
    showError(error);
  }
})();
