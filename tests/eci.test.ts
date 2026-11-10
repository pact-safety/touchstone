import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseEci } from '../src/build.ts';

const file = (id: string) => `
source: https://epoch.ai/benchmarks/eci
data: https://epoch.ai/data/edi_scores.csv
license: CC BY
retrieved_on: "2026-11-10"
entries:
  ${id}: { name: GSM8K, match: same, difficulty: 94.5, slope: 0.065 }
`;

describe('Epoch Capabilities Index data', () => {
  it('gives an entry to a listed benchmark and null to one not in the index', () => {
    const { eciFor } = parseEci(file('gsm8k'), new Set(['gsm8k', 'wmdp']));
    expect(eciFor('gsm8k')).toMatchObject({ license: 'CC BY', retrieved_on: '2026-11-10', entry: { name: 'GSM8K', difficulty: 94.5 } });
    expect(eciFor('wmdp').entry).toBeNull();
  });
  it('rejects an entry for a benchmark Touchstone does not list', () =>
    expect(() => parseEci(file('nope'), new Set(['gsm8k']))).toThrow(/unknown benchmark nope/));
  it('the committed file parses and credits Epoch', () => {
    const text = readFileSync('data/external/epoch-eci.yaml', 'utf8');
    const ids = new Set(['arc-challenge', 'big-bench', 'cybench', 'gpqa', 'gsm8k', 'hellaswag', 'mmlu', 'osworld', 'winogrande']);
    for (const id of ids) expect(parseEci(text, ids).eciFor(id).entry).not.toBeNull();
    expect(parseEci(text, ids).eciFor('gpqa').entry).toMatchObject({ name: 'GPQA diamond', match: 'subset' });
  });
});
