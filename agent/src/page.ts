export const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gate Check — can this power bank fly?</title>
<style>
  :root { --bg:#f7f6f2; --ink:#1b1a17; --muted:#6a665d; --line:#e2ded5; --accent:#0f766e; --card:#fff; --ok:#15803d; --warn:#b45309; --bad:#b91c1c; }
  @media (prefers-color-scheme: dark) { :root { --bg:#151514; --ink:#ebe8e1; --muted:#a29d93; --line:#33312c; --accent:#2dd4bf; --card:#1e1d1b; --ok:#4ade80; --warn:#fbbf24; --bad:#f87171; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 780px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 28px; margin: 0 0 4px; letter-spacing: -0.01em; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 28px 0 10px; }
  .lede { color: var(--muted); margin: 0 0 8px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 4px; }
  input, select, textarea { width: 100%; padding: 9px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--ink); font: inherit; }
  .row { display: flex; gap: 8px; margin-top: 12px; }
  button { padding: 10px 18px; border: 0; border-radius: 9px; background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  @media (prefers-color-scheme: dark) { button { color: #04201d; } }
  button:disabled { opacity: .6; cursor: progress; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 0; }
  .chip { background: var(--card); color: var(--ink); border: 1px solid var(--line); padding: 6px 10px; border-radius: 999px; font-size: 14px; font-weight: 400; }
  pre { white-space: pre-wrap; word-break: break-word; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; }
  .out { margin-top: 12px; display: none; }
  .out p { margin: 0 0 10px; }
  .out ul { margin: 0 0 10px; padding-left: 20px; }
  .out a { color: var(--accent); }
  .pill { display: inline-block; padding: 2px 10px; border-radius: 999px; border: 1px solid currentColor; font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; white-space: nowrap; }
  .pill.ok { color: var(--ok); } .pill.warn { color: var(--warn); } .pill.bad { color: var(--bad); }
  .pill.big { font-size: 15px; padding: 5px 14px; }
  .verdict { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 6px; }
  .battery { color: var(--muted); font-size: 14px; }
  .rule { border-top: 1px solid var(--line); padding: 14px 0 6px; }
  .rule-head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .meta { color: var(--muted); font-size: 13px; margin-top: 2px; }
  .flag { color: var(--warn); font-weight: 600; }
  .out .rule ul { margin: 8px 0; }
  .rule li { margin: 4px 0; }
  blockquote { margin: 6px 0 4px; padding: 4px 10px; border-left: 3px solid var(--line); color: var(--muted); font-size: 14px; }
  .note { font-size: 14px; padding: 8px 10px; border: 1px dashed var(--line); border-radius: 8px; }
  .src { font-size: 14px; color: var(--muted); }
  .sub { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; margin: 10px 0 2px !important; }
  details { margin-top: 12px; color: var(--muted); font-size: 14px; }
  details li { margin: 4px 0; word-break: break-word; }
  .kind { color: var(--muted); font-size: 13px; }
  .error { color: var(--bad); }
  .live { color: var(--muted); }
  .out ul.steps { list-style: none; padding-left: 0; color: var(--muted); font-size: 14px; }
  footer { margin-top: 40px; color: var(--muted); font-size: 13px; }
  footer a { color: inherit; }
</style>
</head>
<body>
<main>
  <h1>Gate Check</h1>
  <p class="lede">Can this power bank fly? Rules from airlines, regulators and IATA, kept in Sanity with the exact wording behind every number, evaluated in code, and explained by an agent that points out where the sources disagree.</p>

  <h2>Quick check (no AI, the rule engine alone)</h2>
  <form id="check" class="card">
    <div class="grid">
      <div><label for="cap">Capacity</label><input id="cap" type="number" min="1" step="any" value="20000" required></div>
      <div><label for="unit">Unit</label><select id="unit"><option value="mAh">mAh</option><option value="wh">Wh</option></select></div>
      <div><label for="volts">Voltage (if on the label)</label><input id="volts" type="number" min="1" step="any" placeholder="3.7"></div>
      <div><label for="count">How many</label><input id="count" type="number" min="1" value="1"></div>
    </div>
    <div class="grid" style="margin-top:10px">
      <div><label for="airlines">Airlines on the trip (comma separated)</label><input id="airlines" list="airline-list" value="Korean Air, Delta"><datalist id="airline-list"></datalist></div>
      <div><label for="from">Departure countries (codes)</label><input id="from" value="KR, US"></div>
    </div>
    <div class="row"><button id="checkGo" type="submit">Check</button></div>
    <div id="checkOut" class="out card"></div>
  </form>

  <h2>Ask the agent</h2>
  <form id="ask" class="card">
    <textarea id="q" maxlength="500" rows="2" placeholder="I'm flying Seoul to New York on Korean Air with a 27,000 mAh power bank. OK?" required></textarea>
    <div class="chips" id="chips"></div>
    <div class="row"><button id="askGo" type="submit">Ask</button></div>
    <div id="askOut" class="out"></div>
  </form>

  <footer>Built on Sanity Context (a Knowledge Base endpoint and a GROQ endpoint), GPT-5.5 and Cloudflare Workers. Rules change often: always check with your airline. <a href="https://github.com/mikey92/gate-check">Source</a>.</footer>
</main>
<script>
const examples = [
  "I'm flying Seoul to San Francisco on Korean Air with two 20,000 mAh power banks. Can I use them on board?",
  "Can I bring a 27,000 mAh laptop power bank on Asiana?",
  "Why do airline pages and the FAA disagree about using power banks in flight?",
  "Which airlines ban power banks from the overhead bin?",
];
const chips = document.getElementById('chips');
for (const text of examples) {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = text;
  b.onclick = () => { document.getElementById('q').value = text; ask(); };
  chips.appendChild(b);
}
fetch('/api/authorities').then((r) => r.json()).then((list) => {
  const dl = document.getElementById('airline-list');
  for (const a of list.filter((a) => a.kind === 'airline')) { const o = document.createElement('option'); o.value = a.name; dl.appendChild(o); }
}).catch(() => {});

const split = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
document.getElementById('check').onsubmit = async (e) => {
  e.preventDefault();
  const out = document.getElementById('checkOut'); const go = document.getElementById('checkGo');
  const cap = Number(document.getElementById('cap').value); const unit = document.getElementById('unit').value;
  const volts = Number(document.getElementById('volts').value) || undefined;
  const body = { count: Number(document.getElementById('count').value) || 1, airlines: split(document.getElementById('airlines').value), departFrom: split(document.getElementById('from').value), volts };
  if (unit === 'wh') body.wh = cap; else body.mAh = cap;
  go.disabled = true; out.style.display = 'block'; out.textContent = 'Checking…';
  try {
    const res = await fetch('/api/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    out.innerHTML = data.report ? renderReport(data.report) : '<pre>' + esc(data.result) + '</pre>';
  } catch (err) { out.innerHTML = '<p class="error">' + esc(err.message) + '</p>'; }
  finally { go.disabled = false; }
};

document.getElementById('ask').onsubmit = (e) => { e.preventDefault(); ask(); };
// The answer arrives as server-sent events: each tool call as it finishes, the rule engine's verdict, then the answer.
async function ask() {
  const question = document.getElementById('q').value.trim();
  if (!question) return;
  const go = document.getElementById('askGo'); const out = document.getElementById('askOut');
  go.disabled = true; go.textContent = 'Reading…'; out.style.display = 'block';
  out.innerHTML = '<p class="live">Reading the rules… <span id="tick">0s</span></p><ul class="steps" id="liveSteps"></ul><div id="liveReport"></div>';
  const started = Date.now();
  const tick = setInterval(() => { const t = document.getElementById('tick'); if (t) t.textContent = Math.round((Date.now() - started) / 1000) + 's'; }, 500);
  const finish = (data) => {
    const steps = data.steps.map((s) => '<li><b>' + esc(s.tool) + '</b> — ' + esc(s.summary) + '</li>').join('');
    // Broad questions can rest on thirty pages: the first six show, the rest fold away.
    const pages = data.sources || [];
    const list = (items) => '<ul>' + items.map((s) => '<li>' + link(s) + '</li>').join('') + '</ul>';
    const more = pages.length > 6 ? '<details><summary>Show ' + (pages.length - 6) + ' more pages</summary>' + list(pages.slice(6)) + '</details>' : '';
    const sources = pages.length ? '<p class="sub">Pages behind this answer</p>' + list(pages.slice(0, 6)) + more : '';
    const engine = data.report ? '<details><summary>The rule engine’s check, rule by rule</summary>' + renderReport(data.report) + '</details>' : '';
    const how = data.steps.length + (data.steps.length === 1 ? ' tool call, ' : ' tool calls, ') + (data.ms / 1000).toFixed(1) + 's' + (data.cached ? ' when first asked, saved answer' : '') + ', ' + esc(data.model);
    out.innerHTML = render(data.answer) + sources + engine + '<details><summary>What the agent did (' + how + ')</summary><ol>' + steps + '</ol></details>';
  };
  const show = (name, data) => {
    if (name === 'step') {
      const li = document.createElement('li'); li.textContent = '✓ ' + data.summary;
      const list = document.getElementById('liveSteps'); if (list) list.appendChild(li);
    } else if (name === 'report') {
      const box = document.getElementById('liveReport');
      if (box) box.innerHTML = '<p class="sub">The rule engine’s verdict, while the agent writes its answer</p>' + renderReport(data);
    } else if (name === 'answer') finish(data);
    else if (name === 'error') throw new Error(data.error);
  };
  try {
    const res = await fetch('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify({ question }) });
    if (!res.ok || !res.body) { const data = await res.json().catch(() => ({})); throw new Error(data.error || res.statusText); }
    const reader = res.body.getReader(); const decoder = new TextDecoder(); const NL = String.fromCharCode(10);
    let buffer = ''; let answered = false;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf(NL + NL)) >= 0) {
        const block = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
        let name = ''; let payload = '';
        for (const line of block.split(NL)) {
          if (line.startsWith('event: ')) name = line.slice(7);
          else if (line.startsWith('data: ')) payload += line.slice(6);
        }
        if (name && payload) { show(name, JSON.parse(payload)); if (name === 'answer') answered = true; }
      }
    }
    if (!answered) throw new Error('The connection closed before the answer arrived. Please try again.');
  } catch (err) { out.innerHTML = '<p class="error">' + esc(err.message) + '</p>'; }
  finally { clearInterval(tick); go.disabled = false; go.textContent = 'Ask'; }
}

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
// The rule engine's report: one card per rule, strictest first, each finding with the quoted wording it rests on.
const VERDICTS = { allowed: ['ok', 'Allowed'], conditions: ['ok', 'Conditions only'], approval: ['warn', 'Needs airline approval'], forbidden: ['bad', 'Not allowed'], unknown: ['warn', 'Unknown'] };
const SCOPES = { carrier: 'airline rule', departing: 'departure country', domestic: 'domestic flights', worldwide: 'worldwide standard', guidance: 'guidance, not counted' };
function pill(verdict, big) { const v = VERDICTS[verdict] || VERDICTS.unknown; return '<span class="pill ' + v[0] + (big ? ' big' : '') + '">' + v[1] + '</span>'; }
const KINDS = {news: 'news', aggregator: 'third-party copy'};
function link(source) { return source ? '<a href="' + esc(source.url) + '" target="_blank" rel="noopener">' + esc(source.title) + '</a>' + (KINDS[source.kind] ? ' <span class="kind">(' + KINDS[source.kind] + ')</span>' : '') : ''; }
function quote(q) { return '<blockquote>“' + esc(q.text) + '” — ' + link(q.source) + '</blockquote>'; }
function ruleCard(r) {
  const meta = [SCOPES[r.scope] || r.scope, r.effectiveFrom ? 'effective ' + r.effectiveFrom : ''].filter(Boolean).map(esc).join(' · ')
    + (r.status === 'disputed' ? ' · <span class="flag">sources disagree</span>' : r.status === 'unverified' ? ' · <span class="flag">unverified</span>' : '');
  const reasons = r.reasons.map((f) => '<li>' + esc(f.text) + f.quotes.map(quote).join('') + '</li>').join('');
  const onboard = r.advisories.length ? '<p class="sub">On board</p><ul>' + r.advisories.map((f) => '<li>' + esc(f.text) + '</li>').join('') + '</ul>' : '';
  const wording = r.advisories.flatMap((f) => f.quotes);
  const more = wording.length ? '<details><summary>The wording behind these conditions</summary>' + wording.map(quote).join('') + '</details>' : '';
  return '<article class="rule"><div class="rule-head">' + pill(r.verdict) + '<b>' + esc(r.authority) + '</b><span>' + esc(r.title) + '</span></div>'
    + '<div class="meta">' + meta + '</div><ul>' + reasons + '</ul>' + onboard + more
    + (r.note ? '<p class="note">' + esc(r.note) + '</p>' : '')
    + (r.source ? '<p class="src">Source: ' + link(r.source) + '</p>' : '') + '</article>';
}
function renderReport(rep) {
  const b = rep.battery;
  const battery = b.wh + ' Wh × ' + b.count + (b.assumedVolts ? ' (computed from mAh at an assumed ' + b.assumedVolts + ' V; the Wh printed on the label wins)' : '');
  const why = rep.decidedBy ? 'Strictest rule: ' + esc(rep.decidedBy) : rep.rules.length ? 'Every rule below allows it, with the on-board conditions listed.' : 'No binding rule matched this trip.';
  const unmatched = rep.unmatched.length ? '<p class="note">No stored rules for ' + esc(rep.unmatched.join(', ')) + '. Check that airline’s own page.</p>' : '';
  const guidance = rep.guidance.length ? '<details><summary>Advisory guidance, not counted in the verdict (' + rep.guidance.length + ')</summary>' + rep.guidance.map(ruleCard).join('') + '</details>' : '';
  return '<div class="verdict">' + pill(rep.overall, true) + '<span>' + why + '</span></div><p class="battery">' + esc(battery) + '</p>' + unmatched + rep.rules.map(ruleCard).join('') + guidance;
}
// Small Markdown subset: paragraphs, bullet lists, bold, inline code and links (http/https only).
function render(md) {
  const inline = (t) => esc(t)
    .replace(/\\*\\*(.+?)\\*\\*/g, '<b>$1</b>')
    .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
    .replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const html = []; let list = null;
  for (const line of md.split('\\n')) {
    const item = line.match(/^\\s*(?:[-*]|\\d+\\.)\\s+(.*)/);
    if (item) { if (!list) { list = []; } list.push('<li>' + inline(item[1]) + '</li>'); continue; }
    if (list) { html.push('<ul>' + list.join('') + '</ul>'); list = null; }
    if (line.trim()) html.push('<p>' + inline(line.replace(/^#+\\s*/, '')) + '</p>');
  }
  if (list) html.push('<ul>' + list.join('') + '</ul>');
  return html.join('');
}
</script>
</body>
</html>`
