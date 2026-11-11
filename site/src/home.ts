// Narrative overview page (#/). Every number is computed from the data at runtime.
import type { SiteIndex } from '../../src/build.ts';
import { CATS, coverage, type Cat } from './coverage.ts';

// Same escaping contract as main.ts's html helper: values are text unless wrapped in Raw.
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
class Raw { constructor(readonly s: string) {} }
function html(strings: TemplateStringsArray, ...vals: unknown[]): Raw {
  let out = strings[0]!;
  vals.forEach((v, i) => {
    out += (Array.isArray(v) ? v.map((x) => (x instanceof Raw ? x.s : esc(x))).join('') : v instanceof Raw ? v.s : v === false || v == null ? '' : esc(v)) + strings[i + 1]!;
  });
  return new Raw(out);
}

const GRADES = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
const BANDS = [{ g: 'F', lo: 0, hi: 25 }, { g: 'E', lo: 25, hi: 40 }, { g: 'D', lo: 40, hi: 55 }, { g: 'C', lo: 55, hi: 70 }, { g: 'B', lo: 70, hi: 85 }, { g: 'A', lo: 85, hi: 100 }];
const CAT_LABEL: Record<Cat, string> = { reviewed: 'Reviewed', draft: 'Draft', pending: 'Not yet assessed', na: 'Does not apply', blocked: "Can't be encoded" };
const MODALITY: Record<string, string> = { 'lm-agent': 'Language-model agent', 'language-model': 'Language model', 'rl-agent': 'Reinforcement-learning agent', classifier: 'Classifier', 'scientific-ml': 'Scientific ML' };
const modalityName = (m: string) => MODALITY[m] ?? m.replace(/-/g, ' ');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** "A, B and C" */
const list = (xs: string[]) => new Intl.ListFormat('en').format(xs);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2) : 0; };

let observers: IntersectionObserver[] = [];

/** Beeswarm: dots on one row of the strip plot, nudged vertically so none overlap. */
function swarm(xs: number[], r: number) {
  const placed: { x: number; y: number }[] = [];
  const step = 2 * r + 1;
  return xs.map((x) => {
    for (let k = 0; ; k++) {
      const y = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * step;
      if (placed.every((p) => Math.hypot(p.x - x, p.y - y) >= step)) { placed.push({ x, y }); return y; }
    }
  });
}

function strip(data: SiteIndex) {
  const W = 600, X0 = 14, X1 = 586, R = 7;
  const px = (v: number) => X0 + (v / 100) * (X1 - X0);
  const rows = (['safety', 'capability'] as const).map((d) => {
    const bs = data.benchmarks.filter((b) => b.domain === d && b.touchstone.rigor.grade && b.touchstone.rigor.score != null).sort((a, b) => a.touchstone.rigor.score! - b.touchstone.rigor.score!);
    const ys = swarm(bs.map((b) => px(b.touchstone.rigor.score!)), R);
    const reach = Math.max(0, ...ys.map(Math.abs)) + R;
    return { d, bs, ys, reach };
  });
  let y = 34; // room for the band letters
  const placed = rows.map((r) => { const top = y; const cy = top + 22 + r.reach; y = cy + r.reach + 12; return { ...r, top, cy }; });
  const axisY = y + 4, H = axisY + 26;
  let i = 0;
  const svg = html`<svg class="strip-svg" viewBox="0 0 ${W} ${H}" role="group" aria-label="Strip plot of benchmark scores from 0 to 100, one dot per graded benchmark, in two rows: safety and capability">
    ${BANDS.map((b, k) => html`<rect x="${px(b.lo)}" y="0" width="${px(b.hi) - px(b.lo)}" height="${axisY}" class="band band-${k % 2}"/><text x="${(px(b.lo) + px(b.hi)) / 2}" y="18" text-anchor="middle" class="band-g" aria-hidden="true">${b.g}</text>`)}
    ${[25, 40, 55, 70, 85].map((v) => html`<line x1="${px(v)}" x2="${px(v)}" y1="0" y2="${axisY}" class="bound"/><text x="${px(v)}" y="${axisY + 18}" text-anchor="middle" class="axis-t" aria-hidden="true">${v}</text>`)}
    <text x="${px(0)}" y="${axisY + 18}" class="axis-t" aria-hidden="true">0</text><text x="${px(100)}" y="${axisY + 18}" text-anchor="end" class="axis-t" aria-hidden="true">100</text>
    ${placed.map((r) => html`<text x="${X0 + 4}" y="${r.top + 16}" class="row-t" aria-hidden="true">${cap(r.d)} (${r.bs.length})</text>
      ${r.bs.map((b, j) => { const idx = i++; const g = b.touchstone.rigor.grade!; const sc = Math.round(b.touchstone.rigor.score!);
        return html`<a href="#/benchmark/${b.id}" data-i="${idx}" data-tip="${b.name}: grade ${g}, score ${sc}" aria-label="${b.name}: grade ${g}, score ${sc}"><circle class="dot dot-${g.toLowerCase()}" style="--d:${idx * 25}ms" cx="${px(b.touchstone.rigor.score!)}" cy="${r.cy + r.ys[j]!}" r="${R}"/></a>`; })}`)}
    <text class="tip" id="strip-tip" aria-hidden="true"></text>
  </svg>`;
  return { svg, W, count: i };
}

