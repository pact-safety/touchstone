import './styles.css';
import raw from './generated/ratings.json' with { type: 'json' };
import type { SiteData } from '../../src/build.ts';
import type { Assessment, Benchmark, Item, Standard, Verdict } from '../../src/schema.ts';
import type { Result } from '../../src/engine.ts';

const data = raw as unknown as SiteData;
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

// ---------- Indexes ----------
const standards = new Map(data.standards.map((s) => [s.id, s as Standard]));
const encoded = data.standards.filter((s) => s.status === 'encoded') as Standard[];
const benchmarks = new Map(data.benchmarks.map((b) => [b.id, b as Benchmark]));
type A = Assessment & { file: string };
type R = Result & { file: string };
const assessments = data.assessments as A[];
const results = new Map((data.results as R[]).map((r) => [r.file, r]));
const pairs = (b: string, s: string) => assessments.filter((a) => a.benchmark === b && a.standard === s);
const inScope = (s: Standard, b: Benchmark) =>
  (!s.scope?.modalities || s.scope.modalities.includes(b.modality)) && (!s.scope?.domains || s.scope.domains.includes(b.domain));

/** The rating shown in the table: a reviewed record first, then an automated draft. */
function primary(b: string, s: string, source: string): { a: A; r: R } | undefined {
  const list = pairs(b, s)
    .filter((a) => source === 'all' || (source === 'automated' ? a.provenance.kind === 'automated' : a.provenance.kind !== 'automated'))
    .sort((x, y) => rank(x) - rank(y));
  const a = list[0];
  return a ? { a, r: results.get(a.file)! } : undefined;
}
const rank = (a: A) => (a.status === 'published' ? 0 : 1) * 10 + (a.provenance.kind === 'touchstone' ? 0 : a.provenance.kind === 'external' ? 1 : 2);

const bar = (pct: number | null) => (pct === null ? '' : html`<div class="bar" aria-hidden="true"><span style="width:${Math.max(2, Math.min(100, pct))}%"></span></div>`);
const provenanceLabel = (a: A) =>
  a.provenance.kind === 'external' ? `Published by ${a.provenance.assessors.join(', ')}`
  : a.provenance.kind === 'automated' ? `Automated (${a.model_run?.model ?? 'model'})`
  : `Touchstone assessment by ${a.provenance.assessors.join(', ')}`;

function announce(msg: string) { announcer.textContent = ''; requestAnimationFrame(() => (announcer.textContent = msg)); }

// ---------- Ratings table ----------
const state = { q: '', domain: '', modality: '', source: 'all', sort: 'name', dir: 1, focus: { row: 1, col: 0 }, lastBench: '' };

function filteredBenchmarks(): Benchmark[] {
  const q = state.q.toLowerCase();
  const rows = [...benchmarks.values()].filter((b) =>
    (!q || b.name.toLowerCase().includes(q) || b.id.includes(q) || b.concept.toLowerCase().includes(q)) &&
    (!state.domain || b.domain === state.domain) && (!state.modality || b.modality === state.modality));
  const key = (b: Benchmark): number | string => {
    if (state.sort === 'name') return b.name.toLowerCase();
    if (state.sort === 'domain') return b.domain;
    return primary(b.id, state.sort, state.source)?.r.overall.pct ?? -1;
  };
  return rows.sort((x, y) => {
    const a = key(x), c = key(y);
    const cmp = typeof a === 'number' && typeof c === 'number' ? a - c : String(a).localeCompare(String(c));
    return cmp * state.dir || x.name.localeCompare(y.name);
  });
}

