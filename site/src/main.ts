import './styles.css';
import './touchstone.css';
import './ratings.css';
import { ascFirst, decodeView, DEFAULT_VIEW, encodeView, MAX_COMPARE } from './hashstate.ts';
import './detail.css';
import type { BenchmarkFile, SiteIndex, Summary } from '../../src/build.ts';
import type { Assessment, Benchmark, Item, Standard, Verdict } from '../../src/schema.ts';
import type { Improvement, Result } from '../../src/engine.ts';
import type { Rigor, RunProfile } from '../../src/touchstone.ts';

const main = document.getElementById('main')!;
const announcer = document.getElementById('announcer')!;

// ---------- Escaping: every value from the data is text, never markup ----------
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
class Raw { constructor(readonly s: string) {} }
const raw_ = (s: string) => new Raw(s);
function html(strings: TemplateStringsArray, ...vals: unknown[]): Raw {
  let out = strings[0]!;
  vals.forEach((v, i) => {
    const part = Array.isArray(v) ? v.map((x) => (x instanceof Raw ? x.s : esc(x))).join('') : v instanceof Raw ? v.s : v === false || v == null ? '' : esc(v);
    out += part + strings[i + 1]!;
  });
  return new Raw(out);
}
const safeUrl = (u: string) => (/^https:\/\//.test(u) ? u : '#');

// ---------- Data: index.json on load, everything else on demand, cached in memory ----------
const cache = new Map<string, Promise<any>>();
function getJson<T>(path: string): Promise<T> {
  let p = cache.get(path);
  if (!p) {
    p = fetch(`${import.meta.env.BASE_URL}data/${path}`).then((r) => {
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      return r.json();
    });
    cache.set(path, p);
    p.catch(() => cache.delete(path)); // a failed load can be retried
  }
  return p;
}
const prefetch = (path: string) => void getJson(path).catch(() => {});

let data!: SiteIndex;
type IStd = SiteIndex['standards'][number];
let standards = new Map<string, IStd>();
let encoded: IStd[] = [];
type B = SiteIndex['benchmarks'][number];
let benchmarks = new Map<string, B>();
let byPair = new Map<string, Summary[]>();
type A = Assessment & { file: string };
type R = Result & { file: string; improvements: Improvement[] };
const pairs = (b: string, s: string) => byPair.get(`${b}|${s}`) ?? [];
const inScope = (s: IStd, b: Benchmark) =>
  (!s.scope?.modalities || s.scope.modalities.includes(b.modality)) && (!s.scope?.domains || s.scope.domains.includes(b.domain));

/** m in "n of m standards": the encoded standards that apply to this benchmark (in scope, or already assessed), never fewer than n. */
const stdTotal = (b: Benchmark, n: number) => Math.max(n, encoded.filter((s) => pairs(b.id, s.id).length || inScope(s, b)).length);

/** The rating shown in the table: a reviewed record first, then an automated draft. */
const rank = (a: Summary) => (a.status === 'published' ? 0 : 1) * 10 + (a.kind === 'touchstone' ? 0 : a.kind === 'external' ? 1 : 2);
function primary(b: string, s: string, source: string): Summary | undefined {
  return pairs(b, s)
    .filter((a) => source === 'all' || (source === 'automated' ? a.kind === 'automated' : a.kind !== 'automated'))
    .sort((x, y) => rank(x) - rank(y))[0];
}

// ---------- Shared pieces ----------
const bar = (pct: number | null) => (pct === null ? '' : html`<div class="bar" aria-hidden="true"><span style="width:${Math.max(2, Math.min(100, pct))}%"></span></div>`);
/** Categories A-E get a sequential tint of the brand colour (A strongest); the letter is always in the text. */
function labelView(label: string, big = false) {
  const m = /^Category ([A-E])$/.exec(label);
  if (m) return html`<span class="badge badge-${m[1]!.toLowerCase()}${big ? ' badge-lg' : ''}">${label}</span>`;
  if (label === 'Unclassified') return html`<span class="badge badge-none${big ? ' badge-lg' : ''}">${label}</span>`;
  return html`<span class="font-semibold text-heading${big ? ' text-2xl' : ''}">${label}</span>`;
}
const chips = (p: Summary) => html`${p.discrepancies > 0 ? html`<span class="pill pill-diff" title="Published figure differs from recomputation"><span aria-hidden="true">≠</span><span class="sr-only">published figure differs</span></span>` : ''}${p.status === 'draft' ? html`<span class="pill pill-draft">draft</span>` : ''}`;
const provenanceLabel = (a: A) =>
  a.provenance.kind === 'external' ? `Published by ${a.provenance.assessors.join(', ')}`
  : a.provenance.kind === 'automated' ? `Automated (${a.model_run?.model ?? 'model'})`
  : `Touchstone assessment by ${a.provenance.assessors.join(', ')}`;
const skeleton = () => html`<div class="skel-page" role="status"><span class="sr-only">Loading</span>
  <div class="skel" style="height:2.25rem;width:55%"></div><div class="skel mt-4" style="height:1rem;width:80%"></div>
  <div class="skel mt-8" style="height:7rem"></div><div class="skel mt-4" style="height:7rem"></div><div class="skel mt-4" style="height:7rem"></div></div>`.s;

function announce(msg: string) { announcer.textContent = ''; requestAnimationFrame(() => (announcer.textContent = msg)); }

// ---------- Ratings: a plain table from 58rem up, a list of cards below ----------
const wide = matchMedia('(min-width: 58rem)');
const state = { ...DEFAULT_VIEW, lastBench: '' };
let wantSearch = false;

const MODALITY: Record<string, string> = { 'lm-agent': 'Language-model agent', 'language-model': 'Language model', 'rl-agent': 'Reinforcement-learning agent', classifier: 'Classifier', 'scientific-ml': 'Scientific ML' };
const modalityName = (m: string) => MODALITY[m] ?? m.replace(/-/g, ' ');
/** Only standards with at least one rating get a column, so the table has no empty ones. */
const ratedStds = () => encoded.filter((s) => data.summaries.some((a) => a.standard === s.id));
const unitOf = (s: IStd) => s.scoring?.scheme === 'aisl-severity' ? 'Category A (best) to E' : s.scoring?.scheme === 'points' ? `points out of ${s.scoring.max}` : 'share of applicable items met';
const stdTip = (s: IStd) => `${s.name}. ${s.description.split(/(?<=\.)\s/)[0]} Scored as: ${unitOf(s)}.`;
const BEST_VALUE = 'Best value: no other benchmark is both cheaper to run and rated more rigorous.';

function filteredBenchmarks(): B[] {
  const q = state.q.toLowerCase();
  const rows = [...benchmarks.values()].filter((b) =>
    (!q || b.name.toLowerCase().includes(q) || b.id.includes(q) || b.concept.toLowerCase().includes(q)) &&
    (!state.domain || b.domain === state.domain) && (!state.modality || b.modality === state.modality) && (!state.value || b.touchstone.onFrontier));
  const key = (b: B): number | string | null => {
    if (state.sort === 'name') return b.name.toLowerCase();
    if (state.sort === 'domain') return b.domain;
    if (state.sort === 'touchstone') return b.touchstone.rigor.score;
    if (state.sort === 'run') return b.touchstone.run?.tokens ?? null;
    return primary(b.id, state.sort, state.source)?.pct ?? -1;
  };
  return rows.sort((x, y) => {
    const a = key(x), c = key(y);
    if ((a === null) !== (c === null)) return a === null ? 1 : -1; // no data sorts last in either direction
    if (a === null || c === null) return x.name.localeCompare(y.name);
    const cmp = typeof a === 'number' && typeof c === 'number' ? a - c : String(a).localeCompare(String(c));
    return cmp * state.dir || x.name.localeCompare(y.name);
  });
}

const columns = () => [
  { key: 'name', label: 'Benchmark', tip: '' },
  { key: 'touchstone', label: 'Touchstone grade', tip: 'Median of the published ratings, A (best) to F. “n of m standards” is how many of the standards that apply to it the grade rests on.' },
  { key: 'run', label: 'Run cost', tip: 'Estimated cost of a full run as a $ band (tokens), plus the local setup needed. Cheapest first.' },
  ...ratedStds().map((s) => ({ key: s.id, label: s.short, tip: stdTip(s) })),
];
const defaultView = () => ({ q: '', domain: '', modality: '', source: 'all', value: '' });
const activeCount = () => Object.entries(defaultView()).filter(([k, d]) => state[k as keyof ReturnType<typeof defaultView>] !== d).length + (state.sort !== DEFAULT_VIEW.sort || state.dir !== DEFAULT_VIEW.dir ? 1 : 0);

/** Category A-E share the A-F grade ramp (.ts-grade-*); other standards print their own figure. */
function ratingLabel(label: string) {
  const m = /^Category ([A-E])$/.exec(label);
  if (m) return html`<span class="ts-grade ts-grade-${m[1]!.toLowerCase()}">${label}</span>`;
  if (label === 'Unclassified') return html`<span class="chip">${label}</span>`;
  return html`<span class="font-semibold text-heading">${label}</span>`;
}

function renderRatings() {
  const watch = data.watch;
  const rated = new Set(data.summaries.map((a) => a.benchmark)).size;
  const modalities = [...new Set([...benchmarks.values()].map((b) => b.modality))].sort();
  const stds = ratedStds();
  main.innerHTML = html`
    <h1 class="t-page" tabindex="-1">Benchmark rigor ratings</h1>
    <p class="mt-4 max-w-3xl text-base text-muted sm:text-lg">How rigorous are the benchmarks AI developers and policymakers rely on? Each standard is scored in its own units, so compare down one standard, not across.</p>
    <p class="t-caption mt-3">${rated} of ${benchmarks.size} benchmarks rated under ${encoded.length} encoded standards.
      ${watch ? `Sources are checked manually for now; last checked ${watch.checked_on}.` : 'Source checks have not run yet.'}</p>
    <div class="rt-legend legend mt-4">
      <p>Grade A to F is the median of a benchmark's published ratings (A 85+, B 70+, C 55+, D 40+, E 25+, F below). “1 of 4 standards” is how many of the standards that apply to a benchmark its grade rests on: one standard means low confidence, and more standards that agree mean more. <a class="link tap" href="#/method">How it works</a></p>
      <p class="t-caption mt-2">Putting different standards on one 0–100 scale is a display convention, not a validated measure.</p>
      <details class="mt-2"><summary>Full key</summary>
        <dl class="rt-key">
          ${stds.map((s) => html`<dt>${s.short}</dt><dd>${stdTip(s)}</dd>`)}
          <dt>Run cost</dt><dd>$ to $$$$$ is the API cost band for a full run: $ under 1M tokens, $$ under 10M, $$$ under 100M, $$$$ under 1B, $$$$$ 1B or more. The local setup (Lite, Standard, Heavy, Extreme) is the hardware the test harness needs, not hosting the model.</dd>
          <dt>Best value</dt><dd>${BEST_VALUE}</dd>
          <dt><span aria-hidden="true">≠</span><span class="sr-only">differs</span></dt><dd>The source's published figure differs from Touchstone's recomputation from the same verdicts.</dd>
          <dt>draft</dt><dd>An automated assessment not yet reviewed by a person.</dd>
          <dt>Empty cell</dt><dd>A dash means not rated yet; a shaded blank cell means the standard does not apply to this type of benchmark.</dd>
        </dl></details>
    </div>
    <button type="button" id="rf-toggle" class="rt-toggle btn-quiet mt-4" aria-expanded="false" aria-controls="rf-panel"></button>
    <div id="rf-panel" class="rt-panel mt-4" role="search">
      <label class="grid gap-1 text-sm"><span>Search</span><input id="q" type="search" class="field" placeholder="Name or concept" value="${state.q}" autocomplete="off"></label>
      <label class="grid gap-1 text-sm"><span>Domain</span>
        <select id="domain" class="field"><option value="">All</option><option value="safety">Safety</option><option value="capability">Capability</option></select></label>
      <label class="grid gap-1 text-sm"><span>Type</span>
        <select id="modality" class="field"><option value="">All</option>${modalities.map((m) => html`<option value="${m}">${modalityName(m)}</option>`)}</select></label>
      <label class="grid gap-1 text-sm"><span>Ratings from</span>
        <select id="source" class="field"><option value="all">Reviewed, else draft</option><option value="published">Reviewed only</option><option value="automated">Automated only</option></select></label>
      <label class="grid gap-1 text-sm"><span>Show</span>
        <select id="value" class="field"><option value="">All benchmarks</option><option value="best">Best value only</option></select></label>
      <label class="rt-sortsel grid gap-1 text-sm"><span>Sort by</span>
        <select id="sort" class="field">${columns().map((c) => html`<option value="${c.key}">${c.label}</option>`)}<option value="domain">Domain</option></select></label>
    </div>
    <p id="count" class="t-caption mt-4" aria-live="polite"></p>
    <div id="results" class="mt-2"></div>
    <div id="tray" class="rt-tray" role="region" aria-label="Compare benchmarks" hidden></div>
  `.s;
  syncControls();
  const on = (id: string, ev: string, fn: (e: Event) => void) => document.getElementById(id)!.addEventListener(ev, fn);
  on('q', 'input', (e) => { state.q = (e.target as HTMLInputElement).value; draw(); });
  for (const id of ['domain', 'modality', 'source', 'value'] as const)
    on(id, 'change', (e) => { state[id] = (e.target as HTMLSelectElement).value; draw(); });
  on('sort', 'change', (e) => {
    state.sort = (e.target as HTMLSelectElement).value;
    state.dir = ascFirst(state.sort) ? 1 : -1;
    draw();
  });
  on('rf-toggle', 'click', () => {
    const open = document.getElementById('rf-panel')!.classList.toggle('is-open');
    document.getElementById('rf-toggle')!.setAttribute('aria-expanded', String(open));
  });
  draw();
}
wide.addEventListener('change', () => { if (document.getElementById('results')) draw(); });

function syncControls() {
  for (const id of ['domain', 'modality', 'source', 'value', 'sort'] as const) (document.getElementById(id) as HTMLSelectElement).value = state[id];
  (document.getElementById('q') as HTMLInputElement).value = state.q;
}

function draw() {
  const rows = filteredBenchmarks();
  document.getElementById('count')!.textContent = `${rows.length} of ${benchmarks.size} benchmarks shown`;
  document.getElementById('results')!.innerHTML = (!rows.length ? emptyView() : wide.matches ? tableView(rows) : html`<ul class="cards" role="list">${rows.map(cardView)}</ul>`).s;
  syncUi();
}

/** Everything that mirrors state outside the results: filter count, compare boxes and tray, and the URL. */
function syncUi() {
  const n = activeCount();
  document.getElementById('rf-toggle')!.textContent = `Filter and sort${n ? ` (${n} active)` : ''}`;
  main.querySelectorAll<HTMLInputElement>('input[data-cmp]').forEach((i) => {
    i.checked = state.compare.includes(i.dataset.cmp!);
    i.disabled = !i.checked && state.compare.length >= MAX_COMPARE;
  });
  const tray = document.getElementById('tray')!;
  const c = state.compare.length;
  tray.hidden = !c;
  tray.innerHTML = c ? html`<span><strong>${c}</strong> selected <span class="t-caption">(2 to ${MAX_COMPARE})</span></span>
    ${c >= 2 ? html`<a class="btn btn-primary" href="#/compare/${state.compare.join(',')}">Compare ${c}</a>` : html`<span class="t-caption">Select one more to compare</span>`}
    <button type="button" class="btn-quiet" data-clear-compare>Clear</button>`.s : '';
  const h = encodeView(state);
  if (location.hash !== h) history.replaceState(null, '', h); // filters live in the URL without adding history entries
}

function emptyView(): Raw {
  const names: Record<string, string> = { safety: 'Safety', capability: 'Capability', published: 'Reviewed only', automated: 'Automated only' };
  const active = [state.q && `Search “${state.q}”`, state.domain && `Domain: ${names[state.domain]}`, state.modality && `Type: ${modalityName(state.modality)}`,
    state.source !== 'all' && `Ratings from: ${names[state.source]}`, state.value && 'Best value only'].filter(Boolean);
  return html`<div class="rt-empty" role="status"><p class="t-sub">No benchmarks match.</p>
    <ul class="mt-2 text-sm" role="list">${active.map((a) => html`<li>${a}</li>`)}</ul>
    <p class="mt-4"><button type="button" class="btn btn-primary" data-clear-filters>Clear filters</button></p></div>`;
}

function tableView(rows: B[]): Raw {
  const cols = columns();
  const stds = ratedStds();
  const label = cols.find((c) => c.key === state.sort)?.label ?? state.sort;
  return html`<table class="rt"><caption class="sr-only">Benchmarks, sorted by ${label}. Tick two to ${MAX_COMPARE} to compare them.</caption>
    <thead><tr><th scope="col" class="rt-sel"><span class="sr-only">Compare</span></th>${cols.map((c) => html`
      <th scope="col" aria-sort="${state.sort === c.key ? (state.dir > 0 ? 'ascending' : 'descending') : 'none'}">
        <button type="button" class="sort-btn" data-sort="${c.key}" title="${c.tip}">${c.label}<span class="sort-arrow" aria-hidden="true"></span></button></th>`)}</tr></thead>
    <tbody>${rows.map((b) => html`<tr data-bench="${b.id}" data-prefetch="benchmarks/${b.id}.json">
      <td class="rt-sel">${cmpBox(b)}</td>
      <th scope="row" class="rt-name"><a class="rt-link" href="#/benchmark/${b.id}">${b.name}</a>
        <div class="rt-sub"><span class="chip">${b.domain}</span><span class="rt-concept" title="${b.concept}">${modalityName(b.modality)} · ${b.concept}</span></div></th>
      <td class="rt-grade">${touchstoneView(b)}</td><td class="rt-run">${runView(b)}</td>
      ${stds.map((s) => cell(b, s))}</tr>`)}</tbody></table>`;
}

const cmpBox = (b: B) => html`<label class="rt-cmp"><input type="checkbox" data-cmp="${b.id}"><span class="sr-only">Compare ${b.name}</span></label>`;

const apiLabel = (r: RunProfile) => (r.apiTier === 'none' ? 'No API cost' : r.apiTier);
const noData = (text: string) => html`<span class="text-sm text-muted" aria-hidden="true">—</span><span class="sr-only">${text}</span>`;
/** Grade, score and how many standards it rests on. Confidence is explained once in the legend, not per row. */
function touchstoneView(b: B): Raw {
  const r = b.touchstone.rigor;
  if (r.score === null || !r.grade) return noData('No published ratings yet');
  return html`<span class="rt-nowrap"><span class="ts-grade ts-grade-${r.grade.toLowerCase()}" title="Touchstone grade ${r.grade}">${r.grade}</span> <span class="tabular-nums">${r.score}</span></span><span class="rt-count">${r.n} of ${stdTotal(b, r.n)} standards</span>`;
}
/** API band and local setup: "$$ / Standard setup". */
function runView(b: B): Raw {
  const r = b.touchstone.run;
  if (!r) return noData('Run-cost data not yet collected');
  return html`<span class="rt-nowrap" title="${r.tokens.toLocaleString('en-US')} tokens per full run"><span aria-hidden="true">${apiLabel(r)}</span><span class="sr-only">${r.apiTier === 'none' ? 'No API cost' : `API cost band ${r.apiTier.length} of 5`}</span></span>${b.touchstone.onFrontier ? html` <span class="pill rt-best" title="${BEST_VALUE}">best value</span>` : ''}
    <span class="rt-count">${r.localTier} setup</span>`;
}

function cell(b: B, s: IStd): Raw {
  const p = primary(b.id, s.id, state.source);
  if (p) return html`<td data-std="${s.id}"><span class="flex flex-wrap items-center gap-1.5 text-sm">${ratingLabel(p.label)}${chips(p)}</span>${bar(p.pct)}</td>`;
  return inScope(s, b)
    ? html`<td data-std="${s.id}"><span class="text-sm text-muted" aria-hidden="true">—</span><span class="sr-only">Not rated yet</span></td>`
    : html`<td data-std="${s.id}" class="rt-na"><span class="sr-only">Does not apply to this type of benchmark</span></td>`;
}

/** Narrow screens: one card per benchmark; only standards with a rating get a line. */
function cardView(b: B): Raw {
  const rated = ratedStds().map((s) => [s, primary(b.id, s.id, state.source)] as const).filter((x): x is [IStd, Summary] => !!x[1]);
  const missing = ratedStds().length - rated.length;
  return html`<li class="bcard" data-bench="${b.id}" data-prefetch="benchmarks/${b.id}.json">
    <div class="flex items-start justify-between gap-3"><a class="t-sub rt-link" href="#/benchmark/${b.id}">${b.name}</a><span class="chip">${b.domain}</span></div>
    <div class="t-caption mt-1">${modalityName(b.modality)} · ${b.concept}</div>
    <div class="mt-3 grid gap-1 text-sm"><div><span class="text-muted">Touchstone grade</span> ${touchstoneView(b)}</div>
      <div><span class="text-muted">Run cost</span> ${runView(b)}</div></div>
    ${rated.length ? html`<div class="mt-4 grid gap-3">${rated.map(([s, p]) => html`<div>
      <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm"><span class="text-muted">${s.short}</span>
        <span class="flex flex-wrap items-center gap-1.5">${ratingLabel(p.label)}${chips(p)}</span></div>
      <div class="mt-1.5">${bar(p.pct)}</div></div>`)}</div>` : ''}
    ${missing ? html`<div class="t-caption mt-3">+${missing} not rated</div>` : ''}
    <label class="rt-cmp rt-cmp-card mt-3"><input type="checkbox" data-cmp="${b.id}"> Compare</label>
  </li>`;
}

function sortBy(key: string) {
  state.dir = state.sort === key ? -state.dir : ascFirst(key) ? 1 : -1;
  state.sort = key;
  syncControls();
  draw();
  document.querySelector<HTMLElement>(`[data-sort="${CSS.escape(key)}"]`)?.focus();
  announce(`Sorted by ${columns().find((c) => c.key === key)?.label ?? key}, ${state.dir > 0 ? 'ascending' : 'descending'}`);
}

// ---------- Compare: #/compare/a,b[,c,d] ----------
const usd = (x: number) => `$${x.toLocaleString('en-US', { maximumSignificantDigits: 2 })}`;
function renderCompare(ids: string[]) {
  const unknown = [...new Set(ids.filter((id) => id && !benchmarks.has(id)))];
  state.compare = [...new Set(ids)].filter((id) => benchmarks.has(id)).slice(0, MAX_COMPARE);
  const back = encodeView(state);
  const unknownNote = unknown.length ? html`<p class="mt-4" role="alert">No benchmark has the id ${unknown.map((u, i) => html`${i ? ', ' : ''}“${u}”`)}, so ${unknown.length === 1 ? 'it was' : 'they were'} left out. <a class="link" href="#/">Back to ratings</a></p>` : '';
  if (state.compare.length < 2) {
    main.innerHTML = html`<h1 class="t-page" tabindex="-1">Compare benchmarks</h1>${unknownNote}
      <p class="mt-4">Pick at least two benchmarks to compare.</p><p class="mt-4"><a class="btn btn-primary" href="${back}">Choose benchmarks</a></p>`.s;
    return;
  }
  const bs = state.compare.map((id) => benchmarks.get(id)!);
  const stds = encoded.filter((s) => bs.some((b) => primary(b.id, s.id, 'all')));
  const row = (head: Raw | string, f: (b: B) => Raw | string) => html`<tr><th scope="row">${head}</th>${bs.map((b) => html`<td>${f(b)}</td>`)}</tr>`;
  main.innerHTML = html`
    <p class="text-sm"><a class="link" href="${back}">Ratings</a> <span aria-hidden="true">/</span> <span class="sr-only">current page:</span> Compare</p>
    <h1 class="t-page mt-3" tabindex="-1">Compare benchmarks</h1>${unknownNote}
    <p class="t-caption mt-3">Each standard is scored in its own units, so read down a row, not across.</p>
    <div class="rt-scroll mt-6"><table class="rt rt-compare"><caption class="sr-only">Side-by-side comparison of ${bs.map((b) => b.name).join(', ')}</caption>
      <thead><tr><th scope="col"><span class="sr-only">Measure</span></th>${bs.map((b) => html`<th scope="col"><a class="rt-link" href="#/benchmark/${b.id}">${b.name}</a>
        <div class="mt-1"><a class="link text-sm" href="#/compare/${state.compare.filter((x) => x !== b.id).join(',')}">Remove<span class="sr-only"> ${b.name}</span></a></div></th>`)}</tr></thead>
      <tbody>
        ${row('Touchstone grade', (b) => touchstoneView(b))}
        ${row('Score (0 to 100)', (b) => String(b.touchstone.rigor.score ?? '—'))}
        ${row('Run cost', (b) => { const r = b.touchstone.run; return r ? html`${apiLabel(r)}<span class="rt-count">${r.tokens.toLocaleString('en-US')} tokens${r.apiTier === 'none' ? '' : `, about ${usd(r.costUsd[0])} to ${usd(r.costUsd[1])}`}</span><span class="rt-count">${r.localTier} local setup</span>${b.touchstone.onFrontier ? html`<span class="pill rt-best" title="${BEST_VALUE}">best value</span>` : ''}` : 'Not yet collected'; })}
        ${row('Type', (b) => html`<span class="chip">${b.domain}</span> ${modalityName(b.modality)}`)}
        ${stds.map((s) => row(html`<span title="${stdTip(s)}">${s.short}</span>`, (b) => {
          const p = primary(b.id, s.id, 'all');
          return p ? html`<span class="flex flex-wrap items-center gap-1.5">${ratingLabel(p.label)}${chips(p)}</span>${bar(p.pct)}` : inScope(s, b) ? 'Not rated yet' : html`<span class="text-muted">Does not apply</span>`;
        }))}
      </tbody></table></div>`.s;
}

main.addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement;
  if (!t.matches('input[data-cmp]')) return;
  const id = t.dataset.cmp!;
  state.compare = t.checked ? [...state.compare.filter((x) => x !== id), id].slice(0, MAX_COMPARE) : state.compare.filter((x) => x !== id);
  syncUi();
  announce(`${state.compare.length} selected for comparison`);
});
main.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('[data-retry]')) return void (data ? route() : init());
  const f = t.closest<HTMLButtonElement>('[data-f]');
  if (f) return setFilter(f);
  const sortBtn = t.closest<HTMLElement>('[data-sort]');
  if (sortBtn) return sortBy(sortBtn.dataset.sort!);
  if (t.closest('[data-clear-filters]')) { Object.assign(state, defaultView()); syncControls(); draw(); document.getElementById('q')!.focus(); return; }
  if (t.closest('[data-clear-compare]')) { state.compare = []; syncUi(); announce('Comparison selection cleared'); return; }
  const link = t.closest<HTMLElement>('[data-bench] a[href^="#/benchmark/"]');
  if (link) state.lastBench = link.closest<HTMLElement>('[data-bench]')!.dataset.bench!;
});
// A benchmark's JSON starts loading as soon as its row or card is hovered or focused.
const warm = (e: Event) => { const el = (e.target as HTMLElement).closest<HTMLElement>('[data-prefetch]'); if (el) prefetch(el.dataset.prefetch!); };
main.addEventListener('mouseover', warm);
main.addEventListener('focusin', warm);

