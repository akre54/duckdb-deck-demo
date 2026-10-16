import { memo, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  ReactFlow, Background, Controls, Handle, Position, MarkerType,
  type Edge, type Node, type NodeProps, type ReactFlowInstance,
} from '@xyflow/react';
import type { GraphDescription, GraphEdge, GraphNode } from '../schema.js';
import type { NodePreview } from '../preview.js';
import { layoutGraph, type NodeSize } from '../layout.js';
import { collapseData } from '../collapse.js';
import { formatMetric } from '../format.js';
import { EdgeTip, Legend, Popup, PreviewView } from './Popup.js';

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
  /**
   * `compact` draws a pass as a one-line name, one metric and the heat bar, and a resource as
   * a one-line pill, at about a third of the area. For a phone, where the regular cards leave
   * room for two or three passes on screen.
   */
  density?: 'regular' | 'compact';
  /**
   * Wrap a graph too wide to read when fitted onto rows, like text, so a long pass chain continues
   * on the next row instead of off the right edge. Rows are as wide as the viewer at a readable zoom.
   */
  wrap?: boolean;
  /**
   * Read a node's contents when it is hovered (or tapped): a buffer's values, a texture's image.
   * Asked again on every hover, since GPU contents change between frames.
   */
  preview?: (node: GraphNode) => Promise<NodePreview | undefined>;
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

const PAD = 24;

/**
 * Card sizes per density, and the smallest zoom the initial view uses. Regular cards are tall
 * enough for a two-line name and three metrics; compact ones fit one line and one metric, so
 * they need more zoom to stay readable.
 */
const DENSITY = {
  regular: { work: { width: 220, height: 104 }, data: { width: 170, height: 40 }, minZoom: 0.55, nameChars: 0 },
  compact: { work: { width: 168, height: 46 }, data: { width: 132, height: 22 }, minZoom: 0.85, nameChars: 24 },
} satisfies Record<string, { work: NodeSize; data: NodeSize; minZoom: number; nameChars: number }>;
type Density = keyof typeof DENSITY;

interface CardData extends Record<string, unknown> {
  node: GraphNode;
  color: string;
  metricKeys?: string[];
  /** Share of the hottest node's heat metric, 0 to 1. */
  heat?: number;
  heatMetric?: string | null;
  density: Density;
}
type CardNode = Node<CardData, 'work' | 'data'>;

