import './styles.css';
import type { BenchmarkFile, SiteIndex, Summary } from '../../src/build.ts';
import type { Assessment, Benchmark, Item, Standard, Verdict } from '../../src/schema.ts';
import type { Improvement, Result } from '../../src/engine.ts';

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
let benchmarks = new Map<string, Benchmark>();
let byPair = new Map<string, Summary[]>();
type A = Assessment & { file: string };
type R = Result & { file: string; improvements: Improvement[] };
const pairs = (b: string, s: string) => byPair.get(`${b}|${s}`) ?? [];
const inScope = (s: IStd, b: Benchmark) =>
  (!s.scope?.modalities || s.scope.modalities.includes(b.modality)) && (!s.scope?.domains || s.scope.domains.includes(b.domain));

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

// ---------- Ratings: a table from 640px up, a list of cards below ----------
const wide = matchMedia('(min-width: 40rem)');
const state = { q: '', domain: '', modality: '', source: 'all', sort: 'name', dir: 1, focus: { row: 1, col: 0 }, lastBench: '' };
let wantSearch = false;

function filteredBenchmarks(): Benchmark[] {
  const q = state.q.toLowerCase();
  const rows = [...benchmarks.values()].filter((b) =>
    (!q || b.name.toLowerCase().includes(q) || b.id.includes(q) || b.concept.toLowerCase().includes(q)) &&
    (!state.domain || b.domain === state.domain) && (!state.modality || b.modality === state.modality));
  const key = (b: Benchmark): number | string => {
    if (state.sort === 'name') return b.name.toLowerCase();
    if (state.sort === 'domain') return b.domain;
    return primary(b.id, state.sort, state.source)?.pct ?? -1;
  };
  return rows.sort((x, y) => {
    const a = key(x), c = key(y);
    const cmp = typeof a === 'number' && typeof c === 'number' ? a - c : String(a).localeCompare(String(c));
    return cmp * state.dir || x.name.localeCompare(y.name);
  });
}

function renderRatings() {
  const watch = data.watch;
  const rated = new Set(data.summaries.map((a) => a.benchmark)).size;
  const modalities = [...new Set([...benchmarks.values()].map((b) => b.modality))].sort();
  main.innerHTML = html`
    <h1 class="t-page" tabindex="-1">Benchmark rigor ratings</h1>
    <p class="mt-4 max-w-3xl text-lg text-muted">How rigorous are the benchmarks AI developers and policymakers rely on? Each standard is scored in its own units, so compare down one standard, not across.</p>
    <p class="t-caption mt-3">${rated} of ${benchmarks.size} benchmarks rated under ${encoded.length} encoded standards.
      ${watch ? `Sources are checked nightly; last checked ${watch.checked_on}.` : 'Nightly source checks have not run yet.'}</p>
    <div class="mt-8 flex flex-wrap items-end gap-3" role="search">
      <label class="grid w-full gap-1 text-sm sm:w-auto"><span>Search</span><input id="q" type="search" class="field sm:w-56" placeholder="Name or concept" value="${state.q}" autocomplete="off"></label>
      <label class="grid gap-1 text-sm"><span>Domain</span>
        <select id="domain" class="field"><option value="">All</option><option value="safety">Safety</option><option value="capability">Capability</option></select></label>
      <label class="grid gap-1 text-sm"><span>Type</span>
        <select id="modality" class="field"><option value="">All</option>${modalities.map((m) => html`<option value="${m}">${m.replace('-', ' ')}</option>`)}</select></label>
      <label class="grid gap-1 text-sm"><span>Ratings from</span>
        <select id="source" class="field"><option value="all">Best available</option><option value="published">Reviewed only</option><option value="automated">Automated only</option></select></label>
      <label class="grid gap-1 text-sm sm:hidden"><span>Sort by</span>
        <select id="sort" class="field"><option value="name">Name</option><option value="domain">Domain</option>${encoded.map((s) => html`<option value="${s.id}">${s.short}</option>`)}</select></label>
    </div>
    <p id="count" class="t-caption mt-4" aria-live="polite"></p>
    <div id="results" class="mt-2"></div>
    <p id="grid-help" class="t-caption mt-4"></p>
  `.s;
  for (const id of ['domain', 'modality', 'source', 'sort'] as const) (document.getElementById(id) as HTMLSelectElement).value = state[id];
  const on = (id: string, ev: string, fn: (e: Event) => void) => document.getElementById(id)!.addEventListener(ev, fn);
  on('q', 'input', (e) => { state.q = (e.target as HTMLInputElement).value; state.focus = { row: 1, col: 0 }; draw(false); });
  for (const id of ['domain', 'modality', 'source'] as const)
    on(id, 'change', (e) => { state[id] = (e.target as HTMLSelectElement).value; state.focus = { row: 1, col: 0 }; draw(false); });
  on('sort', 'change', (e) => {
    state.sort = (e.target as HTMLSelectElement).value;
    state.dir = state.sort === 'name' || state.sort === 'domain' ? 1 : -1;
    draw(false);
  });
  draw(false);
}
wide.addEventListener('change', () => { if (document.getElementById('results')) draw(false); });