// ---------- Benchmark page ----------
const maxOf = (s: Standard) => (s.scoring?.scheme === 'points' ? s.scoring.max : 15);
type VClass = 'met' | 'partly' | 'unmet' | 'na';
/** Missing verdicts count as not met (undocumented means unsatisfied); for points, 0 is not met, the maximum is met, anything between is partly met. */
function vclass(v: Verdict | undefined, s: Standard): VClass {
  if (!v) return 'unmet';
  if (v.value === 'n/a') return 'na';
  if (typeof v.value === 'number') return v.value >= maxOf(s) ? 'met' : v.value > 0 ? 'partly' : 'unmet';
  return v.value === 'met' ? 'met' : 'unmet';
}
function verdictPill(v: Verdict | undefined, s: Standard) {
  if (!v) return html`<span class="pill pill-unmet"><span aria-hidden="true">✕</span> no verdict</span>`;
  if (v.value === 'n/a') return html`<span class="pill pill-na"><span aria-hidden="true">–</span> n/a</span>`;
  const c = vclass(v, s);
  if (typeof v.value === 'number') {
    const sym = c === 'met' ? '✓' : c === 'partly' ? '◐' : '✕';
    return html`<span class="pill ${c === 'met' ? 'pill-met' : c === 'partly' ? 'pill-partly' : 'pill-unmet'}"><span aria-hidden="true">${sym}</span> ${c === 'met' ? 'met' : c === 'partly' ? 'partly met' : 'not met'} · ${v.value} / ${maxOf(s)}</span>`;
  }
  return v.value === 'met' ? html`<span class="pill pill-met"><span aria-hidden="true">✓</span> met</span>` : html`<span class="pill pill-unmet"><span aria-hidden="true">✕</span> not met</span>`;
}
/** Grades and AISL categories share the .ts-grade-* ramp; the letter is always in the text. */
function detailLabel(label: string, big = false) {
  const m = /^Category ([A-E])$/.exec(label);
  if (m) return html`<span class="ts-grade ts-grade-${m[1]!.toLowerCase()}${big ? ' ts-grade-lg' : ''}">${label}</span>`;
  return html`<span class="font-semibold text-heading${big ? ' text-2xl' : ''}">${label}</span>`;
}
const plainName = (t: string) => (t.length > 90 ? `${t.slice(0, 87).trimEnd()}…` : t);
const assessmentId = (a: { file: string }) => a.file.replace(/\W/g, '-');

