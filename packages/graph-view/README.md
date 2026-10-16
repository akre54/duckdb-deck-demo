# @noodles.gl/graph-view

A JSON description of a node graph, a layout for it, and a React viewer. It isn't tied to any one producer:
luma.gl's GPU command graph, a query plan, and an editor network all describe themselves the same
way. The first producer is `describeCommandGraph` in `@noodles.gl/gpu-runtime/luma`, which draws
a luma.gl GPU Dataframe query's passes, the buffers they touch, and their timings.

```ts
import { validateGraph, collapseData, layoutGraph, type GraphDescription } from '@noodles.gl/graph-view';
import { GraphView, NodeDetails } from '@noodles.gl/graph-view/react';
import '@xyflow/react/dist/style.css';

<GraphView description={description} collapse={passOnly} selected={id} onSelect={setId} />
```

The main entry has no dependencies and no DOM, so a producer can build and validate a
description without React. `./react` needs `react` and `@xyflow/react` (optional peers).

## The description

```ts
interface GraphDescription {
  version: 1;
  id: string;
  label?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  metrics?: Record<string, GraphMetric>;     // whole-graph figures
}

interface GraphNode {
  id: string;
  kind: string;            // what the viewer colors by: compute, render, copy, buffer, texture, ...
  label?: string;
  role?: 'work' | 'data';  // work runs; data is read or written by work
  group?: string;          // e.g. the operation that contributed the node
  order?: number;          // schedule position; orders nodes inside a layout column
  metrics?: Record<string, GraphMetric>;     // { value, unit?: 'ms' | 'bytes' | 'count', p95? }
  attributes?: Record<string, string | number | boolean>;
}

interface GraphEdge {
  from: string;
  to: string;
  kind?: string;           // read, write, dependency, data; others draw as plain edges
  label?: string;
}
```

It's plain JSON: no classes, callbacks or GPU handles. A description can come from another
process or a saved file, and `validateGraph` returns its problems as strings instead of throwing.

**Resources are nodes, not edge labels.** Most of what's worth knowing about a GPU graph is about
its buffers: which are transient, how big they are, which passes write them. An edge has nowhere
to hang that. `collapseData` turns data nodes between two passes into labelled edges for a
pass-only view. It keeps data with no writer (inputs) or no reader (outputs) as nodes.

**A producer versions resources that are written more than once.** `describeCommandGraph` emits
`mask@1`, `mask@2` the way a frame graph does. Then a pass that reads and writes one buffer has an
edge into one version and out of the next, not a cycle. The layout tolerates cycles, but it
can't make them readable.

## The viewer

- **Layout:** columns left to right, each node one column right of its furthest predecessor,
  ordered within a column by its predecessors' rows, then by `order`. These graphs are DAGs of
  tens of nodes with a schedule, and longest-path layering reads well on them. dagre or elk would
  be the package's first runtime dependency.
- **Positions:** memoized on the graph's structure, not on the description object. A producer
  streaming timings re-emits the whole description every few hundred milliseconds, and nodes
  shouldn't move when a number changes width. A new structure remounts the canvas and frames
  it again. A graph too wide to read when fitted starts at its left edge, at a readable zoom,
  because these graphs read left to right from their inputs.
- **Heat bar:** `heatMetric` (default `gpu`) draws a bar under each work node, scaled to the
  largest value in the graph. On a luma group-by over 1M rows and 16 bins, the float-mean pass
  fills its bar and the other 18 passes barely register.

## Status

A prototype for the discussion with luma.gl about a GPU graph debugger. The schema is the part
meant to be argued over. What luma needs to expose for a producer to fill it without reading
private fields is written up in `docs/upstream/luma-command-graph-topology.md`.
