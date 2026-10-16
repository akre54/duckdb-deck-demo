import { memo, useMemo, type CSSProperties } from 'react';
import {
  ReactFlow, Background, Controls, Handle, Position, MarkerType,
  type Edge, type Node, type NodeProps,
} from '@xyflow/react';
import type { GraphDescription, GraphNode } from '../schema.js';
import { layoutGraph, type NodeSize } from '../layout.js';
import { collapseData } from '../collapse.js';
import { formatMetric } from '../format.js';

export interface GraphViewProps {
  description: GraphDescription;
  /** Draw intermediate data nodes as labelled edges (`collapseData`). */
  collapse?: boolean;
  /** Header color per node `kind`. Unlisted kinds get a neutral gray. */
  kindColors?: Record<string, string>;
  /** Metric keys to show on a work node, in order. Defaults to its first three. */
  metricKeys?: string[];
  /**
   * Metric drawn as a bar under each work node, scaled to the largest value in the graph, so the
   * slowest pass stands out without reading every card. Defaults to `gpu`; `null` hides it.
   */
  heatMetric?: string | null;
  selected?: string;
  onSelect?: (id: string | undefined) => void;
  className?: string;
  style?: CSSProperties;
}

export const DEFAULT_KIND_COLORS: Record<string, string> = {
  compute: '#2563eb', render: '#db2777', copy: '#7c3aed',
  buffer: '#475569', texture: '#0f766e', 'external-texture': '#0f766e',
};

const EDGE_COLORS: Record<string, string> = {
  read: '#64748b', write: '#f59e0b', dependency: '#a78bfa', data: '#94a3b8',
};

// Tall enough for a two-line name and three metrics, so the layout's boxes match what is drawn.
const WORK: NodeSize = { width: 220, height: 104 };
const DATA: NodeSize = { width: 170, height: 40 };
const sizeOf = (n: GraphNode) => (n.role === 'data' ? DATA : WORK);

interface CardData extends Record<string, unknown> {
  node: GraphNode;
  color: string;
  metricKeys?: string[];
  /** Share of the hottest node's heat metric, 0 to 1. */
  heat?: number;
}
type CardNode = Node<CardData, 'work' | 'data'>;

/**
 * A read-only view of a graph description.
 *
 * Positions come from `layoutGraph` and are memoized on the graph's structure, not on the
 * description object. A producer that streams timings re-emits the whole description every
 * frame, and re-laying out on each one would make nodes jump whenever a metric changed width.
 *
 * The host must import `@xyflow/react/dist/style.css` once, as it would for any React Flow app.
 */