const columns = () => [
  { key: 'name', label: 'Benchmark' },
  { key: 'domain', label: 'Domain' },
  ...encoded.map((s) => ({ key: s.id, label: s.short })),
];

function draw(focusCell: boolean) {
  const rows = filteredBenchmarks();
  document.getElementById('count')!.textContent = `${rows.length} benchmark${rows.length === 1 ? '' : 's'} shown`;
  const box = document.getElementById('results')!;
  const help = document.getElementById('grid-help')!;
  const legend = `<span aria-hidden="true">≠</span> marks a published figure that differs from Touchstone's recomputation from the same verdicts. “draft” is an automated assessment not yet reviewed.`;
  if (!wide.matches) {
    box.innerHTML = html`<ul class="cards" role="list">${rows.map(cardView)}</ul>`.s;
    help.innerHTML = `Use the up and down arrow keys to move between benchmarks and Enter to open one. ${legend}`;
    return;
  }
  help.innerHTML = `Use the arrow keys to move through the table and Enter to open a benchmark. ${legend}`;
  if (!box.querySelector('table'))
    box.innerHTML = `<div class="table-wrap"><table class="grid-table" role="grid" aria-labelledby="ratings-caption" aria-describedby="grid-help"><caption id="ratings-caption" class="sr-only">Benchmarks by standard</caption><thead></thead><tbody></tbody></table></div>`;
  const table = box.querySelector('table')!;
  const cols = columns();
  table.querySelector('thead')!.innerHTML = html`<tr role="row">${cols.map((c, i) => html`
    <th role="columnheader" scope="col" data-col="${i}" tabindex="-1" aria-sort="${state.sort === c.key ? (state.dir > 0 ? 'ascending' : 'descending') : 'none'}">
      <button type="button" class="sort-btn" tabindex="-1" data-sort="${c.key}">${c.label}</button></th>`)}</tr>`.s;
  table.querySelector('tbody')!.innerHTML = rows.map((b) => html`
    <tr role="row" data-bench="${b.id}" data-prefetch="benchmarks/${b.id}.json">
      <th role="rowheader" scope="row" tabindex="-1" class="font-medium text-heading"><a href="#/benchmark/${b.id}" tabindex="-1" class="hover:text-brand">${b.name}</a>
        <div class="t-caption font-normal">${b.concept}</div></th>
      <td role="gridcell" tabindex="-1"><span class="chip">${b.domain}</span></td>
      ${encoded.map((s) => cell(b, s))}
    </tr>`.s).join('');
  state.focus.row = Math.min(state.focus.row, rows.length);
  setRoving(focusCell);
}

function cell(b: Benchmark, s: IStd): Raw {
  const p = primary(b.id, s.id, state.source);
  if (!p) {
    const why = inScope(s, b) ? 'Not rated yet' : 'Out of scope';
    return html`<td role="gridcell" tabindex="-1" data-std="${s.id}"><span class="text-sm text-muted">—</span><span class="sr-only">${why}</span></td>`;
  }
  return html`<td role="gridcell" tabindex="-1" data-std="${s.id}" aria-label="${s.short}: ${p.label}${p.status === 'draft' ? ', automated draft' : ''}${p.discrepancies ? ', published figure differs' : ''}">
    <div class="grid gap-1.5" aria-hidden="true">
      <span class="flex flex-wrap items-center gap-1.5 text-sm">${labelView(p.label)}${chips(p)}</span>
      ${bar(p.pct)}
    </div></td>`;
}