export function renderHome(main: HTMLElement, data: SiteIndex) {
  observers.forEach((o) => o.disconnect());
  observers = [];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animate = !reduced && 'IntersectionObserver' in window;

  const encodedStds = data.standards.filter((s) => s.status === 'encoded');
  const cov = coverage(data.standards, data.benchmarks, data.summaries);
  const c = cov.counts; // tiles count pairs, the same unit as the coverage grid below
  const graded = data.benchmarks.filter((b) => b.touchstone.rigor.grade);
  const tiles = [
    { n: graded.length, l: 'benchmarks rated', s: `of ${data.benchmarks.length} listed` },
    { n: encodedStds.length, l: 'standards encoded', s: `of ${data.standards.length} catalogued` },
    { n: c.reviewed, l: 'reviewed ratings', s: 'one benchmark against one standard' },
    { n: c.draft, l: 'drafts awaiting review', s: 'automated, not yet checked by a person' },
  ];

  // Grade histogram + headline.
  const hist = GRADES.map((g) => ({ g, n: graded.filter((b) => b.touchstone.rigor.grade === g).length }));
  const none = data.benchmarks.length - graded.length;
  const maxN = Math.max(1, none, ...hist.map((h) => h.n));
  const top = hist.find((h) => h.n > 0);
  const med = median(graded.map((b) => b.touchstone.rigor.score!).filter((x) => x != null));
  const headline = top
    ? `The highest grade any benchmark reaches is ${top.g}, and ${top.n} ${top.n === 1 ? 'benchmark gets' : 'benchmarks get'} it. The median score is ${Math.round(med)} out of 100.`
    : 'No benchmark has a grade yet.';
  const sp = strip(data);

  // Coverage.
  const total = data.standards.length * cov.cols.length;
  const pct = Math.round(cov.reviewedShare * 100);
  const pendingNames = cov.cols.filter((_, j) => cov.cells.some((row) => row[j] === 'pending')).map((b) => b.name);
  const scoped = data.standards.filter((s) => s.status === 'encoded' && s.scope);
  const scopeText = scoped.map((s) => `${s.short} covers ${[...(s.scope!.modalities ?? []).map((m) => modalityName(m).toLowerCase()), ...(s.scope!.domains ?? [])].join(' and ')} benchmarks only`);
  const blocked = data.standards.filter((s) => s.status !== 'encoded');
  const paywalled = blocked.filter((s) => s.status === 'paywalled').map((s) => s.short);
  const catalogued = blocked.filter((s) => s.status === 'catalogued').map((s) => s.short);
  const catOrder = Object.fromEntries(CATS.map((k, i) => [k, i])) as Record<Cat, number>;
  const N = cov.cols.length;
  const groups = (key: 'domain' | 'modality') => {
    const out: { label: string; span: number }[] = [];
    cov.cols.forEach((b, j) => {
      const label = key === 'domain' ? cap(b.domain) : modalityName(b.modality);
      const prev = out[out.length - 1];
      const same = prev && prev.label === label && (key === 'domain' || cov.cols[j - 1]!.domain === b.domain);
      if (same) prev.span++; else out.push({ label, span: 1 });
    });
    return out;
  };
  const head = (key: 'domain' | 'modality') => html`<div class="cov-row cov-head"><span class="cov-lab"></span><div class="cov-cells" style="--n:${N}">${groups(key).map((g) => html`<span class="cov-grp cov-grp-${key}" style="grid-column:span ${g.span}" title="${g.label}">${g.label}</span>`)}</div></div>`;
  const steps: { cat: Cat | ''; body: Raw }[] = [
    { cat: '', body: html`<p>There are ${data.standards.length} standards and ${N} benchmarks. That makes ${total} pairs. Each square is one pair. Few of them have a reviewed rating, for five different reasons.</p>` },
    { cat: 'reviewed', body: html`<p><strong>${c.reviewed} pairs are reviewed.</strong> A person has published these ratings. They are the ratings in the default table.</p>` },
    { cat: 'draft', body: html`<p><strong>${c.draft} pairs have a draft only.</strong> An automated assessment exists, and a person has not reviewed it yet. The default table shows reviewed ratings only. Review is under way. <a class="link" href="#/ratings?source=all">See the drafts in the table</a>.</p>` },
    { cat: 'pending', body: html`<p><strong>${c.pending} pairs are not yet assessed.</strong> The standard is encoded and applies, but no assessment exists.${pendingNames.length ? html` Benchmarks with at least one: ${list(pendingNames)}.` : ''}</p>` },
    { cat: 'na', body: html`<p><strong>${c.na} pairs do not apply.</strong> The standard is encoded, but the benchmark is outside what it covers.${scopeText.length ? ` ${cap(list(scopeText))}.` : ''}</p>` },
    { cat: 'blocked', body: html`<p><strong>${c.blocked} pairs can't be encoded.</strong> ${paywalled.length ? html`${list(paywalled)} ${paywalled.length === 1 ? 'is' : 'are'} sold under per-user licences, so the text can't be encoded openly. ` : ''}${catalogued.length ? html`${list(catalogued)} ${catalogued.length === 1 ? 'is' : 'are'} catalogued but not yet encoded.` : ''}</p>` },
    { cat: '', body: html`<p>Of the ${cov.rateable} pairs that can be rated, ${pct}% have a reviewed rating.</p>` },
  ];
  const summaryText = `Coverage grid of ${data.standards.length} standards by ${N} benchmarks: ${CATS.map((k) => `${c[k]} ${CAT_LABEL[k].toLowerCase()}`).join(', ')}.`;

  const section = (id: string, title: string, body: Raw) => html`<section class="home-sec" id="home-${id}" aria-labelledby="h-${id}"><h2 class="t-section" id="h-${id}" tabindex="-1">${title}</h2>${body}</section>`;

  main.innerHTML = html`<div class="home${animate ? ' anim' : ''}">
    <header class="home-hero">
      <h1 class="t-page" tabindex="-1">How rigorous are AI benchmarks?</h1>
      <p class="home-lede">Developers and policymakers rely on benchmarks. Touchstone checks them against published standards for benchmark quality.</p>
      <ul class="home-tiles" role="list">${tiles.map((t) => html`<li class="home-tile"><span class="home-num" data-to="${t.n}">${t.n}</span><span class="home-tl">${t.l}</span><span class="t-caption">${t.s}</span></li>`)}</ul>
      <p class="home-cta"><a class="btn btn-primary" href="#/ratings">Explore the ratings</a><button type="button" class="btn home-btn2" data-jump="home-missing">Why ratings are missing</button></p>
      <nav class="home-jumps" aria-label="On this page"><span class="t-caption">On this page</span>
        <button type="button" class="btn-quiet" data-jump="home-how">How a rating is made</button><button type="button" class="btn-quiet" data-jump="home-found">What we found</button><button type="button" class="btn-quiet" data-jump="home-missing">Why ratings are missing</button><button type="button" class="btn-quiet" data-jump="home-explore">Explore</button></nav>
    </header>

    ${section('how', 'How a rating is made', html`<ol class="home-steps3" role="list">
      <li class="reveal"><span class="step-n" aria-hidden="true">1</span><h3 class="t-sub">Evidence</h3><p>We take the benchmark's paper or repository, pinned at an exact version. Every claim must point to that text.</p></li>
      <li class="reveal"><span class="step-n" aria-hidden="true">2</span><h3 class="t-sub">Verdicts</h3><p>A standard is a list of items. Each item gets one verdict: met, not met, or not applicable. Quotes are checked word for word. Missing documentation counts as not met.</p></li>
      <li class="reveal"><span class="step-n" aria-hidden="true">3</span><h3 class="t-sub">Score</h3><p>The score is arithmetic on the verdicts, with no judgement in it. A benchmark's grade is the median of its reviewed ratings on a 0 to 100 scale: A 85+, B 70+, C 55+, D 40+, E 25+, F below.</p></li></ol>
      <p class="mt-4"><a class="link tap" href="#/method">How it works</a></p>`)}

    ${section('found', 'What we found', html`
      <p class="home-headline">${headline}</p>
      <div class="hist" role="img" aria-label="Benchmarks per grade: ${hist.map((h) => `${h.g} ${h.n}`).join(', ')}, no grade yet ${none}">
        ${[...hist.map((h) => ({ k: h.g.toLowerCase(), label: h.g, n: h.n })), { k: 'none', label: 'No grade yet', n: none }].map((h) => html`<div class="hrow reveal"><span class="hlab">${h.k === 'none' ? html`<span class="chip">${h.label}</span>` : html`<span class="ts-grade-${h.k}">${h.label}</span>`}</span><span class="htrack"><span class="hfill hfill-${h.k}" style="--w:${(h.n / maxN) * 100}%"></span></span><span class="hn">${h.n}</span></div>`)}
      </div>
      <h3 class="t-sub home-h3">Every graded benchmark, by score</h3>
      <div class="strip-wrap">${sp.svg}</div>
      <p class="t-caption">A low score often means a benchmark does not document something, not that it fails it. The 0 to 100 scale across standards is a display convention, not a validated measure.</p>`)}

    ${section('missing', 'Why so many ratings are missing', html`
      <div class="cov-wrap">
        <figure class="cov-fig">
          <div class="cov" data-active="" role="img" aria-label="${summaryText}">
            ${head('domain')}${head('modality')}
            ${data.standards.map((s, i) => html`<div class="cov-row"><span class="cov-lab">${s.short}</span><div class="cov-cells" style="--n:${N}">${cov.cells[i]!.map((k, j) => html`<span class="cell" data-c="${k}" style="--d:${catOrder[k] * 450 + j * 6}ms" title="${s.short} × ${cov.cols[j]!.name}: ${CAT_LABEL[k].toLowerCase()}"></span>`)}</div></div>`)}
          </div>
          <ul class="cov-legend" role="list">${CATS.map((k) => html`<li><button type="button" class="leg" data-leg="${k}" aria-pressed="false"><span class="cell leg-sw" data-c="${k}" aria-hidden="true"></span>${CAT_LABEL[k]} <strong>${c[k]}</strong></button></li>`)}</ul>
          <div class="visually-hidden"><table><caption>${summaryText}</caption><thead><tr><th scope="col">Category</th><th scope="col">Pairs</th></tr></thead><tbody>${CATS.map((k) => html`<tr><th scope="row">${CAT_LABEL[k]}</th><td>${c[k]}</td></tr>`)}</tbody></table></div>
          <figcaption class="t-caption">Rows are standards. Columns are benchmarks, grouped by domain and then type. Select a legend entry to highlight it.</figcaption>
        </figure>
        <ol class="cov-steps" role="list">${steps.map((s) => html`<li class="cov-step" data-cat="${s.cat}">${s.body}</li>`)}</ol>
      </div>`)}

    ${section('explore', 'Explore', html`<div class="cards home-cards">
      <a class="bcard" href="#/ratings"><span class="t-sub">Ratings</span><p class="t-caption mt-1">Every benchmark, its grade and its scores.</p></a>
      <a class="bcard" href="#/standards"><span class="t-sub">Standards</span><p class="t-caption mt-1">The ${data.standards.length} standards and how each is scored.</p></a>
      <a class="bcard" href="#/method"><span class="t-sub">How it works</span><p class="t-caption mt-1">Evidence, verdicts and scoring in full.</p></a>
      <a class="bcard" href="${data.repo}"><span class="t-sub">GitHub</span><p class="t-caption mt-1">The data and code. Send corrections here.</p></a></div>`)}
  </div>`.s;

  const root = main.querySelector<HTMLElement>('.home')!;

  // In-page jumps are buttons, not #id links: the hash router would read #id as a route.
  root.addEventListener('click', (e) => {
    const jb = (e.target as HTMLElement).closest<HTMLElement>('[data-jump]');
    if (!jb) return;
    const el = document.getElementById(jb.dataset.jump!)!;
    el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    el.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
  });

  // Coverage highlight: the active step and a pinned legend entry both set data-active.
  const cov$ = root.querySelector<HTMLElement>('.cov')!;
  const legs = [...root.querySelectorAll<HTMLButtonElement>('[data-leg]')];
  let stepCat = '', pinned = '';
  const paint = () => { cov$.dataset.active = pinned || stepCat; legs.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.leg === pinned))); };
  legs.forEach((b) => b.addEventListener('click', () => { pinned = pinned === b.dataset.leg ? '' : b.dataset.leg!; paint(); }));

  // Tooltip for the strip plot: one shared label, shown on hover and keyboard focus.
  const svg = root.querySelector<SVGSVGElement>('.strip-svg')!;
  const tip = svg.querySelector<SVGTextElement>('#strip-tip')!;
  const showTip = (e: Event) => {
    const a = (e.target as Element).closest<SVGAElement>('a[data-tip]');
    if (!a) return;
    const ci = a.firstElementChild!;
    const x = +ci.getAttribute('cx')!, y = +ci.getAttribute('cy')!;
    tip.textContent = a.dataset.tip!;
    tip.setAttribute('x', String(x)); tip.setAttribute('y', String(Math.max(14, y - 14)));
    tip.setAttribute('text-anchor', x < 170 ? 'start' : x > sp.W - 170 ? 'end' : 'middle');
    tip.classList.add('on');
  };
  svg.addEventListener('mouseover', showTip); svg.addEventListener('focusin', showTip);
  svg.addEventListener('mouseout', () => tip.classList.remove('on')); svg.addEventListener('focusout', () => tip.classList.remove('on'));

  if (!animate) return; // reduced motion or no IntersectionObserver: the final state is already on screen

  const once = (els: Element[], fn: (el: Element) => void, opts: IntersectionObserverInit = { threshold: 0.25 }) => {
    const o = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { o.unobserve(e.target); fn(e.target); } }), opts);
    els.forEach((el) => o.observe(el));
    observers.push(o);
  };
  const reveal = (el: Element) => el.classList.add('in');
  once([...root.querySelectorAll('.reveal')], reveal);
  once([root.querySelector('.strip-wrap')!, root.querySelector('.cov')!], reveal, { threshold: 0.15 });
  once([...root.querySelectorAll<HTMLElement>('.home-tile')], (el) => {
    const n = el.querySelector<HTMLElement>('.home-num')!;
    const to = +n.dataset.to!;
    const t0 = performance.now();
    const tick = (t: number) => { const k = Math.min(1, (t - t0) / 900); n.textContent = String(Math.round(to * (1 - (1 - k) ** 3))); if (k < 1) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }, { threshold: 0.6 });
  const stepIo = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { stepCat = (e.target as HTMLElement).dataset.cat!; root.querySelectorAll('.cov-step').forEach((s) => s.classList.toggle('is-active', s === e.target)); paint(); } }), { rootMargin: '-40% 0px -40% 0px' });
  root.querySelectorAll('.cov-step').forEach((s) => stepIo.observe(s));
  observers.push(stepIo);
}
