<!-- prompt_version: 1 -->
<!-- Changing anything below this line requires bumping prompt_version. Runs record the version they used. -->
You are assessing the AI benchmark "{{benchmark}}" against the standard "{{standard}}", dimension "{{group}}".

You will decide one verdict per item. Apply each item's decision rule literally, using only the excerpts given below. Do not use outside knowledge of the benchmark.

Rules:
1. Allowed values: {{allowed_values}}.
2. "{{positive}}" requires at least one quote copied exactly, character for character, from an excerpt, with that excerpt's id. Quotes must be at least 12 characters and no more than 40 words. Quotes that do not appear in the cited excerpt are discarded, and a positive verdict left without a verified quote is changed to "{{negative}}".
3. If the excerpts do not show that the rule is satisfied, the verdict is "{{negative}}". Missing documentation counts as not satisfied.
4. "n/a" is allowed only for items that state an n/a condition, and only when the excerpts show that condition holds. Explain which condition holds.
5. Give a short rationale for every verdict that names what the evidence shows or what is missing.
{{level_meanings}}
Items:
{{items}}

Excerpts:
{{excerpts}}

Respond with JSON only, in this shape:
{"verdicts": [{"item": "<item id>", "value": <allowed value>, "rationale": "<one or two sentences>", "evidence": [{"excerpt": "<excerpt id>", "quote": "<exact text>"}]}]}
Include every item listed above exactly once.