function renderRatings() {
  const watch = data.watch;
  const rated = new Set(assessments.map((a) => a.benchmark)).size;
  const modalities = [...new Set([...benchmarks.values()].map((b) => b.modality))].sort();
  main.innerHTML = html`
    <h1 class="text-3xl font-bold" tabindex="-1">Benchmark rigor ratings</h1>
    <p class="mt-3 max-w-3xl text-muted">How rigorous are the benchmarks AI developers and policymakers rely on? Each column applies one published benchmark-quality standard, in its own units. Bars show a score's position on that standard's scale, so compare down a column, not across.</p>
    <p class="mt-2 text-sm text-muted">${rated} of ${benchmarks.size} benchmarks rated under ${encoded.length} encoded standards.
      ${watch ? `Sources are checked nightly; last checked ${watch.checked_on}.` : 'Nightly source checks have not run yet.'}</p>
    <div class="mt-6 flex flex-wrap items-end gap-3" role="search">
      <label class="grid gap-1 text-sm"><span>Search</span><input id="q" type="search" class="field w-56" placeholder="Name or concept" value="${state.q}" autocomplete="off"></label>
      <label class="grid gap-1 text-sm"><span>Domain</span>
        <select id="domain" class="field"><option value="">All</option><option value="safety">Safety</option><option value="capability">Capability</option></select></label>
      <label class="grid gap-1 text-sm"><span>Type</span>
        <select id="modality" class="field"><option value="">All</option>${modalities.map((m) => html`<option value="${m}">${m.replace('-', ' ')}</option>`)}</select></label>
      <label class="grid gap-1 text-sm"><span>Ratings from</span>
        <select id="source" class="field"><option value="all">Best available</option><option value="published">Reviewed only</option><option value="automated">Automated only</option></select></label>
    </div>
    <p id="count" class="mt-3 text-sm text-muted" aria-live="polite"></p>
    <div class="mt-2 overflow-x-auto">
      <table class="grid-table" role="grid" aria-labelledby="ratings-caption" aria-describedby="grid-help">
        <caption id="ratings-caption" class="sr-only">Benchmarks by standard</caption>
        <thead></thead><tbody></tbody>
      </table>
    </div>
    <p id="grid-help" class="mt-3 text-sm text-muted">Use the arrow keys to move through the table and Enter to open a benchmark. <span aria-hidden="true">≠</span> marks a published figure that differs from Touchstone's recomputation from the same verdicts.</p>
  `.s;
  for (const id of ['domain', 'modality', 'source'] as const) (document.getElementById(id) as HTMLSelectElement).value = state[id];
  const on = (id: string, ev: string, fn: (e: Event) => void) => document.getElementById(id)!.addEventListener(ev, fn);
  on('q', 'input', (e) => { state.q = (e.target as HTMLInputElement).value; state.focus = { row: 1, col: 0 }; drawGrid(false); });
  for (const id of ['domain', 'modality', 'source'] as const)
    on(id, 'change', (e) => { state[id] = (e.target as HTMLSelectElement).value; state.focus = { row: 1, col: 0 }; drawGrid(false); });
  drawGrid(false);
}

const columns = () => [
  { key: 'name', label: 'Benchmark' },
  { key: 'domain', label: 'Domain' },
  ...encoded.map((s) => ({ key: s.id, label: s.short })),
];

function drawGrid(focusCell: boolean) {
  const table = main.querySelector('table')!;
  const cols = columns();
  const rows = filteredBenchmarks();
  document.getElementById('count')!.textContent = `${rows.length} benchmark${rows.length === 1 ? '' : 's'} shown`;
  table.querySelector('thead')!.innerHTML = html`<tr role="row">${cols.map((c, i) => html`
    <th role="columnheader" scope="col" data-col="${i}" tabindex="-1" aria-sort="${state.sort === c.key ? (state.dir > 0 ? 'ascending' : 'descending') : 'none'}">
      <button type="button" class="sort-btn" tabindex="-1" data-sort="${c.key}">${c.label}</button></th>`)}</tr>`.s;
  table.querySelector('tbody')!.innerHTML = rows.map((b) => html`
    <tr role="row" data-bench="${b.id}">
      <th role="rowheader" scope="row" tabindex="-1" class="font-medium text-heading"><a href="#/benchmark/${b.id}" tabindex="-1" class="hover:text-brand">${b.name}</a>
        <div class="text-xs font-normal text-muted">${b.concept}</div></th>
      <td role="gridcell" tabindex="-1" class="text-sm capitalize">${b.domain}</td>
      ${encoded.map((s) => cell(b, s))}
    </tr>`.s).join('');
  state.focus.row = Math.min(state.focus.row, rows.length);
  setRoving(focusCell);
}

