/**
 * One-off importer for assessments other parties have published. Re-running it regenerates the
 * same files from the same inputs. Inputs:
 *   - data/sources/betterbench/database-2026-10-26.json: the `benchmarks` array embedded in
 *     https://betterbench.stanford.edu/database.html, extracted on 2026-10-26.
 *   - The ABC results table (https://uiuc-kang-lab.github.io/agentic-benchmarks/) and the AISL
 *     Scorecard's worked examples (Appendices C and D), transcribed below.
 * Writes standards/betterbench.yaml, data/benchmarks/*.yaml and data/assessments/** (overwrites).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

const root = new URL('..', import.meta.url).pathname;
const IMPORTED_ON = '2026-10-26';
const out = (path: string, data: unknown, header = '') => {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), header + stringify(data, { lineWidth: 0 }));
};

// ---------- Benchmarks ----------
type B = { id: string; name: string; domain: 'safety' | 'capability'; modality: string; concept: string; year?: number; arxiv?: string; repo?: string; website?: string };
const benchmarks: B[] = [
  { id: 'bbq', name: 'BBQ', domain: 'safety', modality: 'language-model', concept: 'Social bias in question answering', year: 2021, arxiv: '2110.08193', repo: 'nyu-mll/BBQ' },
  { id: 'bold', name: 'BOLD', domain: 'safety', modality: 'language-model', concept: 'Bias in open-ended generation', year: 2021, arxiv: '2101.11718', repo: 'amazon-science/bold' },
  { id: 'truthfulqa', name: 'TruthfulQA', domain: 'safety', modality: 'language-model', concept: 'Truthfulness', year: 2021, arxiv: '2109.07958', repo: 'sylinrl/TruthfulQA' },
  { id: 'mmlu', name: 'MMLU', domain: 'capability', modality: 'language-model', concept: 'Multitask knowledge', year: 2020, arxiv: '2009.03300', repo: 'hendrycks/test' },
  { id: 'arc-challenge', name: 'ARC-Challenge', domain: 'capability', modality: 'language-model', concept: 'Science question answering', year: 2018, arxiv: '1803.05457' },
  { id: 'winogrande', name: 'WinoGrande', domain: 'capability', modality: 'language-model', concept: 'Commonsense reasoning', year: 2019, arxiv: '1907.10641', repo: 'allenai/winogrande' },
  { id: 'humaneval', name: 'HumanEval', domain: 'capability', modality: 'language-model', concept: 'Code generation', year: 2021, arxiv: '2107.03374', repo: 'openai/human-eval' },
  { id: 'gsm8k', name: 'GSM8K', domain: 'capability', modality: 'language-model', concept: 'Grade-school math reasoning', year: 2021, arxiv: '2110.14168', repo: 'openai/grade-school-math' },
  { id: 'hellaswag', name: 'HellaSwag', domain: 'capability', modality: 'language-model', concept: 'Commonsense inference', year: 2019, arxiv: '1905.07830' },
  { id: 'machiavelli', name: 'MACHIAVELLI', domain: 'safety', modality: 'lm-agent', concept: 'Ethical behaviour versus reward', year: 2023, arxiv: '2304.03279', repo: 'aypan17/machiavelli' },
  { id: 'agentbench', name: 'AgentBench', domain: 'capability', modality: 'lm-agent', concept: 'LLMs as agents', year: 2023, arxiv: '2308.03688', repo: 'THUDM/AgentBench' },
  { id: 'mlcommons-ai-safety-v0-5', name: 'MLCommons AI Safety v0.5', domain: 'safety', modality: 'language-model', concept: 'Hazardous responses', year: 2024, arxiv: '2404.12241', repo: 'mlcommons/modelbench' },
  { id: 'gpqa', name: 'GPQA', domain: 'capability', modality: 'language-model', concept: 'Graduate-level science questions', year: 2023, arxiv: '2311.12022', repo: 'idavidrein/gpqa' },
  { id: 'big-bench', name: 'BIG-bench', domain: 'capability', modality: 'language-model', concept: 'Broad capability suite', year: 2022, arxiv: '2206.04615', repo: 'google/BIG-bench' },
  { id: 'decodingtrust', name: 'DecodingTrust', domain: 'safety', modality: 'language-model', concept: 'Trustworthiness', year: 2023, arxiv: '2306.11698', repo: 'AI-secure/DecodingTrust' },
  { id: 'procgen', name: 'Procgen', domain: 'capability', modality: 'rl-agent', concept: 'Generalisation in procedurally generated games', year: 2019, arxiv: '1912.01588', repo: 'openai/procgen' },
  { id: 'medmnist-v2', name: 'MedMNIST v2', domain: 'capability', modality: 'classifier', concept: 'Biomedical image classification', year: 2021, arxiv: '2110.14795', repo: 'MedMNIST/MedMNIST' },
  { id: 'wordcraft', name: 'WordCraft', domain: 'capability', modality: 'rl-agent', concept: 'Commonsense agents', year: 2020, arxiv: '2007.09185', repo: 'minqi/wordcraft' },
  { id: 'rl-unplugged', name: 'RL Unplugged', domain: 'capability', modality: 'rl-agent', concept: 'Offline reinforcement learning', year: 2020, arxiv: '2006.13888' },
  { id: 'finrl-meta', name: 'FinRL-Meta', domain: 'capability', modality: 'rl-agent', concept: 'Financial market environments', year: 2022, arxiv: '2211.03107', repo: 'AI4Finance-Foundation/FinRL-Meta' },
  { id: 'safebench', name: 'SafeBench', domain: 'safety', modality: 'rl-agent', concept: 'Autonomous-vehicle safety', year: 2022, arxiv: '2206.09682', repo: 'trust-ai/SafeBench' },
  { id: 'pdebench', name: 'PDEBench', domain: 'capability', modality: 'scientific-ml', concept: 'Scientific machine learning', year: 2022, arxiv: '2210.07182', repo: 'pdebench/PDEBench' },
  { id: 'ale', name: 'Arcade Learning Environment', domain: 'capability', modality: 'rl-agent', concept: 'General game-playing agents', year: 2012, arxiv: '1207.4708', repo: 'Farama-Foundation/Arcade-Learning-Environment' },
  { id: 'mle-bench', name: 'MLE-bench', domain: 'capability', modality: 'lm-agent', concept: 'Machine learning engineering', year: 2024, arxiv: '2410.07095', repo: 'openai/mle-bench' },
  { id: 'cybench', name: 'Cybench', domain: 'safety', modality: 'lm-agent', concept: 'Offensive cybersecurity capability', year: 2024, arxiv: '2408.08926', repo: 'andyzorigin/cybench' },
  { id: 'gaia', name: 'GAIA', domain: 'capability', modality: 'lm-agent', concept: 'General assistant tasks', year: 2023, arxiv: '2311.12983' },
  { id: 'tau-bench', name: 'τ-bench', domain: 'capability', modality: 'lm-agent', concept: 'Tool-agent-user interaction', year: 2024, arxiv: '2406.12045', repo: 'sierra-research/tau-bench' },
  { id: 'osworld', name: 'OSWorld', domain: 'capability', modality: 'lm-agent', concept: 'Computer use', year: 2024, arxiv: '2404.07972', repo: 'xlang-ai/OSWorld' },
  { id: 'swe-lancer', name: 'SWE-Lancer', domain: 'capability', modality: 'lm-agent', concept: 'Freelance software engineering', year: 2025, arxiv: '2502.12115', repo: 'openai/SWELancer-Benchmark' },
  { id: 'swe-bench-verified', name: 'SWE-bench Verified', domain: 'capability', modality: 'lm-agent', concept: 'Resolving real GitHub issues', year: 2024, arxiv: '2310.06770', repo: 'SWE-bench/SWE-bench' },
  { id: 'bird-bench', name: 'BIRD-Bench', domain: 'capability', modality: 'lm-agent', concept: 'Text-to-SQL', year: 2023, arxiv: '2305.03111' },
  { id: 'webarena', name: 'WebArena', domain: 'capability', modality: 'lm-agent', concept: 'Web navigation', year: 2023, arxiv: '2307.13854', repo: 'web-arena-x/webarena' },
  { id: 'kernelbench', name: 'KernelBench', domain: 'capability', modality: 'lm-agent', concept: 'GPU kernel writing', year: 2025, arxiv: '2502.10517', repo: 'ScalingIntelligence/KernelBench' },
  { id: 'impossiblebench', name: 'ImpossibleBench', domain: 'safety', modality: 'lm-agent', concept: 'Reward hacking by exploiting test cases', year: 2025, arxiv: '2510.20270', repo: 'safety-research/impossiblebench' },
  { id: 'vending-bench-2', name: 'Vending-Bench 2', domain: 'capability', modality: 'lm-agent', concept: 'Long-horizon agent coherence', year: 2025, website: 'https://andonlabs.com/evals/vending-bench-2' },
];
for (const b of benchmarks) {
  const links: Record<string, string> = {};
  if (b.arxiv) links.paper = `https://arxiv.org/abs/${b.arxiv}`;
  if (b.repo) links.repo = `https://github.com/${b.repo}`;
  if (b.website) links.website = b.website;
  const { arxiv, repo, website, ...rest } = b;
  // Keep hand-curated fields (run-cost `resources`) that this importer doesn't own.
  const existing = join(root, `data/benchmarks/${b.id}.yaml`);
  const prev = existsSync(existing) ? (parse(readFileSync(existing, 'utf8')) as Record<string, unknown>) : {};
  out(`data/benchmarks/${b.id}.yaml`, { ...rest, links, ...(prev.resources ? { resources: prev.resources } : {}) });
}
const byName = new Map(benchmarks.map((b) => [b.name, b.id]));
const bbName: Record<string, string> = { Machiavelli: 'MACHIAVELLI', GSM8k: 'GSM8K', Wordcraft: 'WordCraft', ALE: 'Arcade Learning Environment' };

// ---------- BetterBench standard ----------
type BBEntry = { name: string; overallRating: string; score: number; breakdown: Record<string, number>; criteria: Record<string, Record<string, { score: number | string; explanation?: string }>> };
const bb: BBEntry[] = JSON.parse(readFileSync(join(root, 'data/sources/betterbench/database-2026-10-26.json'), 'utf8'));
const stages = ['design', 'implementation', 'documentation', 'maintenance'] as const;
const stageName = { design: 'Design', implementation: 'Implementation', documentation: 'Documentation', maintenance: 'Maintenance' };
// Criteria sit at the same position in every entry; wording varies slightly, so the most common wording
// is canonical and the rest are kept as aliases.
const groups = stages.map((st) => {
  const n = bb[0]!.criteria[st] ? Object.keys(bb[0]!.criteria[st]!).length : 0;
  const items = Array.from({ length: n }, (_, i) => {
    const counts = new Map<string, number>();
    for (const e of bb) {
      const name = Object.keys(e.criteria[st]!)[i]!;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const item: Record<string, unknown> = { id: `${st.slice(0, 3)}.${String(i + 1).padStart(2, '0')}`, text: ranked[0]![0] };
    if (ranked.length > 1) item.aliases = ranked.slice(1).map((r) => r[0]);
    return item;
  });
  return { id: st, name: stageName[st], items };
});
out('standards/betterbench.yaml', {
  id: 'betterbench',
  name: 'BetterBench',
  short: 'BetterBench',
  version: '2024.1',
  publisher: 'Reuel, Hardy, Smith, Lamparth, Hardy, Kochenderfer (Stanford)',
  year: 2024,
  kind: 'rubric',
  status: 'encoded',
  url: 'https://betterbench.stanford.edu/',
  citation: 'Reuel, A., Hardy, A., Smith, C., Lamparth, M., Hardy, M., & Kochenderfer, M. J. (2024). BetterBench: Assessing AI Benchmarks, Uncovering Issues, and Establishing Best Practices. NeurIPS 2024 Datasets and Benchmarks Track.',
  description: 'Criteria across the benchmark lifecycle (design, implementation, documentation, maintenance), each scored 0, 5, 10 or 15. Its published database lists 47 criteria; the paper describes 46.',
  scoring: {
    scheme: 'points',
    levels: [0, 5, 10, 15],
    max: 15,
    level_meanings: {
      '15': 'Fully meets the criterion.',
      '10': 'Partially meets the criterion.',
      '5': 'Mentions the criterion without fulfilling it.',
      '0': 'Neither mentions nor satisfies the criterion.',
    },
    overall: 'mean-of-items',
  },
  groups,
}, `# Generated by scripts/import-external.ts from BetterBench's published database. Do not edit by hand.\n# Item wording is BetterBench's; ids are positional within each lifecycle stage.\n`);

// ---------- BetterBench assessments ----------
const BB_URL = 'https://betterbench.stanford.edu/database.html';
for (const e of bb) {
  const id = byName.get(bbName[e.name] ?? e.name);
  if (!id) throw new Error(`no benchmark for BetterBench entry ${e.name}`);
  const verdicts: Record<string, unknown> = {};
  for (const st of stages) {
    Object.entries(e.criteria[st]!).forEach(([, c], i) => {
      const raw = c.score;
      const value = raw === 'n/a' ? 'n/a' : Number(raw);
      verdicts[`${st.slice(0, 3)}.${String(i + 1).padStart(2, '0')}`] = {
        value,
        ...(c.explanation ? { rationale: c.explanation } : {}),
        evidence: [{ source: 'website', url: BB_URL, locator: `BetterBench database entry "${e.name}", ${stageName[st]} criterion ${i + 1}` }],
        by: 'human',
      };
    });
  }
  out(`data/assessments/${id}/betterbench.yaml`, {
    benchmark: id,
    standard: 'betterbench',
    standard_version: '2024.1',
    status: 'published',
    mode: 'itemized',
    // BetterBench publishes no per-entry assessment date, so this is the date of our snapshot.
    provenance: { kind: 'external', assessors: ['BetterBench team (Stanford)'], assessed_on: IMPORTED_ON, source_title: 'BetterBench database (assessment date not published; snapshot date shown)', source_url: BB_URL },
    verdicts,
    published: { groups: e.breakdown, overall: e.score, label: `${e.overallRating.replace(/\*/g, '★')} ${e.score}/15` },
    revisions: [{ date: IMPORTED_ON, by: 'touchstone-import', summary: 'Imported from the BetterBench database snapshot of 2026-10-26.' }],
  }, `# Generated by scripts/import-external.ts. Verdicts and rationales are BetterBench's own.\n`);
}