const correctionUrl = (b: Benchmark, s: IStd, item?: string) => {
  const p = new URLSearchParams({ template: 'score-correction.yml', title: `Correction: ${b.name} / ${s.short}${item ? ` ${item}` : ''}`, benchmark: b.id, standard: s.id });
  if (item) p.set('items', item);
  return `${data.repo}/issues/new?${p.toString()}`;
};

function itemRow(b: Benchmark, s: Standard, it: Item, a: A) {
  const v = a.verdicts?.[it.id];
  const by = v?.by === 'model' ? `model${a.model_run ? ` (${a.model_run.model})` : ''}` : a.provenance.assessors.join(', ');
  const from = a.provenance.assessors.join(', ');
  return html`<li id="it-${assessmentId(a)}-${it.id}" tabindex="-1" class="border-t border-line py-4" data-v="${vclass(v, s)}">
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <code>${it.id}</code>
      ${verdictPill(v, s)}
      ${it.severity ? html`<span class="t-caption"><span class="sev sev-${it.severity}" aria-hidden="true"></span>${it.severity === 'baseline' ? 'baseline requirement' : `${it.severity}: caps at ${severityCap(s, it.severity)}`}</span>` : ''}
      ${v?.by ? html`<span class="t-caption">verdict by ${by}</span>` : ''}
    </div>
    <p class="mt-1.5">${it.text}</p>
    ${v?.rationale ? html`<p class="mt-1.5 text-sm"><span class="text-muted">Reasoning:</span> ${v.rationale}</p>` : ''}
    ${v?.evidence.length ? html`<ul class="mt-2 grid gap-2 text-sm" role="list">${v.evidence.map((e) => html`<li class="evidence">
        <p><span class="text-muted">Source:</span> <a class="link tap" href="${safeUrl(e.url)}">${e.locator}</a>${e.note ? html` <span class="text-muted">${e.note}</span>` : ''}</p>
        ${e.quote ? html`<blockquote class="quote">“${e.quote}”</blockquote>` : html`<p class="t-caption">${a.provenance.kind === 'external' ? `No quote: verdict taken from ${from}'s published score.` : 'No quote recorded.'}</p>`}
      </li>`)}</ul>` : v ? html`<p class="t-caption mt-2">No evidence recorded for this verdict.</p>` : ''}
    ${it.guidance ? html`<p class="t-caption mt-2">Met when: ${it.guidance.met}${it.guidance.not_applicable ? ` · n/a when: ${it.guidance.not_applicable}` : ''}</p>` : ''}
    <details class="report t-caption mt-1"><summary>Report</summary><a class="link tap" href="${correctionUrl(b, s, it.id)}">Request a correction to ${it.id}</a></details>
  </li>`;
}
const severityCap = (s: Standard, sev: string) => (s.scoring?.scheme === 'aisl-severity' ? (s.scoring.severity_scores as Record<string, number>)[sev] : '');