function cell(b: Benchmark, s: Standard): Raw {
  const p = primary(b.id, s.id, state.source);
  if (!p) {
    const why = inScope(s, b) ? 'Not rated yet' : 'Out of scope';
    return html`<td role="gridcell" tabindex="-1" data-std="${s.id}"><span class="text-sm text-muted">—</span><span class="sr-only">${why}</span></td>`;
  }
  const { a, r } = p;
  const draft = a.status === 'draft';
  const diff = r.discrepancies.length > 0;
  return html`<td role="gridcell" tabindex="-1" data-std="${s.id}" aria-label="${s.short}: ${r.overall.label}${draft ? ', automated draft' : ''}${diff ? ', published figure differs' : ''}">
    <div class="grid gap-1" aria-hidden="true">
      <span class="text-sm">${r.overall.label}${diff ? html` <span class="text-warn" title="Published figure differs from recomputation">≠</span>` : ''}${draft ? html` <span class="pill pill-draft">draft</span>` : ''}</span>
      ${bar(r.overall.pct)}
    </div></td>`;
}

/** Roving tabindex: exactly one cell in the grid is tabbable; arrow keys move it. */
function gridCells(): HTMLElement[][] {
  const table = main.querySelector('table');
  if (!table) return [];
  return [...table.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll<HTMLElement>('th, td')]);
}
function setRoving(focus: boolean) {
  const cells = gridCells();
  cells.flat().forEach((c) => (c.tabIndex = -1));
  if (!cells.length) return;
  const row = Math.max(0, Math.min(state.focus.row, cells.length - 1));
  const col = Math.max(0, Math.min(state.focus.col, cells[row]!.length - 1));
  state.focus = { row, col };
  const target = cells[row]![col]!;
  target.tabIndex = 0;
  if (focus) target.focus();
}
function onGridKey(e: KeyboardEvent) {
  const cell = (e.target as HTMLElement).closest('th, td') as HTMLElement | null;
  if (!cell || !main.querySelector('table')?.contains(cell)) return;
  const cells = gridCells();
  const rows = cells.length;
  let { row, col } = state.focus;
  const last = (r: number) => cells[r]!.length - 1;
  switch (e.key) {
    case 'ArrowRight': col = Math.min(col + 1, last(row)); break;
    case 'ArrowLeft': col = Math.max(col - 1, 0); break;
    case 'ArrowDown': row = Math.min(row + 1, rows - 1); break;
    case 'ArrowUp': row = Math.max(row - 1, 0); break;
    case 'PageDown': row = Math.min(row + 10, rows - 1); break;
    case 'PageUp': row = Math.max(row - 10, 0); break;
    case 'Home': col = 0; if (e.ctrlKey) row = 0; break;
    case 'End': col = last(row); if (e.ctrlKey) row = rows - 1; break;
    case 'Enter':
    case ' ': {
      e.preventDefault();
      if (row === 0) return sortBy(cell.querySelector<HTMLElement>('[data-sort]')!.dataset.sort!);
      return openFromRow(cell);
    }
    default: return;
  }
  e.preventDefault();
  state.focus = { row, col };
  setRoving(true);
}
function sortBy(key: string) {
  state.dir = state.sort === key ? -state.dir : key === 'name' || key === 'domain' ? 1 : -1;
  state.sort = key;
  drawGrid(true);
  const col = columns().find((c) => c.key === key)!;
  announce(`Sorted by ${col.label}, ${state.dir > 0 ? 'ascending' : 'descending'}`);
}
function openFromRow(cell: HTMLElement) {
  const tr = cell.closest('tr[data-bench]') as HTMLElement | null;
  if (!tr) return;
  state.lastBench = tr.dataset.bench!;
  const std = cell.dataset.std;
  location.hash = `#/benchmark/${tr.dataset.bench}${std ? `/${std}` : ''}`;
}
main.addEventListener('keydown', (e) => { if (main.querySelector('table[role="grid"]')) onGridKey(e); });
main.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const sortBtn = t.closest<HTMLElement>('[data-sort]');
  if (sortBtn) { const cells = gridCells(); state.focus = { row: 0, col: cells[0]!.findIndex((c) => c.contains(sortBtn)) }; return sortBy(sortBtn.dataset.sort!); }
  const cell = t.closest<HTMLElement>('tbody th, tbody td');
  if (cell && main.querySelector('table[role="grid"]')?.contains(cell)) {
    const cells = gridCells();
    const row = cells.findIndex((r) => r.includes(cell));
    state.focus = { row, col: cells[row]!.indexOf(cell) };
    if (!t.closest('a')) { e.preventDefault(); openFromRow(cell); } else state.lastBench = (cell.closest('tr') as HTMLElement).dataset.bench!;
  }
});

