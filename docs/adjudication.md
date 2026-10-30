# Adjudication

When two model readings of the same benchmark and standard disagree, [`scripts/adjudicate.ts`](../scripts/adjudicate.ts) settles each disputed item with a fixed cascade over the standard's own written rule and the verified quotes. Verdicts are derived by fixed rules from LLM judges' answers about quoted evidence, not by a person's opinion; a person reviews the rows the rules leave open. Two judge models answer only blind questions; code checks their words, then derives the value and the choice. This is prompt version 4.

## What the judges see and answer

Both see the item, its `guidance.met` rule (for BetterBench, which has none, the item's `text:` line), the `not_applicable` condition if any, and the pooled quotes of both readings (only readings whose quotes were verified, de-duplicated, numbered Q1..Qn). Neither sees either reading's value or rationale.

- **Judge 1** (`openai/gpt-oss-120b`, reasoning effort high for this script only) splits the rule into **requirements**, all of which must hold. A requirement holds **alternatives** only where the rule itself says "or" (for example "X or no labels"); a rule with one requirement and no "or" is one requirement with one alternative. Each condition is copied word for word from the rule. For each alternative it lists the quotes that state it, each with a `span`: the exact words of the quote (at most 30 words) that state the condition. Every alternative gets a reason of at most 25 words. The prompt forbids crediting a statement about another benchmark, model or prior study, a result offered in place of the documented property, a plan, or a name or link in place of the property; and where the condition says every, all, both or fully, a quote covering only part does not establish it. `na` is required when the item has an N/A condition; on a points scale it also lists `mentions`, each `{id, span}` under the same span rule. A mention must name the criterion's own subject; a related result, a name or link, or a neighbouring topic is not a mention.
- **Judge 2** (`deepseek/deepseek-v4.1-flash-1017`) gets judge 1's requirements and conditions (the rule text only, never judge 1's quote choices) and credits quotes per condition, with spans, `na` and `mentions`, under the same wording.

## Code checks

- Every condition must be a span of the rule (compared after Unicode, quote, dash, whitespace and case normalisation, with trailing punctuation dropped from both sides). Every quote id must exist (`Q3`, `q3`, `3` all name quote 3), each judge must return an entry for the item, and an item with an N/A condition needs `na` from both. Failure skips the row, with the reason. Judge 2 is matched to judge 1's conditions by their text; a condition it drops gets no credit.
- A credited quote must carry a span of at most 30 words that is a substring of the quote after the same normalisation. A failed span means that quote is not credited (fail closed: "Absence of documentation is `unmet`", `docs/methodology.md:24`); the row is not skipped.

## The evidence value V

An alternative is stated only if both judges credit a span-verified quote for it (the quotes may differ). A requirement is met if any of its alternatives is stated. `na` holds only if both judges say holds (either one saying contradicted makes it contradicted, otherwise it is silent). `mentions` is the intersection of the two judges' span-verified ids (a mention whose span fails the substring or 30-word check is dropped, as for conditions). The `na` rule is unchanged and deliberately fails closed: it holds only if both judges say holds (`docs/methodology.md:24`).

## The cascade (first match wins)

1. **n/a.** The item has a `not_applicable` condition and either a quote states it holds, or no quote speaks to it, the standard is `abc`, and the item is an `O.*` outcome-validity item. Cites the item's `not_applicable:` line, and for the ABC default `standards/abc.yaml:3` ("each is n/a unless the benchmark uses that method").
2. **Points scale (BetterBench).** 15 if every requirement is met, 10 if some but not all are, 5 if none are but a quote is in `mentions`, else 0. Cites the matching line of `level_meanings` in `standards/betterbench.yaml` (0 at line 23, 5 at 24, 10 at 25, 15 at 26) and, for 0, `docs/methodology.md:24`.
3. **Checklist.** `met` if every requirement is met, else `unmet`, citing `docs/methodology.md:24` ("Absence of documentation is `unmet`").

Every row also cites the line holding the item's `met:` rule in `standards/<standard>.yaml`.

## Rows with no verified quote

If neither reading has a verified quote, no judge is called. The whole rule is recorded as one requirement with no quote (reason "No verified quote in either reading."), the n/a state is `silent` when the item has an N/A condition, and the cascade runs as usual: `unmet`, `0`, or `n/a` for ABC `O.*` items. The rule sentence says the row was decided without a judge call.

## Choice

`a` if the evidence value equals reading A's value; otherwise `b` if reading B exists and matches; otherwise `skip` ("neither reading matches evidence value"). On a points scale, when both readings are positive levels (5, 10 or 15) the choice is always `skip` ("BetterBench separates 5, 10 and 15 only by its generic level meanings; the quotes cannot choose between two positive levels."); the evidence value and its `level_meanings` citation are still recorded. A skip is left for a person.

## Outputs

`adjudication.json` (per row: choice, value, one-sentence rule, citations, and per condition the quotes, each judge's credited ids `judges: {a, b}` and their `spans`; the header lists both models), `decisions.json` (the format `apply-review.ts` reads, by `adjudicator-v1`) and `transcripts.jsonl` (both judges' raw replies per chunk, with model ids). A chunk already in the transcripts with prompt version 4 and both replies parsed is not called again; transcripts from earlier prompt versions are never reused.