/** A popup's anchor in viewer coordinates, and what it shows. */
type Tip = { x: number; y: number; key: string; content: ReactNode };

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
  const {
    description, collapse = false, kindColors = DEFAULT_KIND_COLORS, metricKeys, heatMetric = 'gpu',
    density = 'regular', wrap = false, preview, selected, onSelect, className, style,
  } = props;
  const sizes = DENSITY[density];
  const sizeOf = (n: GraphNode) => (n.role === 'data' ? sizes.data : sizes.work);
  const shown = useMemo(() => (collapse ? collapseData(description) : description), [description, collapse]);
  const container = useRef<HTMLDivElement>(null);
  const width = useWidth(container);

  // Wrap only a graph that would not fit at a readable zoom, at the width that zoom leaves.
  const gaps = density === 'compact' ? { columnGap: 40, rowGap: 12 } : {};
  const room = width ? (width - 2 * PAD) / sizes.minZoom : 0;
  const structure = `${density}:${structureKey(shown)}`;
  const flat = useMemo(() => layoutGraph(shown, { size: sizeOf, ...gaps }), [structure]);
  const wrapWidth = wrap && room && flat.width > room ? Math.round(room / 40) * 40 : undefined;
  const layout = useMemo(
    () => (wrapWidth ? layoutGraph(shown, { size: sizeOf, ...gaps, wrapWidth }) : flat),
    [structure, wrapWidth, flat],
  );

  /**
   * Fit the graph when it fits at a readable zoom. When it does not, center each axis that fits
   * and start the other at its edge rather than centered: these graphs read left to right from
   * their inputs, and `fitView` clamped to a minimum zoom centers the graph and puts its first
   * passes off screen.
   */
  const frame = (flow: ReactFlowInstance<CardNode, Edge>) => {
    const box = container.current?.getBoundingClientRect();
    if (!box || !layout.width) return;
    const fit = Math.min((box.width - 2 * PAD) / layout.width, (box.height - 2 * PAD) / layout.height, 1);
    const zoom = Math.max(fit, sizes.minZoom);
    const start = (span: number, extent: number) => (extent * zoom <= span - 2 * PAD ? (span - extent * zoom) / 2 : PAD);
    void flow.setViewport({ x: start(box.width, layout.width), y: start(box.height, layout.height), zoom });
  };

  // --- popups: a node's preview, an edge's tooltip ---------------------------------------------
  const [tip, setTip] = useState<Tip>();
  const pinned = useRef(false);
  const asked = useRef('');
  const at = (e: { clientX: number; clientY: number }) => {
    const box = container.current!.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  };
  const showNode = (e: React.MouseEvent, n: GraphNode, pin: boolean) => {
    if (!preview || (pinned.current && !pin)) return;
    pinned.current = pin;
    const title = n.label ?? n.id;
    const key = `node:${n.id}:${Date.now()}`;
    asked.current = key;
    setTip({ ...at(e), key, content: <PreviewView title={title} preview="loading" /> });
    preview(n).then(
      (p) => { if (asked.current === key) setTip((t) => t && { ...t, content: <PreviewView title={title} preview={p} /> }); },
      (err: unknown) => { if (asked.current === key) setTip((t) => t && { ...t, content: <PreviewView title={title} preview={{ kind: 'text', text: String(err) }} /> }); },
    );
  };
  const hide = () => { if (!pinned.current) { asked.current = ''; setTip(undefined); } };
  // A popup belongs to the graph it was opened on; another graph or view closes it.
  useLayoutEffect(() => { pinned.current = false; asked.current = ''; setTip(undefined); }, [structure, wrapWidth]);
  const labelOf = new Map(shown.nodes.map((n) => [n.id, n.label ?? n.id]));

  const hottest = heatMetric ? Math.max(0, ...shown.nodes.map((n) => n.metrics?.[heatMetric]?.value ?? 0)) : 0;
  const nodes: CardNode[] = shown.nodes.map((n) => ({
    id: n.id,
    type: n.role === 'data' ? 'data' : 'work',
    position: layout.positions[n.id] ?? { x: 0, y: 0 },
    // Explicit sizes, the ones the layout used. React Flow hides a node it has not measured, and
    // nodes rebuilt on every metrics update are never fed a measurement back in this read-only
    // (no onNodesChange) mode, so without these every node went hidden after the first update.
    ...sizeOf(n),
    // Explicit handles too, for the same reason one step later: a rebuilt node lost its measured
    // handle bounds, so every edge unmounted and remounted on every update. That cost a render,
    // dropped edges from a throttled tab, and swallowed the mouseleave that closes a tooltip.
    handles: handlesFor(sizeOf(n)),
    data: {
      node: n, color: kindColors[n.kind] ?? '#525252', metricKeys, heatMetric, density,
      heat: heatMetric && hottest > 0 ? (n.metrics?.[heatMetric]?.value ?? 0) / hottest : undefined,
    },
    selected: n.id === selected,
    draggable: false,
    connectable: false,
  }));

  // Width by bytes on a log scale: a 64 B count and a 4 MB column differ by 2^16, and a linear
  // width would draw one of them invisible.
  const heaviest = Math.max(1, ...shown.edges.map((e) => e.metrics?.bytes?.value ?? 0));
  const byId = new Map<string, GraphEdge>();
  const edges: Edge[] = shown.edges.map((e, i) => {
    const id = `${e.from}->${e.to}#${i}`;
    byId.set(id, e);
    const color = EDGE_COLORS[e.kind ?? ''] ?? '#94a3b8';
    const bytes = e.metrics?.bytes?.value;
    const strokeWidth = bytes ? 1 + 3 * Math.log1p(bytes) / Math.log1p(heaviest) : 1.5;
    // An edge into the next wrapped row runs back to the left; routed in steps it goes around
    // the row instead of curving through it.
    const wrapped = (layout.bands[e.from] ?? 0) !== (layout.bands[e.to] ?? 0);
    return {
      id,
      source: e.from,
      target: e.to,
      type: wrapped ? 'smoothstep' : 'default',
      interactionWidth: 14,
      // On a compact card the labels (resource names, often several) outweigh the cards.
      label: density === 'compact' ? undefined : e.label,
      labelStyle: { fill: '#cbd5e1', fontSize: 10, fontFamily: MONO },
      labelBgStyle: { fill: '#0b0c10' },
      style: { stroke: color, strokeWidth, strokeDasharray: e.kind === 'dependency' ? '4 3' : undefined },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
    };
  });
  const usedKinds = Object.fromEntries(Object.entries(EDGE_COLORS).filter(([k]) => shown.edges.some((e) => (e.kind ?? '') === k)));
  const bounds = container.current?.getBoundingClientRect();

  return (
    <div ref={container} className={className} style={{ position: 'relative', width: '100%', height: '100%', background: '#0b0c10', ...style }}>
      <ReactFlow
        // A new structure (another graph, the pass-only view, a new wrap width) remounts so
        // `frame` runs again; a metrics update keeps the user's pan and zoom.
        key={`${structure}:${wrapWidth ?? ''}`}
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onInit={frame}
        minZoom={0.1}
        nodesConnectable={false}
        nodesDraggable={false}
        onNodeClick={(e, n) => {
          onSelect?.(n.id);
          // A tap is the only hover a phone has, so a tapped data node keeps its preview open.
          if (n.data.node.role === 'data') showNode(e, n.data.node, true);
        }}
        onNodeMouseEnter={(e, n) => { if (n.data.node.role === 'data') showNode(e, n.data.node, false); }}
        onNodeMouseLeave={hide}
        onEdgeMouseEnter={(e, edge) => {
          if (pinned.current) return;
          const g = byId.get(edge.id);
          if (g) setTip({ ...at(e), key: `edge:${edge.id}`, content: <EdgeTip edge={g} from={labelOf.get(g.from) ?? g.from} to={labelOf.get(g.to) ?? g.to} /> });
        }}
        onEdgeMouseLeave={hide}
        onPaneClick={() => { pinned.current = false; hide(); onSelect?.(undefined); }}
        onMoveStart={() => { pinned.current = false; hide(); }}
        colorMode="dark"
      >
        <Background gap={16} color="#1f2430" />
        <Controls showInteractive={false} />
      </ReactFlow>
      {Object.keys(usedKinds).length > 0 && <Legend colors={usedKinds} compact={density === 'compact'} />}
      {tip && bounds && <Popup x={tip.x} y={tip.y} bounds={bounds}>{tip.content}</Popup>}
    </div>
  );
}