// ---------- Benchmark page ----------
function verdictPill(v: Verdict | undefined, scheme: string) {
  if (!v) return html`<span class="pill pill-unmet">no verdict</span>`;
  if (v.value === 'n/a') return html`<span class="pill pill-na">n/a</span>`;
  if (scheme === 'points') {
    const n = v.value as number;
    return html`<span class="pill ${n >= 15 ? 'pill-met' : n === 0 ? 'pill-unmet' : ''}">${n} / 15</span>`;
  }
  return html`<span class="pill ${v.value === 'met' ? 'pill-met' : 'pill-unmet'}">${v.value}</span>`;
}

const correctionUrl = (b: Benchmark, s: Standard, item?: string) => {
  const p = new URLSearchParams({ template: 'score-correction.yml', title: `Correction: ${b.name} / ${s.short}${item ? ` ${item}` : ''}`, benchmark: b.id, standard: s.id });
  if (item) p.set('items', item);
  return `${data.repo}/issues/new?${p.toString()}`;
};

function itemRow(b: Benchmark, s: Standard, it: Item, a: A) {
  const v = a.verdicts?.[it.id];
  const scheme = s.scoring!.scheme;
  return html`<li class="border-t border-line py-3">
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <code>${it.id}</code>
      ${verdictPill(v, scheme)}
      ${it.severity ? html`<span class="text-xs text-muted"><span class="sev sev-${it.severity}" aria-hidden="true"></span>${it.severity === 'baseline' ? 'baseline requirement' : `${it.severity}: caps at ${severityCap(s, it.severity)}`}</span>` : ''}
      ${v?.by ? html`<span class="text-xs text-muted">decided by ${v.by === 'model' ? 'model' : 'a person'}</span>` : ''}
    </div>
    <p class="mt-1">${it.text}</p>
    ${v?.rationale ? html`<p class="mt-1 text-sm"><span class="text-muted">Reasoning:</span> ${v.rationale}</p>` : ''}
    ${v?.evidence.length ? html`<ul class="mt-2 grid gap-2 text-sm" role="list">${v.evidence.map((e) => html`<li>
        ${e.quote ? html`<blockquote class="quote">“${e.quote}”</blockquote>` : ''}
        <a class="link" href="${safeUrl(e.url)}">${e.locator}</a>${e.note ? html` <span class="text-muted">${e.note}</span>` : ''}
      </li>`)}</ul>` : ''}
    ${it.guidance ? html`<p class="mt-2 text-xs text-muted">Met when: ${it.guidance.met}${it.guidance.not_applicable ? ` · n/a when: ${it.guidance.not_applicable}` : ''}</p>` : ''}
    <p class="mt-1 text-xs"><a class="link" href="${correctionUrl(b, s, it.id)}">Request a correction to ${it.id}</a></p>
  </li>`;
}
const severityCap = (s: Standard, sev: string) => (s.scoring?.scheme === 'aisl-severity' ? (s.scoring.severity_scores as Record<string, number>)[sev] : '');