/** All / Not met / Partly met / Met / N/A, each with its count. The list itself is filtered by CSS on the card's data-filter. */
function filterBar(s: Standard, a: A) {
  const n = { all: 0, unmet: 0, partly: 0, met: 0, na: 0 };
  for (const it of s.groups.flatMap((g) => g.items)) { n.all++; n[vclass(a.verdicts?.[it.id], s)]++; }
  const btn = (k: keyof typeof n, label: string) => html`<button type="button" class="filter-btn" data-f="${k}" aria-pressed="${k === 'all'}">${label} <span class="tabular-nums">(${n[k]})</span></button>`;
  return html`<div role="group" aria-label="Filter items" class="mt-6 flex flex-wrap items-center gap-2"><span class="t-caption mr-1">Show items</span>
    ${btn('all', 'All')}${btn('unmet', 'Not met')}${n.partly ? btn('partly', 'Partly met') : ''}${btn('met', 'Met')}${btn('na', 'N/A')}</div>`;
}
function setFilter(btn: HTMLButtonElement) {
  const card = btn.closest<HTMLElement>('article')!;
  card.dataset.filter = btn.dataset.f;
  btn.parentElement!.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === btn)));
  if (btn.dataset.f !== 'all') card.querySelectorAll('details.items').forEach((d) => ((d as HTMLDetailsElement).open = true));
  card.querySelectorAll<HTMLDetailsElement>('details.items').forEach((d) => {
    const all = d.querySelectorAll('li[data-v]').length;
    const k = btn.dataset.f === 'all' ? all : d.querySelectorAll(`li[data-v="${btn.dataset.f}"]`).length;
    d.hidden = k === 0; // a group with nothing to show disappears while a filter is on
    d.querySelector('[data-n]')!.textContent = k === all ? String(all) : `${k} of ${all}`;
  });
  const shown = card.querySelectorAll(`li[data-v${btn.dataset.f === 'all' ? '' : `="${btn.dataset.f}"`}]`).length;
  announce(`Showing ${shown} item${shown === 1 ? '' : 's'}`);
}

/** Brief highlight for the section or item a link just took the reader to. */
function flash(el: HTMLElement | null) {
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 2000);
}
// Links to an item (data-item) open its list and jump to it; links to a section of the page already shown get the highlight.
main.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest<HTMLElement>('[data-item]');
  if (!a) return;
  const li = document.getElementById(a.dataset.item!);
  if (!li) return;
  e.preventDefault();
  const card = li.closest<HTMLElement>('article')!;
  if (card.dataset.filter !== 'all') card.querySelector<HTMLButtonElement>('[data-f="all"]')?.click();
  li.closest('details')!.open = true;
  li.scrollIntoView({ block: 'center' });
  li.focus({ preventScroll: true });
  flash(li);
});
window.addEventListener('hashchange', () => {
  const std = /^#\/benchmark\/[^/]+\/([^/]+)/.exec(location.hash)?.[1];
  if (std) flash(document.getElementById(`std-${std}`));
});

