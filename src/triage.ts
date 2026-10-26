/**
 * Triage for score correction requests filed through the GitHub issue form. Reads the issue body
 * (untrusted text), checks that the benchmark, standard and items it names exist, and writes a
 * comment showing the current verdicts and evidence for those items, so the requester and reviewers
 * start from the same record. It never changes data; changes go through a pull request.
 */
import type { Corpus } from './load.ts';

export function parseIssueForm(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const parts = body.replace(/\r\n/g, '\n').split(/^### /m).slice(1);
  for (const p of parts) {
    const nl = p.indexOf('\n');
    const label = (nl === -1 ? p : p.slice(0, nl)).trim();
    const value = (nl === -1 ? '' : p.slice(nl + 1)).trim();
    out[label] = value === '_No response_' ? '' : value;
  }
  return out;
}

/** Strip anything that could render as markup or a mention when echoed back into a comment. */
const safe = (s: string) => s.replace(/[<>`|@\[\]]/g, (c) => `&#${c.charCodeAt(0)};`).replace(/\s+/g, ' ').slice(0, 300);

export interface TriageResult { ok: boolean; labels: string[]; comment: string }

export function triage(c: Corpus, body: string): TriageResult {
  const f = parseIssueForm(body);
  const problems: string[] = [];
  const benchArg = (f['Benchmark'] ?? '').trim().toLowerCase();
  const stdArg = (f['Standard'] ?? '').trim().toLowerCase();
  const b = c.benchmarks.find((x) => x.value.id === benchArg || x.value.name.toLowerCase() === benchArg)?.value;
  const s = c.standards.find((x) => x.value.id === stdArg || x.value.short.toLowerCase() === stdArg || x.value.name.toLowerCase() === stdArg)?.value;
  if (!b) problems.push(`No benchmark matches "${safe(f['Benchmark'] ?? '')}". Use an id from data/benchmarks, such as \`truthfulqa\`.`);
  if (!s) problems.push(`No standard matches "${safe(f['Standard'] ?? '')}". Use an id from standards, such as \`aisl-scorecard\`.`);
  const itemIds = (f['Items'] ?? '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  const known = new Map((s?.groups ?? []).flatMap((g) => g.items.map((i) => [i.id, { item: i, group: g }] as const)));
  const groupIds = new Set((s?.groups ?? []).map((g) => g.id));
  const unknown = s ? itemIds.filter((i) => !known.has(i) && !groupIds.has(i)) : [];
  if (s && unknown.length) problems.push(`These items are not in ${s.short}: ${unknown.map(safe).join(', ')}.`);
  if (!(f['Evidence'] ?? '').trim()) problems.push('Please add evidence: a link to the paper section, file at a commit, or page that supports the change.');

  const lines: string[] = [];
  if (problems.length) {
    lines.push('Thanks for the request. Before it can be reviewed, please edit the issue to fix:', '', ...problems.map((p) => `- ${p}`));
    return { ok: false, labels: ['correction', 'needs-info'], comment: lines.join('\n') };
  }

  const assessments = c.assessments.filter((a) => a.value.benchmark === b!.id && a.value.standard === s!.id);
  lines.push(`Thanks. This request concerns **${b!.name}** under **${s!.name}** (version ${s!.version}).`, '');
  if (!assessments.length) {
    lines.push('There is no assessment of this pair yet, so this will be treated as a request to assess it.');
  }
  for (const { path, value: a } of assessments) {
    lines.push(`#### Current record: \`${path}\` (${a.provenance.kind}, ${a.status})`, '');
    if (a.mode === 'imported') {
      lines.push('This assessment was imported as dimension scores without item-level verdicts:', '');
      for (const g of s!.groups) lines.push(`- ${g.name}: ${a.scores?.[g.id] ?? 'not reported'}`);
      lines.push('');
      continue;
    }
    const targets = itemIds.length ? itemIds.flatMap((id) => (groupIds.has(id) ? s!.groups.find((g) => g.id === id)!.items.map((i) => i.id) : [id])) : [];
    for (const id of targets) {
      const v = a.verdicts?.[id];
      const it = known.get(id)!.item;
      lines.push(`- **${id}** ${it.text}`);
      if (!v) { lines.push('  - No verdict recorded (scored as unmet).'); continue; }
      lines.push(`  - Verdict: \`${String(v.value)}\`${v.by ? ` (by ${v.by})` : ''}`);
      if (v.rationale) lines.push(`  - Rationale: ${safe(v.rationale)}`);
      for (const e of v.evidence) lines.push(`  - Evidence: [${safe(e.locator)}](${e.url})${e.quote ? ` "${safe(e.quote)}"` : ''}`);
    }
    lines.push('');
  }
  lines.push(
    'A maintainer will check the evidence against the decision rule for each item. If the change is accepted it lands as a pull request that adds a revision entry linking this issue, and the score updates when it merges.',
  );
  return { ok: true, labels: ['correction', 'triaged'], comment: lines.join('\n') };
}