function assessmentCard(b: Benchmark, s: Standard, a: A, open: boolean) {
  const r = results.get(a.file)!;
  const fileUrl = `${data.repo}/blob/main/${a.file}`;
  return html`<article class="card mt-4" aria-labelledby="h-${a.file.replace(/\W/g, '-')}">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h3 id="h-${a.file.replace(/\W/g, '-')}" class="text-base font-medium">${provenanceLabel(a)}</h3>
      <span class="text-sm">${a.status === 'draft' ? html`<span class="pill pill-draft">draft, not yet reviewed</span>` : html`<span class="pill">published</span>`}</span>
    </div>
    <p class="mt-3 text-2xl text-heading">${r.overall.label}</p>
    <p class="mt-1 text-sm">${r.overall.explanation}</p>
    ${r.discrepancies.length ? html`<div class="mt-3 rounded-md border border-line p-3 text-sm" role="note">
        <p class="font-medium text-warn">The source's published figures differ from a recomputation from its own verdicts</p>
        <ul class="mt-1 list-disc pl-5">${r.discrepancies.map((d) => html`<li>${d.field}: published ${d.published}, recomputed ${d.computed}</li>`)}</ul>
        ${a.notes ? html`<p class="mt-1 text-muted">${a.notes}</p>` : ''}
      </div>` : a.notes ? html`<p class="mt-2 text-sm text-muted">${a.notes}</p>` : ''}
    <table class="mt-4 w-full text-sm">
      <caption class="sr-only">Scores by ${s.short} dimension</caption>
      <thead><tr class="text-left text-muted"><th scope="col" class="py-1 pr-3 font-normal">Dimension</th><th scope="col" class="py-1 pr-3 font-normal">Score</th><th scope="col" class="py-1 font-normal">How it was calculated</th></tr></thead>
      <tbody>${r.groups.map((g) => html`<tr class="border-t border-line align-top">
        <th scope="row" class="py-2 pr-3 font-medium">${g.name}</th>
        <td class="py-2 pr-3"><div class="grid gap-1">${g.display}${bar(g.pct)}</div></td>
        <td class="py-2">${g.explanation}</td></tr>`)}</tbody>
    </table>
    ${a.mode === 'itemized' ? html`${s.groups.map((g) => html`<details class="mt-4" ${open ? 'open' : ''}>
        <summary class="font-medium">${g.name}: item verdicts (${g.items.length})</summary>
        <ul class="mt-2" role="list">${g.items.map((it) => itemRow(b, s, it, a))}</ul>
      </details>`)}` : html`<p class="mt-4 text-sm text-muted">Item-level verdicts were not published by this source, so only its dimension scores are shown.</p>`}
    <details class="mt-4 text-sm">
      <summary>Provenance and history</summary>
      <dl class="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        <dt class="text-muted">Assessed</dt><dd>${a.provenance.assessed_on} by ${a.provenance.assessors.join(', ')}${a.provenance.reviewers?.length ? `; reviewed by ${a.provenance.reviewers.join(', ')}` : ''}</dd>
        ${a.provenance.source_url ? html`<dt class="text-muted">Source</dt><dd><a class="link" href="${safeUrl(a.provenance.source_url)}">${a.provenance.source_title ?? a.provenance.source_url}</a></dd>` : ''}
        <dt class="text-muted">Standard</dt><dd>${s.name}, version ${a.standard_version}${a.provenance.standard_version_used ? ` (source used ${a.provenance.standard_version_used})` : ''}</dd>
        ${a.benchmark_ref ? html`<dt class="text-muted">Benchmark version</dt><dd>${[a.benchmark_ref.paper_version && `paper ${a.benchmark_ref.paper_version}`, a.benchmark_ref.repo_commit && `commit ${a.benchmark_ref.repo_commit.slice(0, 12)}`].filter(Boolean).join(', ')}</dd>` : ''}
        ${a.model_run ? html`<dt class="text-muted">Model</dt><dd>${a.model_run.model} (${a.model_run.license}, via ${a.model_run.provider}), temperature ${a.model_run.temperature}, seed ${a.model_run.seed}, prompt v${a.model_run.prompt_version}</dd>
          <dt class="text-muted">Transcript</dt><dd><a class="link" href="${data.repo}/blob/main/${a.model_run.transcript}">${a.model_run.transcript}</a></dd>` : ''}
        <dt class="text-muted">Record</dt><dd><a class="link" href="${fileUrl}">${a.file}</a></dd>
      </dl>
      <h4 class="mt-3 font-medium">Revisions</h4>
      <ol class="mt-1 grid gap-1">${a.revisions.map((rv) => html`<li>${rv.date} · ${rv.by}: ${rv.summary}${rv.request ? html` (<a class="link" href="${data.repo}/issues/${rv.request}">request #${rv.request}</a>)` : ''}</li>`)}</ol>
    </details>
    <p class="mt-4 text-sm"><a class="link" href="${correctionUrl(b, s)}">Request a correction to this assessment</a></p>
  </article>`;
}