/** "Biggest levers": the already-computed improvements as a short table with plain item names. */
function improvementsView(b: Benchmark, s: Standard, r: R, aid: string) {
  const text = new Map(s.groups.flatMap((g) => g.items).map((i) => [i.id, i.text]));
  return html`<section class="mt-6" aria-labelledby="imp-${aid}">
    <h4 id="imp-${aid}" class="font-medium">Biggest levers</h4>
    ${r.improvements.length ? html`<div class="table-wrap mt-2"><table class="stack-table w-full text-sm">
      <caption class="sr-only">Items whose fix would most improve this rating</caption>
      <thead><tr class="text-left text-muted"><th scope="col" class="px-3 py-2 font-normal">Item</th><th scope="col" class="px-3 py-2 font-normal">Dimension</th><th scope="col" class="px-3 py-2 font-normal">Overall if fixed</th></tr></thead>
      <tbody>${r.improvements.map((m) => html`<tr class="border-t border-line align-top">
        <th scope="row" class="px-3 py-2.5 text-left font-normal"><a class="link tap" href="#/benchmark/${b.id}/${s.id}" data-item="it-${aid}-${m.item}" title="${m.item}">${plainName(text.get(m.item) ?? m.item)}</a>${m.blocking ? html` <span class="pill pill-diff">blocking</span>` : ''}</th>
        <td class="px-3 py-2.5 tabular-nums" data-label="Dimension">${m.group}: ${m.groupFrom} → ${m.groupTo}</td>
        <td class="px-3 py-2.5 tabular-nums" data-label="Overall if fixed">${m.overallFrom} → ${m.overallTo}</td></tr>`)}</tbody>
    </table></div>` : html`<p class="mt-2 text-sm text-muted">Every applicable item is met</p>`}
  </section>`;
}

function assessmentCard(b: Benchmark, s: Standard, a: A, r: R, open: boolean) {
  const fileUrl = `${data.repo}/blob/main/${a.file}`;
  const id = assessmentId(a);
  const verdicts = Object.values(a.verdicts ?? {});
  const quoted = verdicts.filter((v) => v.evidence.some((e) => e.quote)).length;
  return html`<article class="card mt-5" aria-labelledby="h-${id}" data-filter="all">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h3 id="h-${id}" class="t-sub">${provenanceLabel(a)}</h3>
      <span class="text-sm">${a.status === 'draft' ? html`<span class="pill pill-draft">draft, not yet reviewed</span>` : html`<span class="pill">published</span>`}</span>
    </div>
    <p class="mt-4">${detailLabel(r.overall.label, true)}</p>
    <p class="mt-2 text-sm">${r.overall.explanation}</p>
    ${r.discrepancies.length ? html`<div class="mt-4 rounded-md border border-line p-3 text-sm" role="note">
        <p class="font-medium text-warn"><span aria-hidden="true">≠</span> The source's published figures differ from a recomputation from its own verdicts</p>
        <ul class="mt-1 list-disc pl-5">${r.discrepancies.map((d) => html`<li>${d.field}: published ${d.published}, recomputed ${d.computed}</li>`)}</ul>
        ${a.notes ? html`<p class="mt-1 text-muted">${a.notes}</p>` : ''}
      </div>` : a.notes ? html`<p class="mt-2 text-sm text-muted">${a.notes}</p>` : ''}
    <div class="table-wrap mt-5"><table class="stack-table w-full text-sm">
      <caption class="sr-only">Scores by ${s.short} dimension</caption>
      <thead><tr class="text-left text-muted"><th scope="col" class="px-3 py-2 font-normal">Dimension</th><th scope="col" class="px-3 py-2 font-normal">Score</th><th scope="col" class="px-3 py-2 font-normal">How it was calculated</th></tr></thead>
      <tbody>${r.groups.map((g) => html`<tr class="border-t border-line align-top">
        <th scope="row" class="px-3 py-2.5 text-left font-medium">${g.name}</th>
        <td class="px-3 py-2.5" data-label="Score"><div class="grid gap-1">${g.display}${bar(g.pct)}</div></td>
        <td class="px-3 py-2.5" data-label="How it was calculated">${g.explanation}</td></tr>`)}</tbody>
    </table></div>
    ${a.mode === 'itemized' ? html`${improvementsView(b, s, r, id)}${filterBar(s, a)}
      <p class="t-caption mt-3">${quoted} of ${verdicts.length} verdicts have quotes.</p>
      ${s.groups.map((g) => html`<details class="items mt-3" ${open ? 'open' : ''}>
        <summary class="font-medium">${g.name}: item verdicts (<span data-n>${g.items.length}</span>)</summary>
        <ul class="mt-2" role="list">${g.items.map((it) => itemRow(b, s, it, a))}</ul>
      </details>`)}` : html`<p class="mt-5 text-sm text-muted">Item-level verdicts were not published by this source, so only its dimension scores are shown.</p>`}
    <details class="mt-5 text-sm">
      <summary>Provenance and history</summary>
      <dl class="kv mt-3 gap-x-4 gap-y-1">
        <dt class="text-muted">Assessed</dt><dd>${a.provenance.assessed_on} by ${a.provenance.assessors.join(', ')}${a.provenance.reviewers?.length ? `; reviewed by ${a.provenance.reviewers.join(', ')}` : ''}</dd>
        ${a.provenance.source_url ? html`<dt class="text-muted">Source</dt><dd><a class="link" href="${safeUrl(a.provenance.source_url)}">${a.provenance.source_title ?? a.provenance.source_url}</a></dd>` : ''}
        <dt class="text-muted">Standard</dt><dd>${s.name}, version ${a.standard_version}${a.provenance.standard_version_used ? ` (source used ${a.provenance.standard_version_used})` : ''}</dd>
        ${a.benchmark_ref ? html`<dt class="text-muted">Benchmark version</dt><dd>${[a.benchmark_ref.paper_version && `paper ${a.benchmark_ref.paper_version}`, a.benchmark_ref.repo_commit && `commit ${a.benchmark_ref.repo_commit.slice(0, 12)}`].filter(Boolean).join(', ')}</dd>` : ''}
        ${a.model_run ? html`<dt class="text-muted">Model</dt><dd>${a.model_run.model} (${a.model_run.license}, via ${a.model_run.provider}), temperature ${a.model_run.temperature}, seed ${a.model_run.seed}, prompt v${a.model_run.prompt_version}</dd>
          <dt class="text-muted">Transcript</dt><dd><a class="link" href="${data.repo}/blob/main/${a.model_run.transcript}">${a.model_run.transcript}</a></dd>` : ''}
        <dt class="text-muted">Record</dt><dd><a class="link" href="${fileUrl}">${a.file}</a></dd>
      </dl>
      <h4 class="mt-4 font-medium">Revisions</h4>
      <ol class="mt-1 grid gap-1">${a.revisions.map((rv) => html`<li>${rv.date} · ${rv.by}: ${rv.summary}${rv.request ? html` (<a class="link" href="${data.repo}/issues/${rv.request}">request #${rv.request}</a>)` : ''}</li>`)}</ol>
    </details>
    <p class="mt-5 text-sm"><a class="link tap" href="${correctionUrl(b, s)}">Request a correction to this assessment</a></p>
  </article>`;
}

/** The benchmark's file plus the full standards its assessments need, fetched in parallel. */
async function loadBenchmark(b: Benchmark) {
  const used = encoded.filter((s) => pairs(b.id, s.id).length);
  const [file, ...full] = await Promise.all([getJson<BenchmarkFile>(`benchmarks/${b.id}.json`), ...used.map((s) => getJson<Standard>(`standards/${s.id}.json`))]);
  return { file, std: new Map(full.map((s) => [s.id, s])) };
}

const money = (x: number) => `$${x.toLocaleString('en-US', { maximumSignificantDigits: 2 })}`;
const detailModality = (m: string) => ({ 'language-model': 'Language model', 'lm-agent': 'Language-model agent', 'rl-agent': 'Reinforcement-learning agent', classifier: 'Classifier', 'scientific-ml': 'Scientific ML model' } as Record<string, string>)[m] ?? m.replace(/-/g, ' ');
const humanTokens = (n: number) => (n >= 1e9 ? `${+(n / 1e9).toPrecision(2)} billion` : n >= 1e6 ? `${+(n / 1e6).toPrecision(2)} million` : `${Math.round(n / 1e3).toLocaleString('en-US')} thousand`);
const humanLocal = (t: RunProfile['localTier']) => ({ Lite: 'a laptop is enough', Standard: 'needs a Docker or simulator setup', Heavy: 'needs a GPU or virtual machines', Extreme: 'needs a large server or hundreds of GB of disk' })[t];

