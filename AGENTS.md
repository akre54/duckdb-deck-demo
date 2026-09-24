# Working in this repository

A DuckDB → WebGPU data graph: JSON in, GPU pixels out, with a cost-based planner deciding which
engine runs each node. Read [README.md](README.md) for what it does and
[FINDINGS.md](FINDINGS.md) for what has been measured and what has not.

## Layout

```
packages/planner/   @noodles.gl/planner — headless. Expression IR + three backends,
                    analyze/optimize/emit, statistics, cost model, target capabilities,
                    attribute conventions, source providers, wrangle parser, Arrow upload,
                    CPU stage, test fixtures. Zero runtime dependencies.
src/webgpu/         device, attributes, kernels, camera, calibration, render passes, runtime
src/duckdb/         DuckDbEngine, a SqlEngine over duckdb-wasm
src/deck/           the WebGL2, WebGPU and MapLibre deck.gl panes (see docs/deck-and-luma.md)
demo/              the inspector app (not published)
tests/             boundary guard, budgets, benchmarks, browser/
```

An npm workspace. The planner resolves to its **source** during development (a Vite/Vitest alias)
and to its built `dist` when the root package compiles — that is why `tsconfig.build.json` clears
`paths`.

## Commands

```bash
npm test           # 612 node tests, ~0.6s
npm run test:gpu   # 66 browser tests, Chromium, real WebGPU + real DuckDB
npm run typecheck  # tsc --noEmit across everything
npm run build      # planner dist, then the runtime entries
npm run dev        # the inspector demo on :5173
npm run bench      # throughput, reported not asserted
```

Run `npm test` and `npm run typecheck` on every change. Run `npm run test:gpu` for anything
touching the planner's emitters, the WebGPU layer, or the upload path.

## The rules that matter

**Test by executing, not by compiling.** Five real bugs in this repo were invisible to a
structural test and visible on the first run of an executing one — a SQL backend with no boolean
tracking, `%` disagreeing on negatives, `layout: 'auto'` pruning a binding, a stale bind group,
and raw WGSL locals scoped inside the block that had to outlive them. All five compiled. All five
produced plausible-looking plans. Node can only prove the SQL and WGSL backends *compile*; only
Chromium can run them. If you change codegen, add a browser test that reads the numbers back.

**WebGPU fails quietly.** Validation errors arrive through `uncapturederror`, not as exceptions,
and they invalidate the whole command buffer — so the symptom is every derived attribute reading
zero with nothing logged. Use `expectNoGpuError` (an error scope) in tests rather than trusting
the absence of a throw. Never use `layout: 'auto'` for a pipeline whose bindings are generated.

**The planner stays headless.** `packages/planner/tsconfig.json` compiles with `lib: ["ES2022"]`
and `types: []` on purpose, so an accidental `document` or `GPUDevice` fails to compile instead of
becoming something a consumer has to install. `tests/boundaries.test.ts` is the standing guard —
it also checks that Arrow is imported `import type` only and stays an optional peer.

**Resolve defaults once.** `analyze` resolves render channels and publishes
`Analysis.channels`; nothing downstream applies a `?? 'P'`. Fourteen scattered defaults were the
same decision made fourteen times, and the fourteenth was where a bug lived.

**Two implementations of one rule must be tested against each other.** The optimizer predicts a
kernel's storage-binding count so it can reject candidates over the per-stage limit;
`buildKernel` produces the actual bindings. They are separate code and a test asserts they agree.

## Conventions

- **British spellings do not appear in identifiers.** `color`, not `colour`; `materialize`, not
  `materialise`. Prose may use either.
- Attribute names are Houdini's (`P`, `Cd`, `pscale`, `Alpha`) but only as a *default* — see
  `conventions.ts`. Internal attributes are `__`-prefixed and get no buffer.
- SQL uses numbered placeholders (`$1`), never positional `?` — op templates like `fit()` repeat
  arguments, and positional binds silently mismatched.
- Every new module under `packages/planner/src` or `src/webgpu` must be re-exported from its
  barrel; a test enforces it.
- Add a function to the `FUNCTIONS` table and tests will fail until it has a JS implementation and
  a width rule. That is deliberate.
- Comments explain *why*, especially where the obvious approach was tried and failed. Several
  comments in this repo are the only record of a bug that cost hours.

## Traps

- Playwright's default headless binary is `chrome-headless-shell`, which has **no WebGPU**:
  `navigator.gpu` exists but `requestAdapter()` returns null, so GPU tests skip while looking like
  they ran. The config uses `channel: 'chromium'`.
- `Runtime.build()` marks kernels dirty without dispatching. A derived attribute reads as zero
  until a frame is submitted — use the `settle()` helper in tests.
- A bind-group cache must key on a token that changes when a buffer is *replaced*. Labels are not
  unique and capacities repeat; attributes carry a `generation` counter for this.
- DuckDB infers `DECIMAL` for a literal like `2.5`, and Arrow returns a decimal as an *unscaled*
  integer. Cast to `DOUBLE`/`FLOAT` in generated SQL and in test DDL.
- DuckDB-Wasm returns many record batches, not one chunk — 147 for 300k rows. The `chunked` upload
  tier exists for that; do not assume a single contiguous column.
- `requestAnimationFrame` throttles hard in a hidden tab, reporting an 8 ms frame as 640 ms. Frame
  timings need a drained submit loop (`timeFrames`).

## Scope

Deliberately absent: relational joins, strings, picking, transitions, line and polygon marks,
more than one aggregate or colour ramp per graph. Before adding one, check
[FINDINGS.md](FINDINGS.md) — "What this prototype does not prove" says what the numbers here do
and do not support.
