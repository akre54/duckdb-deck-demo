/**
 * luma.gl's GPU Dataframe command graphs, drawn by `@noodles.gl/graph-view` while they run.
 *
 * Each query below is compiled once into a `GPUCommandGraph` and re-run every frame with the
 * slider's value as its parameter, the way a brushed histogram re-runs. A
 * `GPUCommandGraphInspector` records CPU timings on every run and GPU timings where the device
 * has `timestamp-query`; `describeCommandGraph` turns the compiled graph plus the inspector's
 * snapshot into the JSON the viewer draws. The JSON tab shows exactly what a producer emits.
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
import { formatMetric, type GraphDescription } from '@noodles.gl/graph-view';
import { GraphView, NodeDetails } from '@noodles.gl/graph-view/react';
import { LumaFilter, LumaGroupBy, describeCommandGraph } from '../../src/luma/index.js';

const ROWS = 1 << 20;
const BINS = 16;

interface Query {
  key: string;
  label: string;
  graph: LumaFilter | LumaGroupBy;
}

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
  for (let i = 0; i < ROWS; i++) {
    v[i] = Math.random();
    w[i] = Math.random() * 100;
    bin[i] = Math.floor(v[i] * BINS);
  }
  const buffers = { v: column('v', v), w: column('w', w), bin: column('bin', bin) };

  const inspector = new GPUCommandGraphInspector({ maxSamples: 120 });
  const common = { device, adapter, rows: ROWS, params: { cut: 0.5 }, inspector };
  const queries: Query[] = [
    {
      key: 'filter',
      label: 'filter: v > cut',
      graph: new LumaFilter({ ...common, columns: { v: buffers.v }, predicate: parseExpr('v > {{cut}}') }),
    },
    {
      key: 'filter-batched',
      label: 'filter, 4 batches',
      graph: new LumaFilter({
        ...common, columns: { v: buffers.v }, predicate: parseExpr('v > {{cut}}'), topology: { kind: 'batched', rows: ROWS / 4 },
      }),
    },
    {
      key: 'group-by',
      label: 'group by bin: count, mean(w) where v > cut',
      graph: new LumaGroupBy({
        ...common,
        key: { name: 'bin', buffer: buffers.bin },
        groupCount: BINS,
        columns: { v: buffers.v, w: buffers.w },
        aggregates: { n: 'count', m: { mean: 'w' } },
        predicate: parseExpr('v > {{cut}}'),
      }),
    },
  ];
  return { queries, inspector, features: requiredFeatures };
}

function App({ queries, inspector, features }: Awaited<ReturnType<typeof start>>) {
  const [active, setActive] = useState(queries[0].key);
  const [cut, setCut] = useState(0.5);
  const [collapse, setCollapse] = useState(false);
  const [tab, setTab] = useState<'node' | 'json'>('node');
  const [selected, setSelected] = useState<string>();
  const [description, setDescription] = useState<GraphDescription>();
  const query = queries.find((q) => q.key === active)!;

  // Run the active graph every frame; re-describe it four times a second.
  useEffect(() => {
    let frame = 0;
    let last = performance.now();
    const describe = () => {
      const snapshot = inspector.getSnapshot().graphs.find((g) => g.id === query.graph.commandGraph.id);
      setDescription(describeCommandGraph(query.graph.commandGraph, { snapshot, label: query.label }));
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
  const totals = Object.entries(description?.metrics ?? {});

  return (
    <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr', height: '100vh', background: '#0b0c10', color: '#dde1ea', font: '12px/1.45 -apple-system, sans-serif' }}>
      <header style={{ display: 'flex', gap: 16, alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid #262a36', flexWrap: 'wrap' }}>
        <strong>GPU command graph</strong>
        <select value={active} onChange={(e) => { setActive(e.target.value); setSelected(undefined); }}>
          {queries.map((q) => <option key={q.key} value={q.key}>{q.label}</option>)}
        </select>
        <label>cut <input type="range" min={0} max={1} step={0.01} value={cut} onChange={(e) => setCut(Number(e.target.value))} /> {cut.toFixed(2)}</label>
        <label><input type="checkbox" checked={collapse} onChange={(e) => setCollapse(e.target.checked)} /> passes only</label>
        <span style={{ marginLeft: 'auto', color: '#8a92a6', fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>
          {ROWS.toLocaleString('en-US')} rows · {features.length ? features.join(', ') : 'no optional features'}
          {totals.map(([k, m]) => ` · ${k} ${formatMetric(m)}`).join('')}
        </span>
      </header>
      <main className="layout">
        {description
          ? <GraphView description={description} collapse={collapse} selected={selected} onSelect={setSelected} />
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
              <p style={{ color: '#8a92a6' }}>
                Click a node. The orange bar is each pass's share of the slowest pass's GPU time.
                Chrome reports pass times in 65.5 µs steps unless WebGPU developer features are on.
              </p>
            ))
            : <pre style={{ margin: 0, fontSize: 10.5, whiteSpace: 'pre-wrap', color: '#b9c2d6' }}>{JSON.stringify(description, null, 2)}</pre>}
        </aside>
      </main>
    </div>
  );
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
