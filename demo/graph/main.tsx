/**
 * luma.gl's GPU Dataframe command graphs, drawn by `@noodles.gl/graph-view` while they run.
 *
 * Each query below is compiled once into a `GPUCommandGraph` and re-run every frame with the
 * slider's value as its parameter, the way a brushed histogram re-runs. A
 * `GPUCommandGraphInspector` records CPU timings on every run and GPU timings where the device
 * has `timestamp-query`; `describeCommandGraphs` turns the compiled graphs plus the inspector's
 * snapshot into the JSON the viewer draws. The JSON tab shows exactly what a producer emits.
 * Hovering a buffer or texture reads it back from the GPU (`previewCommandGraphsResource`).
 * The two pipelines (heatmap, histogram) are a GPU Dataframe query's graph followed by a graph
 * of render passes that draw its results; the viewer shows them joined, and the panel shows the
 * last pass's texture, the picture the pipeline makes.
 *
 * Per-pass GPU times come in steps of 65.5 µs (2^16 ns): Chrome quantizes timestamp queries
 * unless chrome://flags/#enable-webgpu-developer-features is on. A pass shown as 0 µs ran in
 * less than one step, not in no time. Totals over many passes are still meaningful.
 */

import { createRoot } from 'react-dom/client';
import { useEffect, useMemo, useState } from 'react';
import '@xyflow/react/dist/style.css';
import { GPUCommandGraphInspector } from '@luma.gl/gpgpu/gpu-core';
import { parseExpr } from '@noodles.gl/planner';
import { formatMetric, type GraphDescription, type NodePreview } from '@noodles.gl/graph-view';
import { GraphView, NodeDetails, PreviewView } from '@noodles.gl/graph-view/react';
import { dagreLayout, forceLayout } from '@noodles.gl/graph-view/layouts';
import type { CompiledGPUCommandGraph } from '@luma.gl/gpgpu/gpu-core';
import { LumaFilter, LumaGroupBy, describeCommandGraphs, previewCommandGraphsResource } from '../../src/luma/index.js';
import { DensityGraph } from './density.js';
import { HeatmapPipeline } from './heatmap.js';
import { HistogramPipeline, CHART } from './histogram.js';

const ROWS = 1 << 20;
const BINS = 16;

interface Query {
  key: string;
  label: string;
  /** One command graph, or several that run in order and are drawn joined. */
  graph: { run(params: Record<string, number>): void; readonly commandGraphs: CompiledGPUCommandGraph<never>[] };
  /** The resource holding the picture a render pipeline makes, shown in the panel. */
  output?: string;
}

/** A single-graph runner (`LumaFilter`, `LumaGroupBy`, `DensityGraph`) as a one-graph pipeline. */
const single = (g: { run(params: Record<string, number>): void; readonly commandGraph: CompiledGPUCommandGraph<never> }): Query['graph'] => ({
  run: (params) => g.run(params),
  get commandGraphs() { return [g.commandGraph]; },
});

