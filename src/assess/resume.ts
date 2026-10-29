import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';

/** True when an auto assessment file exists and was assessed on `date`, so a same-day re-run can skip the pair. */
export function recordedOn(autoPath: string, date: string): boolean {
  if (!existsSync(autoPath)) return false;
  try { return (parse(readFileSync(autoPath, 'utf8')) as { provenance?: { assessed_on?: unknown } })?.provenance?.assessed_on === date; } catch { return false; }
}
