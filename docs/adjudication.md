# Adjudication

When two model readings of the same benchmark and standard disagree, [`scripts/adjudicate.ts`](../scripts/adjudicate.ts) settles each disputed item with a fixed cascade over the standard's own written rule and the verified quotes. No one's opinion enters. A judge model (`openai/gpt-oss-120b`, temperature 0) answers only blind questions; code derives the value and the choice.

## What the judge sees and answers

It sees the item, its `guidance.met` rule (for BetterBench, which has none, the item's `text:` line), the `not_applicable` condition if any, and the pooled quotes of both readings (only readings whose quotes were verified, de-duplicated, numbered Q1..Qn). It never sees either reading's value or rationale. It splits the rule into conditions, copied word for word from the rule, and lists which quotes state each one. It also says whether the n/a condition holds, is contradicted or is silent and, on a points scale, which quotes mention the subject at all.

## Code checks (failure means the row is skipped, with the reason)

- Every condition must be a span of the rule (case and whitespace ignored).
- Every quote id must exist, and the judge must return an entry for the item with at least one condition.

## The cascade (first match wins)

1. **n/a.** The item has a `not_applicable` condition and either a quote states it holds, or no quote speaks to it, the standard is `abc`, and the item is an `O.*` outcome-validity item. Cites the item's `not_applicable:` line, and for the ABC default `standards/abc.yaml:3` ("each is n/a unless the benchmark uses that method").
2. **Points scale (BetterBench).** 15 if every condition has a quote, 10 if some but not all do, 5 if none do but a quote mentions the subject, else 0. Cites the matching line of `level_meanings` in `standards/betterbench.yaml` (0 at line 23, 5 at 24, 10 at 25, 15 at 26) and, for 0, `docs/methodology.md:24`.
3. **Checklist.** `met` if every condition has a quote, else `unmet`, citing `docs/methodology.md:24` ("Absence of documentation is `unmet`").

Every row also cites the line holding the item's `met:` rule in `standards/<standard>.yaml`.

## Choice

`a` if the evidence value equals reading A's value; otherwise `b` if reading B exists and matches; otherwise `skip` ("neither reading matches evidence value"). A skip is left for a person.

## Outputs

`adjudication.json` (per row: choice, value, one-sentence rule, citations, and the quotes behind each condition), `decisions.json` (the format `apply-review.ts` reads, by `adjudicator-v1`) and `transcripts.jsonl` (every call, verbatim). A pair already in the transcripts with a parsed reply is not called again.