/** Phones: one card per benchmark; only standards with a rating get a line. */
function cardView(b: Benchmark): Raw {
  const rated = encoded.map((s) => [s, primary(b.id, s.id, state.source)] as const).filter((x): x is [IStd, Summary] => !!x[1]);
  const missing = encoded.length - rated.length;
  return html`<li><a class="bcard" href="#/benchmark/${b.id}" data-bench="${b.id}" data-prefetch="benchmarks/${b.id}.json">
    <div class="flex items-start justify-between gap-3"><span class="t-sub">${b.name}</span><span class="chip">${b.domain}</span></div>
    <div class="t-caption mt-1">${b.concept}</div>
    ${rated.length ? html`<div class="mt-4 grid gap-3">${rated.map(([s, p]) => html`<div>
      <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm"><span class="text-muted">${s.short}</span>
        <span class="flex flex-wrap items-center gap-1.5">${labelView(p.label)}${chips(p)}</span></div>
      <div class="mt-1.5">${bar(p.pct)}</div></div>`)}</div>` : ''}
    ${missing ? html`<div class="t-caption mt-3">+${missing} not rated</div>` : ''}
  </a></li>`;
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
/** Card list: a list of links. Up/Down move between cards; Enter is the link's own. */
function onCardKey(e: KeyboardEvent) {
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('.bcard');
  if (!a || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
  const all = [...main.querySelectorAll<HTMLAnchorElement>('.bcard')];
  const next = all[all.indexOf(a) + (e.key === 'ArrowDown' ? 1 : -1)];
  e.preventDefault();
  next?.focus();
}
function sortBy(key: string) {
  state.dir = state.sort === key ? -state.dir : key === 'name' || key === 'domain' ? 1 : -1;
  state.sort = key;
  draw(true);
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
main.addEventListener('keydown', (e) => {
  if (main.querySelector('table[role="grid"]')) onGridKey(e);
  else if (main.querySelector('.cards')) onCardKey(e);
});
main.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('[data-retry]')) return void (data ? route() : init());
  const f = t.closest<HTMLButtonElement>('[data-f]');
  if (f) return setFilter(f);
  const sortBtn = t.closest<HTMLElement>('[data-sort]');
  if (sortBtn) { const cells = gridCells(); state.focus = { row: 0, col: cells[0]!.findIndex((c) => c.contains(sortBtn)) }; return sortBy(sortBtn.dataset.sort!); }
  const card = t.closest<HTMLElement>('.bcard');
  if (card) { state.lastBench = card.dataset.bench!; return; }
  const cell = t.closest<HTMLElement>('tbody th, tbody td');
  if (cell && main.querySelector('table[role="grid"]')?.contains(cell)) {
    const cells = gridCells();
    const row = cells.findIndex((r) => r.includes(cell));
    state.focus = { row, col: cells[row]!.indexOf(cell) };
    if (!t.closest('a')) { e.preventDefault(); openFromRow(cell); } else state.lastBench = (cell.closest('tr') as HTMLElement).dataset.bench!;
  }
});
// A benchmark's JSON starts loading as soon as its row or card is hovered or focused.
const warm = (e: Event) => { const el = (e.target as HTMLElement).closest<HTMLElement>('[data-prefetch]'); if (el) prefetch(el.dataset.prefetch!); };
main.addEventListener('mouseover', warm);
main.addEventListener('focusin', warm);

// ---------- Benchmark page ----------
const maxOf = (s: Standard) => (s.scoring?.scheme === 'points' ? s.scoring.max : 15);
type VClass = 'met' | 'unmet' | 'na';
/** Missing verdicts count as not met (undocumented means unsatisfied); for points, anything below the maximum is not met. */
function vclass(v: Verdict | undefined, s: Standard): VClass {
  if (!v) return 'unmet';
  if (v.value === 'n/a') return 'na';
  if (typeof v.value === 'number') return v.value >= maxOf(s) ? 'met' : 'unmet';
  return v.value === 'met' ? 'met' : 'unmet';
}
function verdictPill(v: Verdict | undefined, s: Standard) {
  if (!v) return html`<span class="pill pill-unmet"><span aria-hidden="true">✕</span> no verdict</span>`;
  if (v.value === 'n/a') return html`<span class="pill pill-na"><span aria-hidden="true">–</span> n/a</span>`;
  if (typeof v.value === 'number') {
    const c = vclass(v, s);
    return html`<span class="pill ${c === 'met' ? 'pill-met' : v.value === 0 ? 'pill-unmet' : ''}"><span aria-hidden="true">${c === 'met' ? '✓' : v.value === 0 ? '✕' : '◐'}</span> ${v.value} / ${maxOf(s)}</span>`;
  }
  return v.value === 'met' ? html`<span class="pill pill-met"><span aria-hidden="true">✓</span> met</span>` : html`<span class="pill pill-unmet"><span aria-hidden="true">✕</span> not met</span>`;
}