// ---------- ABC assessments (section scores from the published results table) ----------
const ABC_URL = 'https://uiuc-kang-lab.github.io/agentic-benchmarks/';
const abc: [string, number, number, number, number][] = [
  ['mle-bench', 100, 90, 92.3, 94.1], ['cybench', 100, 100, 69.2, 89.7], ['gaia', 100, 60, 53.8, 71.3],
  ['tau-bench', 50, 100, 46.2, 65.4], ['osworld', 66.7, 80, 46.2, 64.3], ['swe-lancer', 50, 80, 53.8, 61.3],
  ['swe-bench-verified', 50, 100, 30.8, 60.3], ['bird-bench', 50, 60, 46.2, 52.1], ['webarena', 50, 40, 46.2, 45.4],
  ['kernelbench', 0, 80, 53.8, 44.6],
];
for (const [id, o, t, r, overall] of abc) {
  const scores = { outcome_validity: o, task_validity: t, benchmark_reporting: r };
  out(`data/assessments/${id}/abc.yaml`, {
    benchmark: id, standard: 'abc', standard_version: '1.0.1', status: 'published', mode: 'imported',
    provenance: { kind: 'external', assessors: ['Agentic Benchmark Checklist team'], assessed_on: '2025-07-03', source_title: 'ABC results table', source_url: ABC_URL },
    scores,
    published: { groups: scores, overall },
    revisions: [{ date: IMPORTED_ON, by: 'touchstone-import', summary: 'Section scores transcribed from the ABC results table.' }],
  }, `# Generated by scripts/import-external.ts. Item-level verdicts were not published; these are section scores.\n`);
}