function renderBenchmark(id: string, focusStd?: string) {
  const b = benchmarks.get(id);
  if (!b) return renderNotFound();
  const watched = data.watch?.benchmarks[b.id];
  const sections = (encoded as Standard[]).map((s) => {
    const list = pairs(b.id, s.id).sort((x, y) => rank(x) - rank(y));
    if (!list.length && !inScope(s, b)) return '';
    return html`<section id="std-${s.id}" class="mt-10" aria-labelledby="sec-${s.id}" tabindex="-1">
      <h2 id="sec-${s.id}" class="text-xl font-bold">${s.name}</h2>
      <p class="mt-1 text-sm text-muted">${s.description} <a class="link" href="#/standard/${s.id}">How ${s.short} is scored</a></p>
      ${list.length ? list.map((a) => assessmentCard(b, s, a, focusStd === s.id && list.length === 1)) : html`<p class="mt-3 text-sm">Not assessed yet. The nightly job will propose an automated assessment.</p>`}
    </section>`.s;
  }).join('');
  main.innerHTML = html`
    <p class="text-sm"><a class="link" href="#/">Ratings</a> <span aria-hidden="true">/</span> <span class="sr-only">current page:</span> ${b.name}</p>
    <h1 class="mt-2 text-3xl font-bold" tabindex="-1">${b.name}</h1>
    <p class="mt-2 text-muted">${b.concept} · <span class="capitalize">${b.domain}</span> · ${b.modality.replace('-', ' ')}${b.year ? ` · ${b.year}` : ''}</p>
    <ul class="mt-3 flex flex-wrap gap-4 text-sm" role="list">
      ${b.links.paper ? html`<li><a class="link" href="${safeUrl(b.links.paper)}">Paper</a>${watched?.paper_version ? ` (latest ${watched.paper_version})` : ''}</li>` : ''}
      ${b.links.repo ? html`<li><a class="link" href="${safeUrl(b.links.repo)}">Code</a>${watched?.repo_commit ? ` (at ${watched.repo_commit.slice(0, 7)}${watched.archived ? ', archived' : ''})` : ''}</li>` : ''}
      ${b.links.website ? html`<li><a class="link" href="${safeUrl(b.links.website)}">Website</a></li>` : ''}
    </ul>
    <nav aria-label="Standards on this page" class="mt-6"><ul class="flex flex-wrap gap-2" role="list">
      ${(encoded as Standard[]).filter((s) => pairs(b.id, s.id).length || inScope(s, b)).map((s) => html`<li><a class="btn-quiet" href="#/benchmark/${b.id}/${s.id}">${s.short}</a></li>`)}
    </ul></nav>
    ${raw_(sections)}
  `.s;
  return focusStd ? document.getElementById(`std-${focusStd}`) : null;
}

// ---------- Standards ----------
function renderStandards() {
  main.innerHTML = html`
    <h1 class="text-3xl font-bold" tabindex="-1">Standards</h1>
    <p class="mt-3 max-w-3xl text-muted">Published standards for judging benchmark quality. Encoded standards have every item written as a decision rule that Touchstone can score; catalogued ones are tracked but not encoded yet.</p>
    <ul class="mt-6 grid gap-4" role="list">${data.standards.map((s) => html`<li class="card">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h2 class="text-lg font-bold"><a class="hover:text-brand" href="#/standard/${s.id}">${s.name}</a></h2>
        <span class="pill ${s.status === 'encoded' ? 'pill-met' : 'pill-na'}">${s.status}</span>
      </div>
      <p class="mt-1 text-sm text-muted">${s.publisher}, ${s.year} · ${s.kind.replace('-', ' ')}</p>
      <p class="mt-2 text-sm">${s.description}</p>
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
      <table class="mt-3 text-sm"><thead><tr><th scope="col" class="pr-4 text-left">Category</th>${s.groups.map((g) => html`<th scope="col" class="pr-4 text-left">${g.name}</th>`)}<th scope="col" class="text-left">Fit for</th></tr></thead>
      <tbody>${sc.categories.map((c) => html`<tr class="border-t border-line"><th scope="row" class="pr-4 text-left">${c.id}</th>${s.groups.map((g) => html`<td class="pr-4">≤ ${c.max[g.id]}</td>`)}<td>${c.use}</td></tr>`)}</tbody></table>`;
  if (sc.scheme === 'points')
    return html`<p>Each criterion scores ${sc.levels.join(', ')}. ${Object.entries(sc.level_meanings ?? {}).sort((a, b) => Number(b[0]) - Number(a[0])).map(([k, v]) => `${k}: ${v} `).join('')}A stage's score is the mean of its applicable criteria; the overall score is the mean of all applicable criteria.</p>`;
  return html`<p>Each group's score is the share of applicable items met. The overall score is the mean of the group scores.${s.scoring_defined_by === 'touchstone' ? ' This standard publishes no scoring rule, so this one is Touchstone\'s.' : ''}</p>`;
}