const correctionUrl = (b: Benchmark, s: IStd, item?: string) => {
  const p = new URLSearchParams({ template: 'score-correction.yml', title: `Correction: ${b.name} / ${s.short}${item ? ` ${item}` : ''}`, benchmark: b.id, standard: s.id });
  if (item) p.set('items', item);
  return `${data.repo}/issues/new?${p.toString()}`;
};

function itemRow(b: Benchmark, s: Standard, it: Item, a: A) {
  const v = a.verdicts?.[it.id];
  return html`<li class="border-t border-line py-4" data-v="${vclass(v, s)}">
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <code>${it.id}</code>
      ${verdictPill(v, s)}
      ${it.severity ? html`<span class="t-caption"><span class="sev sev-${it.severity}" aria-hidden="true"></span>${it.severity === 'baseline' ? 'baseline requirement' : `${it.severity}: caps at ${severityCap(s, it.severity)}`}</span>` : ''}
      ${v?.by ? html`<span class="t-caption">decided by ${v.by === 'model' ? 'model' : 'a person'}</span>` : ''}
    </div>
    <p class="mt-1.5">${it.text}</p>
    ${v?.rationale ? html`<p class="mt-1.5 text-sm"><span class="text-muted">Reasoning:</span> ${v.rationale}</p>` : ''}
    ${v?.evidence.length ? html`<ul class="mt-2 grid gap-2 text-sm" role="list">${v.evidence.map((e) => html`<li>
        ${e.quote ? html`<blockquote class="quote">“${e.quote}”</blockquote>` : ''}
        <a class="link" href="${safeUrl(e.url)}">${e.locator}</a>${e.note ? html` <span class="text-muted">${e.note}</span>` : ''}
      </li>`)}</ul>` : ''}
    ${it.guidance ? html`<p class="t-caption mt-2">Met when: ${it.guidance.met}${it.guidance.not_applicable ? ` · n/a when: ${it.guidance.not_applicable}` : ''}</p>` : ''}
    <p class="t-caption mt-1"><a class="link" href="${correctionUrl(b, s, it.id)}">Request a correction to ${it.id}</a></p>
  </li>`;
}
const severityCap = (s: Standard, sev: string) => (s.scoring?.scheme === 'aisl-severity' ? (s.scoring.severity_scores as Record<string, number>)[sev] : '');

/** All / Not met / Met / N/A, each with its count. The list itself is filtered by CSS on the card's data-filter. */
function filterBar(s: Standard, a: A) {
  const n = { all: 0, unmet: 0, met: 0, na: 0 };
  for (const it of s.groups.flatMap((g) => g.items)) { n.all++; n[vclass(a.verdicts?.[it.id], s)]++; }
  const btn = (k: keyof typeof n, label: string) => html`<button type="button" class="filter-btn" data-f="${k}" aria-pressed="${k === 'all'}">${label} <span class="tabular-nums">(${n[k]})</span></button>`;
  return html`<div role="group" aria-label="Filter items" class="mt-6 flex flex-wrap items-center gap-2"><span class="t-caption mr-1">Show items</span>
    ${btn('all', 'All')}${btn('unmet', 'Not met')}${btn('met', 'Met')}${btn('na', 'N/A')}</div>`;
}
function setFilter(btn: HTMLButtonElement) {
  const card = btn.closest<HTMLElement>('article')!;
  card.dataset.filter = btn.dataset.f;
  btn.parentElement!.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === btn)));
  if (btn.dataset.f !== 'all') card.querySelectorAll('details.items').forEach((d) => ((d as HTMLDetailsElement).open = true));
  const shown = card.querySelectorAll(`li[data-v${btn.dataset.f === 'all' ? '' : `="${btn.dataset.f}"`}]`).length;
  announce(`Showing ${shown} item${shown === 1 ? '' : 's'}`);
}

