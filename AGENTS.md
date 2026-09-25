# Working in this repository

A DuckDB → WebGPU data graph: JSON in, GPU pixels out, with a cost-based planner deciding which
engine runs each node. Read [README.md](README.md) for what it does and
[FINDINGS.md](FINDINGS.md) for what has been measured and what has not.

## Layout

```
packages/planner/   @noodles.gl/planner — headless. Expression IR + three backends,
                    analyze/optimize/emit, statistics, cost model, target capabilities,
                    attribute conventions, source providers, wrangle parser, Arrow upload,
                    CPU stage, test fixtures. Programs: layers.ts, relational.ts,
                    program.ts (compileProgram), hash.ts. Editor side: operators.ts,
                    doc.ts, lower.ts, keyframes.ts. Zero runtime dependencies.
src/webgpu/         device, attributes, kernels, camera, calibration, render passes, runtime
src/duckdb/         DuckDbEngine, a SqlEngine over duckdb-wasm
src/program/        ProgramRuntime, MaterializingCatalog (the memo), queryLayer/evaluateLayer
src/deck/           the WebGL2, WebGPU and MapLibre deck.gl panes, program-pane.ts
                    (see docs/deck-and-luma.md)
demo/               the inspector app (not published)
demo/editor/        the node editor: React (the only React in the repo), examples/*.json
tests/             boundary guard, budgets, benchmarks, browser/
```

An npm workspace. The planner resolves to its **source** during development (a Vite/Vitest alias)
and to its built `dist` when the root package compiles — that is why `tsconfig.build.json` clears
`paths`.

## Commands

```bash
npm test           # 680 node tests; the program ones run real DuckDB (duckdb-wasm, Node build)
npm run test:gpu   # 66 browser tests, Chromium, real WebGPU + real DuckDB
npm run typecheck  # tsc --noEmit across everything
npm run build      # planner dist, then the runtime entries
npm run dev        # the inspector on :5173, the node editor at /editor/
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

- **DuckDB-Wasm downloads extensions on first use**, JSON included (`read_json_auto`). In
  the browser that just works. In a sandbox with no network it *hangs* rather than failing,
  so `tests/duckdb-node.ts` turns autoload off and tests build JSON-shaped rows with SQL.
- **A hidden browser pane throttles timers too, not just rAF.** A long `preview_eval` that
  waits in a loop can time out against a healthy page. Drive the editor with short evals and
  `window.store` (`store.set({ time })`) rather than the play button.
- **`\bdocument\b` is a banned word in the planner** (the headless guard), and it matches a
  module named `document.ts`. The editor-document module is `doc.ts` for that reason.
- **React Flow in controlled mode reports selection through `onNodesChange`** (`select`
  changes). `onSelectionChange` never fires if those are dropped.
- **Moving or renaming a node must rebase references.** `ch('ctl/k')` is a path, and a path
  from inside a subnet differs from one at the root. `rebaseReferences` in
  `demo/editor/doc-ops.ts` does it; a new structural edit that moves nodes must call it too.
- **A prop-only change must hand deck the same binary `data` object.** `DeckProgramPane`
  caches by `LayerData` identity. Building a fresh object per frame turns a uniform write into
  a full attribute upload.
- **An expression is SQL-feasible only if its vectors are at the top level.** `enginesFor`
  checks this; a new construct that nests a vector must keep that check true.

## Programs and the editor

- The IR is still `Graph`. `plan()` rejects relational nodes; `compileProgram` accepts them
  and calls `plan()` per layer. Do not teach `plan()` about joins.
- Operators are not IR nodes. Add behaviour as an operator whose `lower()` emits existing IR
  nodes before reaching for a new IR node type.
- A parameter's `bind` (`value` / `prop` / `structural`) is the interactivity contract. A
  number that deck can apply as a layer prop should be `prop`; anything that changes what
  the graph *is* should be `structural`.
- Relations inline parameter values as `CAST(v AS DOUBLE)` literals and hash them. Layer
  queries bind them. Do not add binds to relation SQL.
- The keyframe math in `keyframes.ts` is ported from Noodles.gl (Apache-2.0). Keep the
  attribution in its header.

## Scope

Deliberately absent: picking, transitions, polygon marks, string functions, costing of
relations (a `rematerialize` route is reported, not priced), and more than one aggregate or
colour ramp per *layer*. Before adding one, check
[FINDINGS.md](FINDINGS.md) — "What this prototype does not prove" says what the numbers here do
and do not support.