function renderStandard(id: string) {
  const s = standards.get(id);
  if (!s) return renderNotFound();
  main.innerHTML = html`
    <p class="text-sm"><a class="link" href="#/standards">Standards</a> <span aria-hidden="true">/</span> ${s.short}</p>
    <h1 class="mt-2 text-3xl font-bold" tabindex="-1">${s.name}</h1>
    <p class="mt-2 text-muted">${s.publisher}, ${s.year} · version ${s.version} · <a class="link" href="${safeUrl(s.url)}">Source</a></p>
    <p class="mt-3 max-w-3xl">${s.description}</p>
    ${s.applies_to ? html`<p class="mt-2 text-sm text-muted">Applies to: ${s.applies_to}</p>` : ''}
    <h2 class="mt-8 text-xl font-bold">How it is scored</h2>
    <div class="mt-2 max-w-3xl text-sm">${scoringText(s)}</div>
    ${s.groups.map((g) => html`<section class="mt-8" aria-labelledby="g-${g.id}">
      <h2 id="g-${g.id}" class="text-xl font-bold">${g.name}</h2>
      ${g.description ? html`<p class="mt-1 text-sm text-muted">${g.description}</p>` : ''}
      <ul class="mt-3" role="list">${g.items.map((it) => html`<li class="border-t border-line py-3">
        <div class="flex flex-wrap items-baseline gap-3"><code>${it.id}</code>
          ${it.severity ? html`<span class="text-xs text-muted"><span class="sev sev-${it.severity}" aria-hidden="true"></span>${it.severity}</span>` : ''}</div>
        ${it.principle ? html`<p class="mt-1 text-xs text-muted">${it.principle}</p>` : ''}
        <p class="mt-1">${it.text}</p>
        ${it.guidance ? html`<p class="mt-1 text-sm"><span class="text-muted">Met when:</span> ${it.guidance.met}</p>
          ${it.guidance.not_applicable ? html`<p class="text-sm"><span class="text-muted">n/a when:</span> ${it.guidance.not_applicable}</p>` : ''}` : ''}
      </li>`)}</ul></section>`)}`.s;
}