function improvementsView(s: Standard, r: R) {
  const text = new Map(s.groups.flatMap((g) => g.items).map((i) => [i.id, i.text]));
  return html`<section class="mt-6" aria-labelledby="imp-${r.file.replace(/\W/g, '-')}">
    <h4 id="imp-${r.file.replace(/\W/g, '-')}" class="font-medium">What would most improve this rating</h4>
    ${r.improvements.length ? html`<ol class="mt-2 grid gap-3 text-sm" role="list">${r.improvements.map((m) => html`<li>
        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1"><code>${m.item}</code>${m.blocking ? html`<span class="pill pill-diff">blocking</span>` : ''}
          <span>${m.group}: ${m.groupFrom} → ${m.groupTo} · Overall: ${m.overallFrom} → ${m.overallTo}</span></div>
        <p class="mt-1">${text.get(m.item)}</p></li>`)}</ol>` : html`<p class="mt-2 text-sm text-muted">Every applicable item is met</p>`}
  </section>`;
}

function assessmentCard(b: Benchmark, s: Standard, a: A, r: R, open: boolean) {
  const fileUrl = `${data.repo}/blob/main/${a.file}`;
  const id = a.file.replace(/\W/g, '-');
  return html`<article class="card mt-5" aria-labelledby="h-${id}" data-filter="all">
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <h3 id="h-${id}" class="t-sub">${provenanceLabel(a)}</h3>
      <span class="text-sm">${a.status === 'draft' ? html`<span class="pill pill-draft">draft, not yet reviewed</span>` : html`<span class="pill">published</span>`}</span>
    </div>
    <p class="mt-4">${labelView(r.overall.label, true)}</p>
    <p class="mt-2 text-sm">${r.overall.explanation}</p>
    ${r.discrepancies.length ? html`<div class="mt-4 rounded-md border border-line p-3 text-sm" role="note">
        <p class="font-medium text-warn"><span aria-hidden="true">≠</span> The source's published figures differ from a recomputation from its own verdicts</p>
        <ul class="mt-1 list-disc pl-5">${r.discrepancies.map((d) => html`<li>${d.field}: published ${d.published}, recomputed ${d.computed}</li>`)}</ul>
        ${a.notes ? html`<p class="mt-1 text-muted">${a.notes}</p>` : ''}
      </div>` : a.notes ? html`<p class="mt-2 text-sm text-muted">${a.notes}</p>` : ''}
    <div class="table-wrap mt-5"><table class="w-full text-sm">
      <caption class="sr-only">Scores by ${s.short} dimension</caption>
      <thead><tr class="text-left text-muted"><th scope="col" class="px-3 py-2 font-normal">Dimension</th><th scope="col" class="px-3 py-2 font-normal">Score</th><th scope="col" class="px-3 py-2 font-normal">How it was calculated</th></tr></thead>
      <tbody>${r.groups.map((g) => html`<tr class="border-t border-line align-top">
        <th scope="row" class="px-3 py-2.5 text-left font-medium">${g.name}</th>
        <td class="px-3 py-2.5"><div class="grid gap-1">${g.display}${bar(g.pct)}</div></td>
        <td class="px-3 py-2.5">${g.explanation}</td></tr>`)}</tbody>
    </table></div>
    ${a.mode === 'itemized' ? html`${improvementsView(s, r)}${filterBar(s, a)}${s.groups.map((g) => html`<details class="items mt-3" ${open ? 'open' : ''}>
        <summary class="font-medium">${g.name}: item verdicts (${g.items.length})</summary>
        <ul class="mt-2" role="list">${g.items.map((it) => itemRow(b, s, it, a))}</ul>
      </details>`)}` : html`<p class="mt-5 text-sm text-muted">Item-level verdicts were not published by this source, so only its dimension scores are shown.</p>`}
    <details class="mt-5 text-sm">
      <summary>Provenance and history</summary>
      <dl class="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
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
    <p class="mt-5 text-sm"><a class="link" href="${correctionUrl(b, s)}">Request a correction to this assessment</a></p>
  </article>`;
}