async function start(): Promise<{ queries: Query[]; inspector: GPUCommandGraphInspector; features: string[] }> {
  if (!('gpu' in navigator)) throw new Error('WebGPU is not available in this browser.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter.');
  // Both are optional: without timestamp-query there are CPU timings only, and without subgroups
  // luma's group-by takes its slower path (FINDINGS §13).
  const wanted: GPUFeatureName[] = ['timestamp-query', 'subgroups'];
  const requiredFeatures = wanted.filter((f) => adapter.features.has(f));
  const device = await adapter.requestDevice({
    requiredFeatures,
    requiredLimits: { maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage },
  });

  const column = (label: string, data: Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer>) => {
    const buffer = device.createBuffer({
      label, size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  };
  const v = new Float32Array(ROWS);
  const w = new Float32Array(ROWS);
  const bin = new Uint32Array(ROWS);
  const bin64 = new Uint32Array(ROWS);
  for (let i = 0; i < ROWS; i++) {
    v[i] = Math.random();
    // A sine band with noise, so the density map has a shape. Uniform w would draw flat static.
    w[i] = Math.min(99.9, Math.max(0, 50 + 32 * Math.sin(v[i] * Math.PI * 3) + (Math.random() + Math.random() + Math.random() - 1.5) * 12));
    bin[i] = Math.floor(v[i] * BINS);
    bin64[i] = Math.floor(v[i] * CHART.bins);
  }
  const buffers = { v: column('v', v), w: column('w', w), bin: column('bin', bin), bin64: column('bin64', bin64) };

  const inspector = new GPUCommandGraphInspector({ maxSamples: 120 });
  const common = { device, adapter, rows: ROWS, params: { cut: 0.5 }, inspector };
  const queries: Query[] = [
    {
      key: 'filter',
      label: 'filter: v > cut',
      graph: single(new LumaFilter({ ...common, columns: { v: buffers.v }, predicate: parseExpr('v > {{cut}}') })),
    },
    {
      key: 'filter-batched',
      label: 'filter, 4 batches',
      graph: single(new LumaFilter({
        ...common, columns: { v: buffers.v }, predicate: parseExpr('v > {{cut}}'), topology: { kind: 'batched', rows: ROWS / 4 },
      })),
    },
    {
      key: 'group-by',
      label: 'group by bin: count, mean(w) where v > cut',
      graph: single(new LumaGroupBy({
        ...common,
        key: { name: 'bin', buffer: buffers.bin },
        groupCount: BINS,
        columns: { v: buffers.v, w: buffers.w },
        aggregates: { n: 'count', m: { mean: 'w' } },
        predicate: parseExpr('v > {{cut}}'),
      })),
    },
    {
      key: 'density',
      label: 'density of (v, w) where v > cut, into a 256×256 texture',
      graph: single(new DensityGraph({ device, adapter, v: buffers.v, w: buffers.w, rows: ROWS, inspector })),
    },
    {
      key: 'heatmap',
      label: 'pipeline: filter, then splat, blur, colormap, points, composite',
      graph: new HeatmapPipeline({ device, adapter, v: buffers.v, w: buffers.w, rows: ROWS, inspector }),
      output: HeatmapPipeline.output,
    },
    {
      key: 'histogram',
      label: 'pipeline: group-by, then bars, mean line, axes, chart',
      graph: new HistogramPipeline({ device, adapter, v: buffers.v, w: buffers.w, bin: buffers.bin64, rows: ROWS, inspector }),
      output: HistogramPipeline.output,
    },
  ];
  return { queries, inspector, features: requiredFeatures };
}

function App({ queries, inspector, features }: Awaited<ReturnType<typeof start>>) {
  const [active, setActive] = useState(queries[0].key);
  const [cut, setCut] = useState(0.5);
  // A phone gets compact cards with buffers folded into edges: the regular view fits two or
  // three passes on a phone screen. The graph still flows right. These graphs are wide (seven
  // independent passes open the group-by), so a layer fits a phone's height as a column but
  // not its width as a row, and flowing right leaves one axis to swipe instead of two.
  const narrow = useNarrow();
  const [collapse, setCollapse] = useState(narrow);
  const [compact, setCompact] = useState(narrow);
  const [arrange, setArrange] = useState<keyof typeof LAYOUTS>('wrap');
  const [tab, setTab] = useState<'node' | 'json'>('node');
  const [selected, setSelected] = useState<string>();
  const [description, setDescription] = useState<GraphDescription>();
  const [picture, setPicture] = useState<NodePreview>();
  const query = queries.find((q) => q.key === active)!;

  // Run the active graph every frame; re-describe it four times a second.
  useEffect(() => {
    let frame = 0;
    let last = performance.now();
    const describe = () => {
      const snapshots = inspector.getSnapshot().graphs;
      const graphs = query.graph.commandGraphs.map((graph) => ({ graph, snapshot: snapshots.find((s) => s.id === graph.id) }));
      const next = describeCommandGraphs(graphs, { label: query.label });
      setDescription(next);
      // The picture: the output resource's last version, read back like any preview.
      const out = query.output && next.nodes
        .filter((n) => n.attributes?.resource === query.output)
        .sort((a, b) => Number(b.attributes?.version) - Number(a.attributes?.version))[0];
      if (out) void previewCommandGraphsResource(query.graph.commandGraphs, out).then(setPicture);
      else setPicture(undefined);
    };
    const tick = (now: number) => {
      query.graph.run({ cut });
      if (now - last > 250) {
        last = now;
        describe();
      }
      frame = requestAnimationFrame(tick);
    };
    // Draw the structure now rather than on the first frame, which a background tab can hold back.
    describe();
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [query, cut, inspector]);

  const node = useMemo(() => description?.nodes.find((n) => n.id === selected), [description, selected]);
  // On a phone the header keeps only the whole-graph times; the allocation figures are in JSON.
  const totals = Object.entries(description?.metrics ?? {}).filter(([k]) => !narrow || k === 'gpu' || k === 'cpu');

  return (
    // dvh, not vh: on a phone 100vh is taller than the visible area while the toolbar shows.
    <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr', height: '100dvh', background: '#0b0c10', color: '#dde1ea', font: '12px/1.45 -apple-system, sans-serif' }}>
      <header style={{ display: 'flex', gap: narrow ? '6px 12px' : 16, alignItems: 'center', padding: narrow ? '6px 10px' : '8px 12px', borderBottom: '1px solid #262a36', flexWrap: 'wrap' }}>
        {!narrow && <strong>GPU command graph</strong>}
        <select value={active} onChange={(e) => { setActive(e.target.value); setSelected(undefined); }} style={narrow ? { flex: '1 1 100%' } : undefined}>
          {queries.map((q) => <option key={q.key} value={q.key}>{q.label}</option>)}
        </select>
        <label>cut <input type="range" min={0} max={1} step={0.01} value={cut} onChange={(e) => setCut(Number(e.target.value))} /> {cut.toFixed(2)}</label>
        <label><input type="checkbox" checked={collapse} onChange={(e) => setCollapse(e.target.checked)} /> passes only</label>
        <label><input type="checkbox" checked={compact} onChange={(e) => setCompact(e.target.checked)} /> compact</label>
        <label>layout{' '}
          <select value={arrange} onChange={(e) => setArrange(e.target.value as keyof typeof LAYOUTS)}>
            {Object.entries(LAYOUTS).map(([k, l]) => <option key={k} value={k}>{l.label}</option>)}
          </select>
        </label>
        <span style={{ marginLeft: narrow ? 0 : 'auto', color: '#8a92a6', fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>
          {narrow ? '1M rows' : `${ROWS.toLocaleString('en-US')} rows · ${features.length ? features.join(', ') : 'no optional features'}`}
          {totals.map(([k, m]) => ` · ${k} ${formatMetric(m)}`).join('')}
        </span>
      </header>
      <main className="layout">
        {description
          ? (
            <GraphView
              description={description} collapse={collapse} selected={selected} onSelect={setSelected}
              density={compact ? 'compact' : 'regular'} layout={LAYOUTS[arrange].layout}
              preview={(n) => previewCommandGraphsResource(query.graph.commandGraphs, n)}
            />
          )
          : <div style={{ padding: 16 }}>compiling…</div>}
        <aside style={{ padding: 12, overflow: 'auto', minHeight: 0 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <button onClick={() => setTab('node')} disabled={tab === 'node'}>node</button>
            <button onClick={() => setTab('json')} disabled={tab === 'json'}>JSON</button>
            {tab === 'json' && description && (
              <button style={{ marginLeft: 'auto' }} onClick={() => void navigator.clipboard.writeText(JSON.stringify(description, null, 2))}>copy</button>
            )}
          </div>
          {tab === 'node'
            ? (node ? <NodeDetails node={node} /> : (
              <>
              {picture && <div style={{ marginBottom: 10 }}><PreviewView title="output" preview={picture} /></div>}
              <p style={{ color: '#8a92a6', margin: 0 }}>
                {narrow ? 'Tap' : 'Click'} a node. The orange bar is each pass's share of the slowest pass's GPU time.
                Chrome reports pass times in 65.5 µs steps unless WebGPU developer features are on.
              </p>
              </>
            ))
            : <pre style={{ margin: 0, fontSize: 10.5, whiteSpace: 'pre-wrap', color: '#b9c2d6' }}>{JSON.stringify(description, null, 2)}</pre>}
        </aside>
      </main>
    </div>
  );
}

/** The layout menu: the viewer's own columns, wrapped or not, and the two that bring a dependency. */
const LAYOUTS = {
  layered: { label: 'layered', layout: 'layered' },
  wrap: { label: 'layered, wrapped', layout: 'wrap' },
  dagre: { label: 'dagre', layout: dagreLayout },
  force: { label: 'force (d3)', layout: forceLayout },
} as const;

/** Whether the screen is phone-sized, tracking rotation and resizes. Matches the CSS breakpoint. */
function useNarrow(): boolean {
  const query = '(max-width: 800px)';
  const [narrow, setNarrow] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const list = matchMedia(query);
    const update = () => setNarrow(list.matches);
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, []);
  return narrow;
}

const root = createRoot(document.getElementById('root')!);
start().then(
  (ctx) => {
    Object.assign(window as unknown as Record<string, unknown>, { graphDemo: ctx });
    root.render(<App {...ctx} />);
  },
  (err) => {
    console.error(err);
    root.render(<pre style={{ color: '#ff6b6b', padding: 16 }}>{String(err)}</pre>);
  },
);