// ---------- AISL Scorecard worked examples ----------
const SC_URL = 'https://aclanthology.org/2026.evaleval-1.25/';
out('data/assessments/impossiblebench/aisl-scorecard.yaml', {
  benchmark: 'impossiblebench', standard: 'aisl-scorecard', standard_version: '2026.07.1', status: 'published', mode: 'imported',
  provenance: { kind: 'external', assessors: ['AI Standards Lab'], assessed_on: '2026-07-04', source_title: 'Scorecard of AI Benchmark Quality, Appendix C', source_url: SC_URL, standard_version_used: 'penultimate (Appendix B)' },
  scores: { construct_validity: 1, internal_validity: 1, external_validity: 1, reliability: 2, correctness: 1 },
  published: { groups: { construct_validity: 1, internal_validity: 1, external_validity: 1, reliability: 2, correctness: 1 }, label: 'Category B' },
  notes: 'Graded by the authors with the penultimate scorecard. Under the final classification table, Reliability 2 rules out Category B, so the recomputed category is C.',
  revisions: [{ date: IMPORTED_ON, by: 'touchstone-import', summary: 'Dimension scores transcribed from Appendix C.' }],
});
out('data/assessments/vending-bench-2/aisl-scorecard.yaml', {
  benchmark: 'vending-bench-2', standard: 'aisl-scorecard', standard_version: '2026.07.1', status: 'published', mode: 'imported',
  provenance: { kind: 'external', assessors: ['AI Standards Lab'], assessed_on: '2026-07-04', source_title: 'Scorecard of AI Benchmark Quality, Appendix D', source_url: SC_URL, standard_version_used: 'penultimate (Appendix B)' },
  scores: { construct_validity: 'invalid', internal_validity: null, external_validity: null, reliability: null, correctness: null },
  published: { label: 'Not suitable for use' },
  notes: 'The authors found baseline construct-validity items unmet (no precise definition of the phenomenon), so the evaluation could not be classified.',
  revisions: [{ date: IMPORTED_ON, by: 'touchstone-import', summary: 'Verdict transcribed from Appendix D.' }],
});
console.log(`wrote ${benchmarks.length} benchmarks, ${bb.length} BetterBench, ${abc.length} ABC and 2 AISL assessments`);