/** Weakest points are linked from the summary to their item below. */
type Weak = { s: IStd; aid: string; m: Improvement; text: string };

function rigorPanel(b: B, weak: Weak[]): Raw {
  const r = b.touchstone.rigor;
  if (r.score === null || !r.grade)
    return html`<section class="card mt-8" aria-labelledby="ts-rigor"><h2 id="ts-rigor" class="t-section">Touchstone score</h2>
      <p class="mt-2 text-sm">${r.explanation} Drafts are not counted.</p></section>`;
  return html`<section class="card mt-8" aria-labelledby="ts-rigor">
    <h2 id="ts-rigor" class="t-section">Touchstone score</h2>
    <p class="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1"><span class="ts-grade ts-grade-lg ts-grade-${r.grade.toLowerCase()}">${r.grade}</span>
      <span class="text-2xl font-semibold tabular-nums">${r.score}</span><span class="text-muted">out of 100 · ${r.n} of ${stdTotal(b, r.n)} standards · ${r.confidence} confidence</span></p>
    <p class="mt-3 text-sm">${r.explanation}</p>
    <p class="t-caption mt-2">Putting different standards on one 0–100 scale is a display convention, not a validated measure.</p>
    ${weak.length ? html`<h3 class="mt-5 font-medium">Weakest points</h3>
      <ol class="mt-2 grid gap-2 text-sm" role="list">${weak.map((w) => html`<li><a class="link tap" href="#/benchmark/${b.id}/${w.s.id}" data-item="it-${w.aid}-${w.m.item}">${plainName(w.text)}</a>
        <span class="t-caption">${w.s.short} · ${w.m.group} ${w.m.groupFrom} → ${w.m.groupTo}</span></li>`)}</ol>` : ''}
    <details class="mt-5 text-sm">
      <summary>How this score was calculated</summary>
      <div class="table-wrap mt-3"><table class="stack-table w-full text-sm">
        <caption class="sr-only">Published ratings behind the Touchstone score</caption>
        <thead><tr class="text-left text-muted"><th scope="col" class="px-3 py-2 font-normal">Standard</th><th scope="col" class="px-3 py-2 font-normal">Verdict</th><th scope="col" class="px-3 py-2 font-normal">Normalized (0–100)</th></tr></thead>
        <tbody>${r.inputs.map((i) => html`<tr class="border-t border-line">
          <th scope="row" class="px-3 py-2.5 text-left font-medium"><a class="link tap" href="#/benchmark/${b.id}/${i.standard}">${i.short}</a></th>
          <td class="px-3 py-2.5" data-label="Verdict">${i.label}</td>
          <td class="px-3 py-2.5 tabular-nums" data-label="Normalized (0–100)">${i.normalized === null ? 'not counted (incomplete)' : i.normalized}</td></tr>`)}</tbody>
      </table></div>
      <dl class="kv mt-4 gap-x-4 gap-y-1">
        <dt class="text-muted">Spread</dt><dd>${r.spread} points</dd>
        <dt class="text-muted">Agreement</dt><dd>${r.agreement}</dd>
        <dt class="text-muted">Confidence</dt><dd>${r.confidence}</dd>
      </dl>
      <p class="mt-3">${r.gradeStable ? 'The grade is stable: it does not change if every cutpoint moves 5 points either way.' : 'The grade is near a cutpoint: it would change if every cutpoint moved 5 points.'}</p>
      <p class="t-caption mt-2">Only published ratings count; drafts are excluded. <a class="link tap" href="#/method">How the score works</a></p>
    </details>
  </section>`;
}

function runPanel(b: B): Raw {
  const run = b.touchstone.run, res = b.resources;
  if (!run || !res)
    return html`<section class="card mt-12" aria-labelledby="ts-run"><h2 id="ts-run" class="t-section">Run cost</h2><p class="mt-2 text-sm">Run-cost data not yet collected</p></section>`;
  const [lo, hi] = run.costUsd;
  return html`<section class="card mt-12" aria-labelledby="ts-run">
    <h2 id="ts-run" class="t-section">Run cost</h2>
    <p class="mt-3">About ${humanTokens(run.tokens)} tokens per full run. ${run.apiTier === 'none' ? 'No API cost.' : html`<span title="API tier ${apiLabel(run)}">${money(lo)}–${money(hi)} through an API</span> at reference prices.`}
      Running the harness: <span title="Local tier: ${run.localTier}">${humanLocal(run.localTier)}</span>.</p>
    <details class="mt-3 text-sm">
      <summary>How we estimated this</summary>
      <p class="mt-3">${run.explanation}</p>
      <dl class="kv mt-3 gap-x-4 gap-y-1">
        <dt class="text-muted">Tokens per full run</dt><dd class="tabular-nums">${run.tokens.toLocaleString('en-US')}</dd>
        <dt class="text-muted">API tier</dt><dd>${apiLabel(run)}${run.apiTier === 'none' ? '' : html` · ~${money(lo)}–${money(hi)} at reference prices (as of ${data.pricing.as_of})`}</dd>
        <dt class="text-muted">Local tier</dt><dd>${run.localTier}</dd>
        <dt class="text-muted">Test items</dt><dd class="tabular-nums">${res.items.toLocaleString('en-US')}</dd>
        <dt class="text-muted">Interaction</dt><dd>${res.interaction}</dd>
        <dt class="text-muted">Model calls per item</dt><dd class="tabular-nums">${res.model_calls_per_item}</dd>
        <dt class="text-muted">Tokens per call</dt><dd class="tabular-nums">${res.tokens_per_call.toLocaleString('en-US')}</dd>
        <dt class="text-muted">Grading</dt><dd>${res.grading}</dd>
        <dt class="text-muted">Judge calls per item</dt><dd class="tabular-nums">${res.judge_calls_per_item}</dd>
        <dt class="text-muted">Environment</dt><dd>${res.environment}</dd>
        <dt class="text-muted">GPU for the harness</dt><dd>${res.gpu_required ? 'yes' : 'no'}</dd>
        <dt class="text-muted">Download size</dt><dd class="tabular-nums">${res.disk_gb} GB</dd>
        <dt class="text-muted">How tokens were estimated</dt><dd>${res.estimate_basis}</dd>
        <dt class="text-muted">Sources</dt><dd><ul role="list">${res.sources.map((x) => html`<li><a class="link" href="${safeUrl(x.url)}">${x.locator}</a></li>`)}</ul></dd>
      </dl>
      <p class="t-caption mt-3">Token counts are estimates. The local tier covers the harness only, not hosting the model under test.</p>
    </details>
  </section>`;
}

/** Ranked order of the ratings page's default sort: Touchstone score, best first; unscored last. */
const rankedIds = () => [...benchmarks.values()].sort((x, y) => (y.touchstone.rigor.score ?? -1) - (x.touchstone.rigor.score ?? -1) || x.name.localeCompare(y.name)).map((x) => x.id);