/** The benchmark's file plus the full standards its assessments need, fetched in parallel. */
async function loadBenchmark(b: Benchmark) {
  const used = encoded.filter((s) => pairs(b.id, s.id).length);
  const [file, ...full] = await Promise.all([getJson<BenchmarkFile>(`benchmarks/${b.id}.json`), ...used.map((s) => getJson<Standard>(`standards/${s.id}.json`))]);
  return { file, std: new Map(full.map((s) => [s.id, s])) };
}

function renderBenchmark(b: Benchmark, file: BenchmarkFile, full: Map<string, Standard>, focusStd?: string): HTMLElement | null {
  const watched = data.watch?.benchmarks[b.id];
  const results = new Map(file.results.map((r) => [r.file, r]));
  const shown = encoded.filter((s) => pairs(b.id, s.id).length || inScope(s, b));
  const link = (s: IStd) => `#/benchmark/${b.id}/${s.id}`;
  const sections = shown.map((s) => {
    const list = file.assessments.filter((a) => a.standard === s.id).sort((x, y) => rank({ status: x.status, kind: x.provenance.kind } as Summary) - rank({ status: y.status, kind: y.provenance.kind } as Summary));
    const fs = full.get(s.id);
    return html`<section id="std-${s.id}" class="mt-12 first:mt-0" aria-labelledby="sec-${s.id}" tabindex="-1">
      <h2 id="sec-${s.id}" class="t-section">${s.name}</h2>
      <p class="mt-2 text-sm text-muted">${s.description} <a class="link" href="#/standard/${s.id}">How ${s.short} is scored</a></p>
      ${list.length && fs ? list.map((a) => assessmentCard(b, fs, a, results.get(a.file)!, focusStd === s.id && list.length === 1)) : html`<p class="mt-4 text-sm">Not assessed yet. The nightly job will propose an automated assessment.</p>`}
    </section>`.s;
  }).join('');
  const tile = (s: IStd) => {
    const p = primary(b.id, s.id, 'all');
    return html`<li><a class="tile" href="${link(s)}">
      <span class="t-caption">${s.short}</span>
      <span class="mt-1 flex flex-wrap items-center gap-1.5">${p ? labelView(p.label) : html`<span class="text-sm text-muted">Not rated yet</span>`}${p ? chips(p) : ''}</span>
      ${p ? html`<span class="mt-2 block">${bar(p.pct)}</span>` : ''}</a></li>`;
  };
  main.innerHTML = html`
    <p class="text-sm"><a class="link" href="#/">Ratings</a> <span aria-hidden="true">/</span> <span class="sr-only">current page:</span> ${b.name}</p>
    <h1 class="t-page mt-3" tabindex="-1">${b.name}</h1>
    <p class="mt-3 text-lg text-muted">${b.concept}</p>
    <p class="t-caption mt-2"><span class="capitalize">${b.domain}</span> · ${b.modality.replace('-', ' ')}${b.year ? ` · ${b.year}` : ''}</p>
    <ul class="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-sm" role="list">
      ${b.links.paper ? html`<li><a class="link" href="${safeUrl(b.links.paper)}">Paper</a>${watched?.paper_version ? ` (latest ${watched.paper_version})` : ''}</li>` : ''}
      ${b.links.repo ? html`<li><a class="link" href="${safeUrl(b.links.repo)}">Code</a>${watched?.repo_commit ? ` (at ${watched.repo_commit.slice(0, 7)}${watched.archived ? ', archived' : ''})` : ''}</li>` : ''}
      ${b.links.website ? html`<li><a class="link" href="${safeUrl(b.links.website)}">Website</a></li>` : ''}
    </ul>
    <ul class="strip mt-8" role="list" aria-label="Summary by standard">${shown.map(tile)}</ul>
    <nav aria-label="Standards on this page (chips)" class="chip-row mt-8 lg:hidden"><ul class="flex gap-2" role="list">
      ${shown.map((s) => html`<li class="shrink-0"><a class="btn-quiet" href="${link(s)}">${s.short}</a></li>`)}
    </ul></nav>
    <div class="mt-10 lg:grid lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-10">
      <nav aria-label="Standards on this page" class="rail hidden lg:block"><ul role="list">
        ${shown.map((s) => html`<li><a href="${link(s)}">${s.short}</a></li>`)}
      </ul></nav>
      <div class="min-w-0">${raw_(sections)}</div>
    </div>
  `.s;
  return focusStd ? document.getElementById(`std-${focusStd}`) : null;
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
      <tbody>${sc.categories.map((c) => html`<tr class="border-t border-line"><th scope="row" class="px-3 py-2 text-left">${labelView(`Category ${c.id}`)}</th>${s.groups.map((g) => html`<td class="px-3 py-2">≤ ${c.max[g.id]}</td>`)}<td class="px-3 py-2">${c.use}</td></tr>`)}</tbody></table></div>`;
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
      <p>Touchstone separates judgement from arithmetic. People, or an open-weights model whose work people review, decide one verdict per item of a standard. Everything after that is a published, deterministic calculation: the same verdicts always give the same score, and every score on this site shows the calculation behind it.</p>
      <h2 class="t-section mt-6">Verdicts</h2>
      <p>Each item of each standard is written as a decision rule: what must be true for it to be met, and when it can be not applicable. A positive verdict must cite evidence at a pinned version: an arXiv version or a git commit, with an exact location and a short quote. Missing documentation counts as not met.</p>
      <h2 class="t-section mt-6">Live ratings</h2>
      <p>Every night a job checks each benchmark's latest paper version and repository commit. Where something changed, or a pair was never assessed, an open-weights model under an open-source licence proposes verdicts. It sees only excerpts selected deterministically from the pinned sources. Every quote it gives is checked word for word against the excerpt it cites; a positive verdict without a verified quote is changed to not met. The job opens a pull request, and nothing is published until a person reviews it.</p>
      <h2 class="t-section mt-6">Auditing a rating</h2>
      <p>Each automated assessment records the model, licence, settings, prompt version, and hashes of the exact text it read. Its transcript holds every response, including the model's reasoning when the model provides it. Running <code>touchstone replay</code> re-fetches the pinned sources and confirms they and every prompt match the record.</p>
      <h2 class="t-section mt-6">Corrections</h2>
      <p>If a verdict is wrong or missing information, use the "Request a correction" link beside it. A bot replies with the current record. Accepted changes land as pull requests, and every change is logged in the assessment's revision history with a link to the request.</p>
      <p><a class="link" href="${data.repo}/blob/main/docs/methodology.md">Full methodology</a> · <a class="link" href="${data.repo}/blob/main/docs/automation.md">Automation and auditing</a> · <a class="link" href="${data.repo}/blob/main/CONTRIBUTING.md">Contributing</a></p>
    </div>`.s;
}