function renderMethod() {
  main.innerHTML = html`
    <h1 class="text-3xl font-bold" tabindex="-1">How it works</h1>
    <div class="mt-4 grid max-w-3xl gap-4">
      <p>Touchstone separates judgement from arithmetic. People, or an open-weights model whose work people review, decide one verdict per item of a standard. Everything after that is a published, deterministic calculation: the same verdicts always give the same score, and every score on this site shows the calculation behind it.</p>
      <h2 class="mt-4 text-xl font-bold">Verdicts</h2>
      <p>Each item of each standard is written as a decision rule: what must be true for it to be met, and when it can be not applicable. A positive verdict must cite evidence at a pinned version: an arXiv version or a git commit, with an exact location and a short quote. Missing documentation counts as not met.</p>
      <h2 class="mt-4 text-xl font-bold">Live ratings</h2>
      <p>Every night a job checks each benchmark's latest paper version and repository commit. Where something changed, or a pair was never assessed, an open-weights model under an open-source licence proposes verdicts. It sees only excerpts selected deterministically from the pinned sources. Every quote it gives is checked word for word against the excerpt it cites; a positive verdict without a verified quote is changed to not met. The job opens a pull request, and nothing is published until a person reviews it.</p>
      <h2 class="mt-4 text-xl font-bold">Auditing a rating</h2>
      <p>Each automated assessment records the model, licence, settings, prompt version, and hashes of the exact text it read. Its transcript holds every response, including the model's reasoning when the model provides it. Running <code>touchstone replay</code> re-fetches the pinned sources and confirms they and every prompt match the record.</p>
      <h2 class="mt-4 text-xl font-bold">Corrections</h2>
      <p>If a verdict is wrong or missing information, use the "Request a correction" link beside it. A bot replies with the current record. Accepted changes land as pull requests, and every change is logged in the assessment's revision history with a link to the request.</p>
      <p><a class="link" href="${data.repo}/blob/main/docs/methodology.md">Full methodology</a> · <a class="link" href="${data.repo}/blob/main/docs/automation.md">Automation and auditing</a> · <a class="link" href="${data.repo}/blob/main/CONTRIBUTING.md">Contributing</a></p>
    </div>`.s;
}

function renderNotFound() {
  main.innerHTML = html`<h1 class="text-3xl font-bold" tabindex="-1">Not found</h1><p class="mt-3"><a class="link" href="#/">Back to ratings</a></p>`.s;
}

// ---------- Router ----------
function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [view, id, sub] = parts;
  let target: HTMLElement | null = null;
  let nav = 'ratings';
  if (!view || view === 'ratings') renderRatings();
  else if (view === 'benchmark' && id) target = renderBenchmark(id, sub) ?? null;
  else if (view === 'standards') { renderStandards(); nav = 'standards'; }
  else if (view === 'standard' && id) { renderStandard(id); nav = 'standards'; }
  else if (view === 'method') { renderMethod(); nav = 'method'; }
  else renderNotFound();
  document.querySelectorAll<HTMLAnchorElement>('[data-nav]').forEach((a) => (a.dataset.nav === nav ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  const h1 = main.querySelector('h1')!;
  document.title = `${h1.textContent} · Touchstone`;
  // Returning to the table puts focus back on the row the reader left from.
  if ((!view || view === 'ratings') && state.lastBench) {
    const cells = gridCells();
    const row = cells.findIndex((r) => (r[0]?.closest('tr') as HTMLElement | null)?.dataset.bench === state.lastBench);
    if (row > 0) { state.focus = { row, col: 0 }; setRoving(true); announce(`Ratings, at ${benchmarks.get(state.lastBench)?.name}`); return; }
  }
  (target ?? h1).focus();
  if (target) target.scrollIntoView();
  else window.scrollTo(0, 0);
  announce(h1.textContent ?? '');
}
window.addEventListener('hashchange', route);

// ---------- Global keys ----------
const dialog = document.getElementById('shortcuts') as HTMLDialogElement;
document.getElementById('shortcuts-open')!.addEventListener('click', () => dialog.showModal());
let pendingG = 0;
document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  const typing = t.closest('input, select, textarea, [contenteditable]');
  if (e.metaKey || e.altKey || (e.ctrlKey && !['Home', 'End'].includes(e.key))) return;
  if (e.key === 'Escape' && !dialog.open && location.hash.startsWith('#/benchmark/')) { e.preventDefault(); location.hash = '#/'; return; }
  if (typing || dialog.open) return;
  if (e.key === '/') { const q = document.getElementById('q') as HTMLInputElement | null; if (q) { e.preventDefault(); q.focus(); } else { e.preventDefault(); location.hash = '#/'; requestAnimationFrame(() => (document.getElementById('q') as HTMLInputElement)?.focus()); } return; }
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
const currentTheme = () => document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
const labelTheme = () => { const t = currentTheme(); themeBtn.textContent = t === 'dark' ? 'Light theme' : 'Dark theme'; };
themeBtn.addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch {}
  labelTheme();
});
labelTheme();
(document.getElementById('repo-link') as HTMLAnchorElement).href = data.repo;

route();