function renderBenchmark(b: B, file: BenchmarkFile, full: Map<string, Standard>, focusStd?: string): HTMLElement | null {
  const watched = data.watch?.benchmarks[b.id];
  const results = new Map(file.results.map((r) => [r.file, r]));
  const parts = encoded.filter((s) => pairs(b.id, s.id).length || inScope(s, b)).map((s) => ({
    s, fs: full.get(s.id),
    list: file.assessments.filter((a) => a.standard === s.id).sort((x, y) => rank({ status: x.status, kind: x.provenance.kind } as Summary) - rank({ status: y.status, kind: y.provenance.kind } as Summary)),
  }));
  const assessed = parts.filter((p) => p.list.length && p.fs);
  const pending = parts.filter((p) => !(p.list.length && p.fs));
  const link = (s: IStd) => `#/benchmark/${b.id}/${s.id}`;
  const sections = assessed.map(({ s, fs, list }) => html`<section id="std-${s.id}" class="mt-12 first:mt-0" aria-labelledby="sec-${s.id}" tabindex="-1">
      <h2 id="sec-${s.id}" class="t-section">${s.name}</h2>
      <p class="mt-2 text-sm text-muted">${s.description} <a class="link" href="#/standard/${s.id}">How ${s.short} is scored</a></p>
      ${list.map((a) => assessmentCard(b, fs!, a, results.get(a.file)!, focusStd === s.id && list.length === 1))}
    </section>`.s).join('');
  // The three weakest points: best improvement first, taken in turn from each published standard's primary assessment.
  const queues = assessed.filter((p) => p.list[0]!.status === 'published').map((p) => ({ s: p.s, text: new Map(p.fs!.groups.flatMap((g) => g.items).map((i) => [i.id, i.text])), aid: assessmentId(p.list[0]!), imps: results.get(p.list[0]!.file)?.improvements ?? [] }));
  const weak: Weak[] = [];
  for (let i = 0; weak.length < 3 && queues.some((q) => i < q.imps.length); i++)
    for (const q of queues) if (i < q.imps.length && weak.length < 3) weak.push({ s: q.s, aid: q.aid, m: q.imps[i]!, text: q.text.get(q.imps[i]!.item) ?? q.imps[i]!.item });
  const order = rankedIds(), at = order.indexOf(b.id);
  const near = (id: string | undefined, dir: 'prev' | 'next') => (id ? html`<a class="link tap" rel="${dir}" href="#/benchmark/${id}">${dir === 'prev' ? '← Previous: ' : 'Next: '}${benchmarks.get(id)!.name}${dir === 'next' ? ' →' : ''}</a>` : '');
  main.innerHTML = html`
    <p class="text-sm"><a class="link tap" href="#/">Ratings</a> <span aria-hidden="true">/</span> <span class="sr-only">current page:</span> ${b.name}</p>
    <nav aria-label="Neighbouring benchmarks" class="pager mt-2 text-sm"><span>${near(order[at - 1], 'prev')}</span><span class="t-caption">${at + 1} of ${order.length} by Touchstone score</span><span>${near(order[at + 1], 'next')}</span></nav>
    <h1 class="t-page mt-3" tabindex="-1">${b.name}</h1>
    <p class="mt-3 text-lg text-muted">${b.concept}</p>
    <p class="t-caption mt-2"><span class="capitalize">${b.domain}</span> · ${detailModality(b.modality)}${b.year ? ` · ${b.year}` : ''}</p>
    <ul class="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-sm" role="list">
      ${b.links.paper ? html`<li><a class="link tap" href="${safeUrl(b.links.paper)}">Paper</a>${watched?.paper_version ? ` (latest ${watched.paper_version})` : ''}</li>` : ''}
      ${b.links.repo ? html`<li><a class="link tap" href="${safeUrl(b.links.repo)}">Code</a>${watched?.repo_commit ? ` (at ${watched.repo_commit.slice(0, 7)}${watched.archived ? ', archived' : ''})` : ''}</li>` : ''}
      ${b.links.website ? html`<li><a class="link tap" href="${safeUrl(b.links.website)}">Website</a></li>` : ''}
    </ul>
    ${rigorPanel(b, weak)}
    <div class="std-layout mt-10">
      ${assessed.length > 1 ? html`<nav aria-label="Standards on this page" class="std-nav"><ul role="list">
        ${assessed.map(({ s }) => html`<li><a href="${link(s)}">${s.short}</a></li>`)}
      </ul></nav>` : ''}
      <div class="min-w-0">${raw_(sections)}
        ${pending.length ? html`<p class="${assessed.length ? 'mt-12 ' : ''}text-sm">Not yet assessed: ${pending.map((p, i) => html`${i ? ', ' : ''}<a class="link" href="#/standard/${p.s.id}">${p.s.short}</a>`)}. Automated assessments are proposed when the re-assessment job is run.</p>` : ''}
      </div>
    </div>
    ${runPanel(b)}
  `.s;
  const target = focusStd ? document.getElementById(`std-${focusStd}`) : null;
  flash(target);
  return target;
}

// ---------- Standards ----------
function renderStandards() {
  main.innerHTML = html`
    <h1 class="t-page" tabindex="-1">Standards</h1>
    <p class="mt-4 max-w-3xl text-lg text-muted">Published standards for judging benchmark quality. Encoded standards have every item written as a decision rule that Touchstone can score; catalogued ones are tracked but not encoded yet.</p>
    <ul class="mt-8 grid gap-5" role="list">${data.standards.map((s) => html`<li class="card" data-prefetch="standards/${s.id}.json">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h2 class="t-section"><a class="hover:text-brand" href="#/standard/${s.id}">${s.name}</a></h2>
        <span class="pill ${s.status === 'encoded' ? 'pill-met' : 'pill-na'}">${s.status}</span>
      </div>
      <p class="t-caption mt-1">${s.publisher}, ${s.year} · ${s.kind.replace('-', ' ')}</p>
      <p class="mt-3 text-sm">${s.description}</p>
      ${s.notes ? html`<p class="mt-1 text-sm text-muted">${s.notes}</p>` : ''}
    </li>`)}</ul>`.s;
}

function scoringText(s: Standard): Raw {
  const sc = s.scoring;
  if (!sc) return html`<p>Not encoded yet.</p>`;
  if (sc.scheme === 'aisl-severity')
    return html`<p>Each dimension scores 1 (best) to 4. If every applicable item is met it scores 1. An unmet item highlighted
      <span class="sev sev-yellow" aria-hidden="true"></span>yellow caps it at ${sc.severity_scores.yellow},
      <span class="sev sev-orange" aria-hidden="true"></span>orange at ${sc.severity_scores.orange}, and
      <span class="sev sev-red" aria-hidden="true"></span>red at ${sc.severity_scores.red}; the worst cap applies. An unmet
      <span class="sev sev-baseline" aria-hidden="true"></span>baseline requirement makes the dimension invalid. The benchmark then gets the best category whose limits every dimension meets:</p>
      <div class="table-wrap mt-4"><table class="w-full text-sm"><thead><tr><th scope="col" class="px-3 py-2 text-left">Category</th>${s.groups.map((g) => html`<th scope="col" class="px-3 py-2 text-left">${g.name}</th>`)}<th scope="col" class="px-3 py-2 text-left">Fit for</th></tr></thead>
      <tbody>${sc.categories.map((c) => html`<tr class="border-t border-line"><th scope="row" class="px-3 py-2 text-left">${detailLabel(`Category ${c.id}`)}</th>${s.groups.map((g) => html`<td class="px-3 py-2">≤ ${c.max[g.id]}</td>`)}<td class="px-3 py-2">${c.use}</td></tr>`)}</tbody></table></div>`;
  if (sc.scheme === 'points')
    return html`<p>Each criterion scores ${sc.levels.join(', ')}. ${Object.entries(sc.level_meanings ?? {}).sort((a, b) => Number(b[0]) - Number(a[0])).map(([k, v]) => `${k}: ${v} `).join('')}A stage's score is the mean of its applicable criteria; the overall score is the mean of all applicable criteria.</p>`;
  return html`<p>Each group's score is the share of applicable items met. The overall score is the mean of the group scores.${s.scoring_defined_by === 'touchstone' ? ' This standard publishes no scoring rule, so this one is Touchstone\'s.' : ''}</p>`;
}

function renderStandard(s: Standard) {
  main.innerHTML = html`
    <p class="text-sm"><a class="link" href="#/standards">Standards</a> <span aria-hidden="true">/</span> ${s.short}</p>
    <h1 class="t-page mt-3" tabindex="-1">${s.name}</h1>
    <p class="t-caption mt-3">${s.publisher}, ${s.year} · version ${s.version} · <a class="link" href="${safeUrl(s.url)}">Source</a></p>
    <p class="mt-5 max-w-3xl">${s.description}</p>
    ${s.applies_to ? html`<p class="t-caption mt-2">Applies to: ${s.applies_to}</p>` : ''}
    <h2 class="t-section mt-12">How it is scored</h2>
    <div class="mt-3 max-w-3xl text-sm">${scoringText(s)}</div>
    ${s.groups.map((g) => html`<section class="mt-12" aria-labelledby="g-${g.id}">
      <h2 id="g-${g.id}" class="t-section">${g.name}</h2>
      ${g.description ? html`<p class="mt-2 text-sm text-muted">${g.description}</p>` : ''}
      <ul class="mt-4" role="list">${g.items.map((it) => html`<li class="border-t border-line py-4">
        <div class="flex flex-wrap items-baseline gap-3"><code>${it.id}</code>
          ${it.severity ? html`<span class="t-caption"><span class="sev sev-${it.severity}" aria-hidden="true"></span>${it.severity}</span>` : ''}</div>
        ${it.principle ? html`<p class="t-caption mt-1">${it.principle}</p>` : ''}
        <p class="mt-1.5">${it.text}</p>
        ${it.guidance ? html`<p class="mt-1.5 text-sm"><span class="text-muted">Met when:</span> ${it.guidance.met}</p>
          ${it.guidance.not_applicable ? html`<p class="text-sm"><span class="text-muted">n/a when:</span> ${it.guidance.not_applicable}</p>` : ''}` : ''}
      </li>`)}</ul></section>`)}`.s;
}