function renderNotFound() {
  main.innerHTML = html`<h1 class="t-page" tabindex="-1">Not found</h1><p class="mt-4"><a class="link" href="#/">Back to ratings</a></p>`.s;
}
function renderError() {
  main.innerHTML = html`<h1 class="t-page" tabindex="-1">Could not load this page</h1><p class="mt-4">The data file did not load. Check your connection and try again.</p><p class="mt-4"><button type="button" class="btn" data-retry>Try again</button></p>`.s;
}

// ---------- Router ----------
let seq = 0;
let shown = ''; // what the page currently shows, so a link to a section of the same benchmark just scrolls
async function route() {
  const my = ++seq;
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [view, id, sub] = parts;
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
    if (!view || view === 'ratings') { renderRatings(); shown = 'ratings'; }
    else if (view === 'benchmark' && id) {
      const b = benchmarks.get(id);
      if (!b) { renderNotFound(); shown = ''; }
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
      if (!standards.has(id)) { renderNotFound(); shown = ''; }
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
      const name = benchmarks.get(state.lastBench)?.name;
      if (wide.matches) {
        const row = gridCells().findIndex((r) => (r[0]?.closest('tr') as HTMLElement | null)?.dataset.bench === state.lastBench);
        if (row > 0) { state.focus = { row, col: 0 }; setRoving(true); announce(`Ratings, at ${name}`); return; }
      } else {
        const card = main.querySelector<HTMLElement>(`.bcard[data-bench="${CSS.escape(state.lastBench)}"]`);
        if (card) { card.focus(); announce(`Ratings, at ${name}`); return; }
      }
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
  if (e.key === 'Escape' && !dialog.open && location.hash.startsWith('#/benchmark/')) { e.preventDefault(); location.hash = '#/'; return; }
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
const currentTheme = () => document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
const labelTheme = () => { const t = currentTheme(); themeBtn.textContent = t === 'dark' ? 'Light theme' : 'Dark theme'; };
themeBtn.addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch {}
  labelTheme();
});
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