export function GraphView(props: GraphViewProps) {
  const { description, collapse = false, kindColors = DEFAULT_KIND_COLORS, metricKeys, heatMetric = 'gpu', selected, onSelect, className, style } = props;
  const shown = useMemo(() => (collapse ? collapseData(description) : description), [description, collapse]);
  const structure = structureKey(shown);
  const layout = useMemo(() => layoutGraph(shown, { size: sizeOf }), [structure]);

  const hottest = heatMetric ? Math.max(0, ...shown.nodes.map((n) => n.metrics?.[heatMetric]?.value ?? 0)) : 0;
  const nodes: CardNode[] = shown.nodes.map((n) => ({
    id: n.id,
    type: n.role === 'data' ? 'data' : 'work',
    position: layout.positions[n.id] ?? { x: 0, y: 0 },
    // Explicit sizes, the ones the layout used. React Flow hides a node it has not measured, and
    // nodes rebuilt on every metrics update are never fed a measurement back in this read-only
    // (no onNodesChange) mode, so without these every node went hidden after the first update.
    ...sizeOf(n),
    data: {
      node: n, color: kindColors[n.kind] ?? '#525252', metricKeys,
      heat: heatMetric && hottest > 0 ? (n.metrics?.[heatMetric]?.value ?? 0) / hottest : undefined,
    },
    selected: n.id === selected,
    draggable: false,
    connectable: false,
  }));
  const edges: Edge[] = shown.edges.map((e, i) => {
    const color = EDGE_COLORS[e.kind ?? ''] ?? '#94a3b8';
    return {
      id: `${e.from}->${e.to}#${i}`,
      source: e.from,
      target: e.to,
      label: e.label,
      labelStyle: { fill: '#cbd5e1', fontSize: 10, fontFamily: MONO },
      labelBgStyle: { fill: '#0b0c10' },
      style: { stroke: color, strokeWidth: 1.5, strokeDasharray: e.kind === 'dependency' ? '4 3' : undefined },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
    };
  });

  return (
    <div className={className} style={{ width: '100%', height: '100%', background: '#0b0c10', ...style }}>
      <ReactFlow
        // A new structure (another graph, or the pass-only view) remounts so `fitView` frames it;
        // a metrics update keeps the user's pan and zoom.
        key={structure}
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        // A long pass chain fitted whole is unreadable; start legible and let the user pan.
        fitViewOptions={{ minZoom: 0.55, maxZoom: 1 }}
        minZoom={0.1}
        nodesConnectable={false}
        nodesDraggable={false}
        onNodeClick={(_, n) => onSelect?.(n.id)}
        onPaneClick={() => onSelect?.(undefined)}
        colorMode="dark"
      >
        <Background gap={16} color="#1f2430" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

/** Node ids, roles and edges: what the layout depends on. Labels and metrics are not. */
function structureKey(d: GraphDescription): string {
  return JSON.stringify([d.nodes.map((n) => [n.id, n.role ?? '', n.order ?? '']), d.edges.map((e) => [e.from, e.to])]);
}

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const hidden: CSSProperties = { opacity: 0, pointerEvents: 'none' };

const WorkCard = memo(function WorkCard({ data, selected }: NodeProps<CardNode>) {
  const { node, color } = data;
  const keys = data.metricKeys ?? Object.keys(node.metrics ?? {}).slice(0, 3);
  return (
    <div style={{
      width: WORK.width, minHeight: WORK.height, boxSizing: 'border-box', borderRadius: 6, overflow: 'hidden',
      background: '#151821', color: '#e5e7eb', font: `11px/1.4 ${MONO}`,
      border: `1px solid ${selected ? '#e5e7eb' : '#2a2f3a'}`,
    }}>
      <Handle type="target" position={Position.Left} style={hidden} />
      <div style={{ background: color, padding: '3px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        {/* Pass names are long and differ at the end; two lines show the end, an ellipsis hides it. */}
        <span style={{
          fontWeight: 600, overflowWrap: 'anywhere', overflow: 'hidden',
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
        }} title={node.id}>
          {node.label ?? node.id}
        </span>
        <span style={{ opacity: 0.8, flex: 'none' }}>{node.kind}</span>
      </div>
      <div style={{ padding: '4px 8px' }}>
        {keys.filter((k) => node.metrics?.[k]).map((k) => (
          <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ color: '#9ca3af' }}>{k}</span>
            <span>{formatMetric(node.metrics![k])}</span>
          </div>
        ))}
      </div>
      {data.heat !== undefined && (
        <div style={{ height: 3, margin: '0 8px 6px', background: '#232733', borderRadius: 2 }}>
          <div style={{ height: '100%', width: `${Math.max(data.heat * 100, data.heat > 0 ? 2 : 0)}%`, background: '#f97316', borderRadius: 2 }} />
        </div>
      )}
      <Handle type="source" position={Position.Right} style={hidden} />
    </div>
  );
});

const DataCard = memo(function DataCard({ data, selected }: NodeProps<CardNode>) {
  const { node, color } = data;
  const bytes = node.metrics?.bytes;
  return (
    <div title={node.id} style={{
      width: DATA.width, height: DATA.height, boxSizing: 'border-box', borderRadius: DATA.height / 2,
      padding: '3px 12px', background: '#10131a', color: '#e5e7eb', font: `10.5px/1.35 ${MONO}`,
      border: `1px ${node.attributes?.transient ? 'dashed' : 'solid'} ${selected ? '#e5e7eb' : color}`,
      display: 'flex', flexDirection: 'column', justifyContent: 'center',
    }}>
      <Handle type="target" position={Position.Left} style={hidden} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.label ?? node.id}</span>
      <span style={{ color: '#9ca3af' }}>{node.kind}{bytes ? ` · ${formatMetric(bytes)}` : ''}</span>
      <Handle type="source" position={Position.Right} style={hidden} />
    </div>
  );
});

const NODE_TYPES = { work: WorkCard, data: DataCard };