function renderMethod() {
  main.innerHTML = html`
    <h1 class="t-page" tabindex="-1">How it works</h1>
    <div class="mt-6 grid max-w-3xl gap-4">
      <p>Touchstone separates judgement from arithmetic. People, or an open-weights model whose work people review, decide one verdict per item of a standard. Scores are a deterministic function of the verdicts. Positive verdicts cite pinned evidence; the verdicts themselves are judgements. The same verdicts always give the same score, and every score on this site shows the calculation behind it.</p>
      <h2 class="t-section mt-6">The Touchstone score</h2>
      <p>Each benchmark gets two separate things, never blended into one number. The <strong>rigor score</strong> is the median of its published ratings, each put on a 0–100 scale, graded A (85 and up) to F, with a note on how closely the standards agree. The <strong>run cost</strong> is an estimate of the tokens, API price band and local setup a full run needs. A cheap benchmark should not look more rigorous, so the two stay apart; the "Best value" filter shows benchmarks no other benchmark beats on both. <a class="link" href="${data.repo}/blob/main/docs/touchstone-score.md">The exact rules, with a worked example and limitations</a>.</p>
      <h2 class="t-section mt-6">Verdicts</h2>
      <p>Each item of each standard is written as a decision rule: what must be true for it to be met, and when it can be not applicable. A positive verdict must cite evidence at a pinned version: an arXiv version or a git commit, with an exact location and a short quote. Missing documentation counts as not met.</p>
      <h2 class="t-section mt-6">Keeping ratings current</h2>
      <p>A job checks each benchmark's latest paper version and repository commit. It is run manually for now; scheduling is paused. Where something changed, or a pair was never assessed, an open-weights model under an open-source licence proposes verdicts. It sees only excerpts selected deterministically from the pinned sources. Every quote it gives is checked word for word against the excerpt it cites; a positive verdict without a verified quote is changed to not met. The job opens a pull request, and nothing is published until a person reviews it.</p>
      <h2 class="t-section mt-6">Auditing a rating</h2>
      <p>Each automated assessment records the model, licence, settings, prompt version, and hashes of the exact text it read. Its transcript holds every response, including the model's reasoning when the model provides it. Running <code>touchstone replay</code> re-fetches the pinned sources and confirms they and every prompt match the record.</p>
      <h2 class="t-section mt-6">Corrections</h2>
      <p>If a verdict is wrong or missing information, use the "Request a correction" link on the assessment, or "Report" on a single item. An automated comment lists the current verdicts. Accepted changes land as pull requests, and every change is logged in the assessment's revision history with a link to the request.</p>
      <p><a class="link" href="${data.repo}/blob/main/docs/methodology.md">Full methodology</a> · <a class="link" href="${data.repo}/blob/main/docs/automation.md">Automation and auditing</a> · <a class="link" href="${data.repo}/blob/main/CONTRIBUTING.md">Contributing</a></p>
    </div>`.s;
}

function renderNotFound(what = `There is no page at “${location.hash}”.`) {
  main.innerHTML = html`<h1 class="t-page" tabindex="-1">Not found</h1><p class="mt-4">${what}</p><p class="mt-4"><a class="link tap" href="#/">Back to ratings</a></p>`.s;
}
function renderError() {
  main.innerHTML = html`<h1 class="t-page" tabindex="-1">Could not load this page</h1><p class="mt-4">The data file did not load. Check your connection and try again.</p><p class="mt-4"><button type="button" class="btn" data-retry>Try again</button></p>`.s;
}

// ---------- Router ----------
let seq = 0;
let shown = ''; // what the page currently shows, so a link to a section of the same benchmark just scrolls
async function route() {
  const my = ++seq;
  const [path = '', qs = ''] = location.hash.replace(/^#\/?/, '').split(/\?(.*)/s);
  const [view, id, sub] = path.split('/').filter(Boolean);
  let target: HTMLElement | null = null;
  let nav = 'ratings';
  if (view === 'benchmark' && id && shown === `benchmark/${id}`) {
    target = (sub && document.getElementById(`std-${sub}`)) || null;
    (target ?? main.querySelector<HTMLElement>('h1')!).focus();
    if (target) target.scrollIntoView(); else window.scrollTo(0, 0);
    return;
  }
  const dataView = (view === 'benchmark' && id && benchmarks.has(id)) || (view === 'standard' && id && standards.has(id));
  if (dataView) { main.setAttribute('aria-busy', 'true'); main.innerHTML = skeleton(); }
  try {
    if (!view || view === 'ratings') {
      // A hash with a query is the whole state (shared link or back button); a bare #/ keeps what the reader had set.
      if (qs) Object.assign(state, decodeView(qs, { sorts: [...columns().map((c) => c.key), 'domain'], modalities: [...new Set([...benchmarks.values()].map((b) => b.modality))], benchmarks: new Set(benchmarks.keys()) }));
      renderRatings(); shown = 'ratings';
    }
    else if (view === 'compare') { renderCompare((id ?? '').split(',')); shown = 'compare'; }
    else if (view === 'benchmark' && id) {
      const b = benchmarks.get(id);
      if (!b) { renderNotFound(`No benchmark has the id “${id}”.`); shown = ''; }
      else {
        const { file, std } = await loadBenchmark(b);
        if (my !== seq) return;
        target = renderBenchmark(b, file, std, sub);
        shown = `benchmark/${id}`;
      }
    }
    else if (view === 'standards') { renderStandards(); nav = 'standards'; shown = 'standards'; }
    else if (view === 'standard' && id) {
      nav = 'standards';
      if (!standards.has(id)) { renderNotFound(`No standard has the id “${id}”.`); shown = ''; }
      else {
        const s = await getJson<Standard>(`standards/${id}.json`);
        if (my !== seq) return;
        renderStandard(s);
        shown = '';
      }
    }
    else if (view === 'method') { renderMethod(); nav = 'method'; shown = 'method'; }
    else { renderNotFound(); shown = ''; }
  } catch {
    if (my !== seq) return;
    renderError();
    shown = '';
  }
  main.removeAttribute('aria-busy');
  document.querySelectorAll<HTMLAnchorElement>('[data-nav]').forEach((a) => (a.dataset.nav === nav ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  const h1 = main.querySelector('h1')!;
  document.title = `${h1.textContent} · Touchstone`;
  if (shown === 'ratings') {
    if (wantSearch) { wantSearch = false; document.getElementById('q')!.focus(); return; }
    // Returning to the list puts focus back on the row or card the reader left from.
    if (state.lastBench) {
      const link = main.querySelector<HTMLElement>(`[data-bench="${CSS.escape(state.lastBench)}"] a[href^="#/benchmark/"]`);
      if (link) { link.focus(); announce(`Ratings, at ${benchmarks.get(state.lastBench)?.name}`); return; }
    }
  }
  (target ?? h1).focus();
  if (target) target.scrollIntoView();
  else window.scrollTo(0, 0);
  announce(h1.textContent ?? '');
}

// ---------- Global keys ----------
const dialog = document.getElementById('shortcuts') as HTMLDialogElement;
document.getElementById('shortcuts-open')!.addEventListener('click', () => dialog.showModal());
let pendingG = 0;
document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  const typing = t.closest('input, select, textarea, [contenteditable]');
  if (e.metaKey || e.altKey || (e.ctrlKey && !['Home', 'End'].includes(e.key))) return;
  if (e.key === 'Escape' && !dialog.open && /^#\/(benchmark|compare)\//.test(location.hash)) { e.preventDefault(); location.hash = '#/'; return; }
  if (typing || dialog.open) return;
  if (e.key === '/') { e.preventDefault(); const q = document.getElementById('q'); if (q) q.focus(); else if (data) { wantSearch = true; if (location.hash === '#/' || location.hash === '') route(); else location.hash = '#/'; } return; }
  if (e.key === '?') { e.preventDefault(); dialog.showModal(); return; }
  if (e.key === 'g') { pendingG = Date.now(); return; }
  if (Date.now() - pendingG < 1200) {
    const to = { r: '#/', s: '#/standards', m: '#/method' }[e.key];
    pendingG = 0;
    if (to) { e.preventDefault(); location.hash = to; }
  }
});

// ---------- Theme ----------
const themeBtn = document.getElementById('theme-toggle')!;
// data-theme is honoured so a host page can set the theme on <html>.
const hostTheme = () => { const t = document.documentElement.dataset.theme; return t === 'light' || t === 'dark' ? t : undefined; };
const currentTheme = () => document.documentElement.dataset.pactTheme ?? hostTheme() ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
// The button names the theme a click switches to; the sr-only prefix and title say so.
const labelTheme = () => { const to = currentTheme() === 'dark' ? 'light' : 'dark'; themeBtn.innerHTML = `<span class="sr-only">Switch to </span>${to === 'dark' ? 'Dark' : 'Light'} theme`; themeBtn.title = `Switch to ${to} theme`; };
themeBtn.addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.pactTheme = next;
  try { localStorage.setItem('theme', next); } catch {}
  labelTheme();
});
// With no saved choice the page follows the OS, so the label must follow it too.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', labelTheme);
new MutationObserver(labelTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
labelTheme();

async function init() {
  try { data = await getJson<SiteIndex>('index.json'); } catch { return renderError(); }
  standards = new Map(data.standards.map((s) => [s.id, s]));
  encoded = data.standards.filter((s) => s.status === 'encoded');
  benchmarks = new Map(data.benchmarks.map((b) => [b.id, b]));
  for (const a of data.summaries) byPair.set(`${a.benchmark}|${a.standard}`, [...(byPair.get(`${a.benchmark}|${a.standard}`) ?? []), a]);
  (document.getElementById('repo-link') as HTMLAnchorElement).href = data.repo;
  window.addEventListener('hashchange', route);
  route();
}
init();
