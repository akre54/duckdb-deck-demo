<!--
Destination: comment on https://github.com/visgl/deck.gl/pull/10778 (akre54's _onFrameTimings), mentioning #10279
Status: draft, not posted
-->

@ibgreen-openai, heads-up on overlap with your #10279 (QuerySet `gpuTime`), since both PRs add a timestamp
`QuerySet` to the render path and would conflict.

As I read them:

- **#10279** times the screen pass as one begin/end pair and reports `gpuTime` / `gpuTimePerFrame`
  in `metrics`. It also has the guardrails I'd want any version to keep: screen pass only, no-op
  without `timestamp-query`, one readback in flight, failures ignored.
- **#10778** times each layers render pass separately and reports a per-frame sample through
  `_onFrameTimings`. On WebGPU each viewport and each repeated world copy is its own pass and
  submit, so a single span counts the idle time between them.

A suggestion: one timer, two consumers. #10778's per-pass pairs become the source, `metrics.gpuTime`
becomes their sum (what #10279 reports today, minus the inter-pass idle), and #10279's guardrails
move into `FrameTimer`. I'm happy to fold your guardrails into this PR and keep you as co-author,
or rebase this on top of #10279 if you'd rather land yours first. Which do you prefer?
