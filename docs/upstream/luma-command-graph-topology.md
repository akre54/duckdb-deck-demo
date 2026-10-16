<!--
Destination: new issue on visgl/luma.gl
Title: GPUCommandGraph: expose each node's resource uses and dependency edges, for inspector UIs
Status: draft, not posted
-->

### Summary

Can `CompiledGPUCommandGraph` publish what each node reads and writes, plus the dependency edges
the compiler infers from them? Then an inspector UI can draw the graph, not just list it. The
compiler already computes both. Today it keeps the uses in a private field and discards the
edges after sorting. A second, smaller ask: make the compiled graph behind a
`CompiledGPUDataFrameQuery` reachable.

### What is there and what is missing

`GPUCommandGraphInspector.getSnapshot()` already gives a UI almost everything as plain data:
`stats.nodeOrder`, `preflight` (per-node `operation`, `variant` and workload bounds), and
per-node CPU and GPU p50/p95. The example panel's comment says the snapshot is meant to be
rendered "in their own UI framework", which is what I tried.

What a graph view can't get without reaching into privates:

1. **Per-node resource uses.** `GPUCommandGraphNode.resources` is the declaration
   `getNodeOrder` infers hazards from. After compile it lives only in
   `CompiledGPUCommandGraph.compiledNodes` (private, master as of 2026-10-16).
2. **The dependency edges.** `getNodeOrder` builds a `dependencies` map (explicit `dependsOn`,
   plus read-after-write, write-after-read and write-after-write on buffers and overlapping
   texture ranges), uses it for the topological sort, and drops it.
3. **The graph behind a dataframe query.** `CompiledGPUDataFrameQuery.graph` is private, so an
   app can't call `inspector.observeGraph()` on the graph a `filter().compile()` built.

### Proposed shape

All strings and numbers, so it can go into the inspector snapshot unchanged and serialize to JSON:

```ts
type GPUCommandGraphTopology = {
  readonly resources: readonly {
    id: string;
    kind: 'buffer' | 'texture' | 'external-texture';
    transient: boolean;
    byteLength?: number;
    /** Transients that share an allocation after lifetime reuse share this index. */
    physicalAllocation?: number;
  }[];
  readonly nodes: readonly {
    id: string;
    type: GPUCommandGraphNodeType;
    uses: readonly {resource: string; usage: GraphBufferUsage | GraphTextureUsage | 'sampled'; byteOffset?: number; byteLength?: number}[];
    dependencies: readonly {
      node: string;
      reason: 'explicit' | 'read-after-write' | 'write-after-read' | 'write-after-write';
      resource?: string;
    }[];
  }[];
};
```

- `readonly topology: GPUCommandGraphTopology` on `CompiledGPUCommandGraph`.
- `topology?` on `GPUCommandGraphInspectorGraph` and its graph snapshot, beside `preflight`.
- A public `readonly graph` (or `getCommandGraph()`) on `CompiledGPUDataFrameQuery` and the
  other compiled dataframe results.

The `reason` field is the least obvious part and the most useful one. An edge you can label
"write-after-read on `selection-mask`" tells you why two passes can't merge or overlap.

### Prototype

akre54/duckdb-deck-demo has a viewer built on today's snapshot plus the private fields:
<https://akre54.github.io/duckdb-deck-demo/graph/>. It runs a `GPUDataFrame` filter, a batched
filter and a filtered group-by over 1M rows every frame, observed through
`GPUCommandGraphInspector`. It draws passes, buffers (versioned on each write) and per-pass
timings. The private reads are two functions, `commandGraphOf` and `resourceUsesOf` in
`src/luma/`, and the proposal above is what would replace them. The viewer is a separate package
(`@noodles.gl/graph-view`) that takes a JSON description and has no luma dependency.

On the group-by over 16 bins, the view shows the mean pass taking 13.4 of 13.9 ms on the first
run, which is the contention #3391 addresses. It also shows that 7 of the 19 passes (the
visibility scan and scatter) produce only `rowIndices` and `selectedCounts`, which no aggregate
reads. That's about 0.26 ms here, and they're public outputs, so this is a note rather than a bug.

### Smaller things the prototype ran into

- **Repeated graph ids.** `observeGraph` with a graph id already registered replaces the earlier
  registration, as documented. Two `GPUDataFrame` queries compiled into graphs with the same id
  (easy when a wrapper hardcodes the id) leave the first one's timings going nowhere, with no
  error. A dev-mode warning on replacement would have saved some time.
- **Imported column names.** A dataframe's imported columns show up as `...-input-0`,
  `...-group-keys`, `...-group-values-0-input`, so the column name (`v`, `bin`) is lost. Carrying
  the field name into the import handle's id would make any graph view readable without a
  lookup table.

I can open a PR for the topology part if the shape looks right.