/** In on the left edge's middle, out on the right's, matching the cards' hidden `Handle`s. */
function handlesFor({ width, height }: NodeSize) {
  return [
    { type: 'target' as const, position: Position.Left, x: 0, y: height / 2, width: 1, height: 1 },
    { type: 'source' as const, position: Position.Right, x: width - 1, y: height / 2, width: 1, height: 1 },
  ];
}

/** The element's width, kept current as it resizes. Undefined until measured. */
function useWidth(ref: React.RefObject<HTMLElement | null>): number | undefined {
  const [width, setWidth] = useState<number>();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** Node ids, roles and edges: what the layout depends on. Labels and metrics are not. */
function structureKey(d: GraphDescription): string {
  return JSON.stringify([d.nodes.map((n) => [n.id, n.role ?? '', n.order ?? '']), d.edges.map((e) => [e.from, e.to])]);
}

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
const hidden: CSSProperties = { opacity: 0, pointerEvents: 'none' };

/**
 * A name cut from the front to `max` characters. Pass names share long prefixes and differ at the
 * end (`...-scan-level-1-scan`, `...-level-2-scan`), so the end is the part to keep.
 */
const tail = (name: string, max: number) => (max && name.length > max ? `…${name.slice(name.length - max + 1)}` : name);

/**
 * What a card says the node is: its group (for a GPU graph, the operation that contributed the
 * pass, such as `GPUScan`), or its kind when it has none. A pass's id names the operation too,
 * but after a long prefix the card cuts off.
 */
const typeOf = (node: GraphNode) => node.group ?? node.kind;
const titleOf = (node: GraphNode) => (node.group ? `${node.group} (${node.kind})` : node.kind);

const HeatBar = ({ heat, margin }: { heat?: number; margin: string }) =>
  heat === undefined ? null : (
    <div style={{ height: 3, margin, background: '#232733', borderRadius: 2 }}>
      <div style={{ height: '100%', width: `${Math.max(heat * 100, heat > 0 ? 2 : 0)}%`, background: '#f97316', borderRadius: 2 }} />
    </div>
  );

const WorkCard = memo(function WorkCard(props: NodeProps<CardNode>) {
  return props.data.density === 'compact' ? <CompactWorkCard {...props} /> : <RegularWorkCard {...props} />;
});

const CompactWorkCard = ({ data, selected }: NodeProps<CardNode>) => {
  const { node, color } = data;
  const size = DENSITY.compact.work;
  const key = data.metricKeys?.[0] ?? (data.heatMetric && node.metrics?.[data.heatMetric] ? data.heatMetric : Object.keys(node.metrics ?? {})[0]);
  const metric = key ? node.metrics?.[key] : undefined;
  return (
    <div title={node.id} style={{
      width: size.width, height: size.height, boxSizing: 'border-box', borderRadius: 5, overflow: 'hidden',
      background: '#151821', color: '#e5e7eb', font: `10.5px/1.35 ${MONO}`,
      // The kind color as a stripe rather than a header row, which a one-line card has no room for.
      border: `1px solid ${selected ? '#e5e7eb' : '#2a2f3a'}`, boxShadow: `inset 4px 0 0 ${color}`,
      padding: '4px 7px 0 10px', display: 'flex', flexDirection: 'column', gap: 1,
    }}>
      <Handle type="target" position={Position.Left} style={hidden} />
      <span style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden' }}>{tail(node.label ?? node.id, DENSITY.compact.nameChars)}</span>
      <span style={{ display: 'flex', justifyContent: 'space-between', gap: 6, color: '#9ca3af' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }} title={titleOf(node)}>{typeOf(node)}</span>
        <span style={{ color: '#e5e7eb', flex: 'none' }}>
          {metric ? formatMetric({ ...metric, p95: undefined }) : ''}
          {/* The heat metric goes unnamed, as on every other card; any other one says which it is. */}
          {metric && key !== data.heatMetric ? <span style={{ color: '#9ca3af' }}> {key}</span> : null}
        </span>
      </span>
      <HeatBar heat={data.heat} margin="2px 0 0" />
      <Handle type="source" position={Position.Right} style={hidden} />
    </div>
  );
};

const RegularWorkCard = ({ data, selected }: NodeProps<CardNode>) => {
  const { node, color } = data;
  const size = DENSITY.regular.work;
  const keys = data.metricKeys ?? Object.keys(node.metrics ?? {}).slice(0, 3);
  return (
    <div style={{
      width: size.width, minHeight: size.height, boxSizing: 'border-box', borderRadius: 6, overflow: 'hidden',
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
        <span style={{ opacity: 0.8, flex: 'none' }} title={titleOf(node)}>{typeOf(node)}</span>
      </div>
      <div style={{ padding: '4px 8px' }}>
        {keys.filter((k) => node.metrics?.[k]).map((k) => (
          <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ color: '#9ca3af' }}>{k}</span>
            <span>{formatMetric(node.metrics![k])}</span>
          </div>
        ))}
      </div>
      <HeatBar heat={data.heat} margin="0 8px 6px" />
      <Handle type="source" position={Position.Right} style={hidden} />
    </div>
  );
};

const DataCard = memo(function DataCard({ data, selected }: NodeProps<CardNode>) {
  const { node, color } = data;
  const compact = data.density === 'compact';
  const size = DENSITY[data.density].data;
  const bytes = node.metrics?.bytes;
  const name = node.label ?? node.id;
  return (
    <div title={node.id} style={{
      width: size.width, height: size.height, boxSizing: 'border-box', borderRadius: size.height / 2,
      padding: compact ? '0 9px' : '3px 12px', background: '#10131a', color: '#e5e7eb',
      font: `${compact ? 9.5 : 10.5}px/1.35 ${MONO}`,
      border: `1px ${node.attributes?.transient ? 'dashed' : 'solid'} ${selected ? '#e5e7eb' : color}`,
      display: 'flex', flexDirection: 'column', justifyContent: 'center', whiteSpace: 'nowrap', overflow: 'hidden',
    }}>
      <Handle type="target" position={Position.Left} style={hidden} />
      {compact ? (
        <span>{tail(name, 14)}{bytes ? <span style={{ color: '#9ca3af' }}> {formatMetric(bytes)}</span> : null}</span>
      ) : (
        <>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
          <span style={{ color: '#9ca3af' }}>{node.kind}{bytes ? ` · ${formatMetric(bytes)}` : ''}</span>
        </>
      )}
      <Handle type="source" position={Position.Right} style={hidden} />
    </div>
  );
});

const NODE_TYPES = { work: WorkCard, data: DataCard };
