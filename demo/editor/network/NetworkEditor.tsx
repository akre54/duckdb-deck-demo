import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, Background, Controls, useReactFlow,
  type Edge, type NodeChange, type Connection,
} from '@xyflow/react';
import { OPERATOR_INDEX, nameOf, type OpDef } from '@noodles.gl/planner';
import { store, useEditor } from '../store.js';
import { OpNode, type OpFlowNode } from './OpNode.js';
import { TabMenu, ContextMenu, type MenuItem } from '../menus.js';
import {
  addNode, connect, removeNodes, insertOnEdge, collapseToSubnet, validConnection,
} from '../doc-ops.js';

const nodeTypes = { op: OpNode };

const PORT_COLOR: Record<string, string> = { table: '#22c55e', layer: '#e04ddd', number: '#ef4444' };

type Menu =
  | { kind: 'tab'; x: number; y: number; flow: { x: number; y: number }; edge?: string }
  | { kind: 'node'; x: number; y: number; id: string }
  | { kind: 'edge'; x: number; y: number; id: string };

export function NetworkEditor() {
  const doc = useEditor((s) => s.doc);
  const network = useEditor((s) => s.network);
  const selection = useEditor((s) => s.selection);
  const runtime = useEditor((s) => s.runtime);
  const flow = useReactFlow();
  const [menu, setMenu] = useState<Menu | undefined>();
  const [dragPos, setDragPos] = useState<Record<string, { x: number; y: number }>>({});
  const mouse = useRef({ x: 200, y: 200 });

  // --- nodes and edges derived from the document --------------------------
  const nodes: OpFlowNode[] = useMemo(() => {
    const lowered = runtime.lowered;
    const program = runtime.program;
    const layerRows = new Map(runtime.layers.map((l) => [l.id, l]));
    return doc.nodes.filter((n) => n.parent === network).map((n) => {
      const irIds = lowered?.irNodes[n.id] ?? [];
      const out = lowered?.outputs[n.id]?.out ?? irIds[irIds.length - 1];
      const badges: OpFlowNode['data']['badges'] = [];
      const engines = new Set<string>();
      let error = lowered?.errors.find((e) => e.nodeId === n.id)?.message;
      for (const id of irIds) {
        const info = program?.nodes[id];
        if (!info) continue;
        for (const e of Object.values(info.engines)) engines.add(e);
        error ??= info.error;
      }
      const rel = program?.relations.find((r) => r.id === out);
      if (rel) badges.push({ text: rel.materialize ? `table · ${fmt(rel.rows)}` : 'inline', kind: 'memo', title: `${rel.materialize ? `memoized as ${rel.table}` : 'inlined into its consumer'}\n${rel.sql}` });
      for (const e of engines) if (e !== 'source' && e !== 'render') badges.push({ text: e.toUpperCase(), kind: e });
      const layer = layerRows.get(n.id);
      if (layer?.data) badges.push({ text: `${fmt(layer.data.rows)} drawn`, kind: 'rows', title: `query ${layer.queryMs.toFixed(1)} ms · cpu ${layer.evalMs.toFixed(1)} ms` });
      if (layer?.error) error ??= layer.error;
      const wiredParams = doc.edges.filter((e) => e.target === n.id && e.targetPort.startsWith('par:')).map((e) => e.targetPort.slice(4));
      return {
        id: n.id, type: 'op', position: dragPos[n.id] ?? { x: n.x, y: n.y },
        selected: selection.includes(n.id),
        data: { doc: n, badges, error, wiredParams },
      };
    });
  }, [doc, network, selection, runtime.lowered, runtime.program, runtime.layers, dragPos]);

  const edges: Edge[] = useMemo(() => {
    const here = new Set(nodes.map((n) => n.id));
    const out: Edge[] = [];
    for (const e of doc.edges) {
      if (!here.has(e.source) || !here.has(e.target)) continue;
      const src = doc.nodes.find((n) => n.id === e.source);
      const type = OPERATOR_INDEX.get(src?.op ?? '')?.outputs.find((p) => p.name === e.sourcePort)?.type ?? 'table';
      out.push({
        id: e.id, source: e.source, target: e.target, sourceHandle: e.sourcePort, targetHandle: e.targetPort,
        style: { stroke: PORT_COLOR[type], strokeWidth: 1.6, opacity: 0.85 },
        label: e.index !== undefined && e.index > 0 ? String(e.index) : undefined,
      });
    }
    // Parameter references (ch() and ref values), drawn dashed like Noodles' reference edges.
    const seen = new Set<string>();
    for (const r of runtime.lowered?.references ?? []) {
      const from = r.from.split('.')[0];
      const to = r.to.split('.')[0];
      if (from === to || !here.has(from) || !here.has(to)) continue;
      if (doc.edges.some((e) => e.source === from && e.target === to && e.targetPort.startsWith('par:'))) continue;
      const id = `ref:${from}->${to}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, source: from, target: to, className: 'ref', selectable: false, focusable: false, style: { stroke: '#8a92a6', strokeWidth: 1 }, animated: false, zIndex: -1 });
    }
    return out;
  }, [doc, nodes, runtime.lowered]);

  // --- interactions ---------------------------------------------------------
  // Positions live here while a drag is in flight and reach the document once, on release:
  // a document edit per pointer move would lower the whole graph on every frame of a drag.
  const dragRef = useRef<Record<string, { x: number; y: number }>>({});
  const onNodesChange = useCallback((changes: NodeChange<OpFlowNode>[]) => {
    const finished: string[] = [];
    let moved = false;
    // Controlled nodes: selection arrives here as `select` changes and lives in the store.
    const selects = changes.filter((c): c is Extract<NodeChange<OpFlowNode>, { type: 'select' }> => c.type === 'select');
    if (selects.length) {
      const next = new Set(store().get().selection);
      for (const c of selects) { if (c.selected) next.add(c.id); else next.delete(c.id); }
      store().set({ selection: [...next] });
    }
    for (const c of changes) {
      if (c.type !== 'position') continue;
      if (c.position) { dragRef.current[c.id] = c.position; moved = true; }
      if (c.dragging === false) finished.push(c.id);
    }
    if (finished.length) {
      const commit = { ...dragRef.current };
      store().edit((draft) => {
        for (const id of finished) {
          const p = commit[id];
          const n = draft.nodes.find((x) => x.id === id);
          if (n && p) { n.x = Math.round(p.x); n.y = Math.round(p.y); }
        }
      }, 'move');
      for (const id of finished) delete dragRef.current[id];
    }
    if (moved || finished.length) setDragPos({ ...dragRef.current });
  }, []);

  const isValidConnection = useCallback((c: Connection | Edge) => validConnection(
    store().get().doc, c.source, c.sourceHandle ?? 'out', c.target, c.targetHandle ?? 'in',
  ), []);

  const onConnect = useCallback((c: Connection) => {
    store().edit((d) => connect(d, c.source, c.sourceHandle ?? 'out', c.target, c.targetHandle ?? 'in'));
  }, []);

  const deleteSelection = useCallback(() => {
    const ids = store().get().selection;
    if (!ids.length) return;
    store().edit((d) => removeNodes(d, ids));
    store().set({ selection: [] });
  }, []);

  const place = (op: OpDef, at: { x: number; y: number }, edge?: string) => {
    let created: string | undefined;
    store().edit((d) => {
      const n = edge ? insertOnEdge(d, edge, op.type) : addNode(d, op.type, at.x, at.y, store().get().network);
      created = n?.id;
    });
    if (created) store().set({ selection: [created] });
    setMenu(undefined);
  };

  const toggleFlag = (flag: 'bypass' | 'display') => {
    const ids = store().get().selection;
    if (!ids.length) return;
    store().edit((d) => {
      for (const n of d.nodes) {
        if (!ids.includes(n.id)) continue;
        const on = !n.flags?.[flag];
        n.flags = { ...n.flags, [flag]: on };
        // Houdini has one display flag per network.
        if (flag === 'display' && on) for (const m of d.nodes) if (m.id !== n.id && m.parent === n.parent && m.flags?.display) m.flags = { ...m.flags, display: false };
      }
    });
  };

  const collapse = () => {
    const ids = store().get().selection;
    if (ids.length === 0) return;
    let sub: string | undefined;
    try {
      store().edit((d) => { sub = collapseToSubnet(d, ids)?.id; });
    } catch (err) {
      alert((err as Error).message);
      return;
    }
    if (sub) store().set({ selection: [sub] });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, textarea, select')) return;
    const k = e.key;
    if (k === 'Tab') {
      e.preventDefault();
      const { x, y } = mouse.current;
      setMenu({ kind: 'tab', x, y, flow: flow.screenToFlowPosition({ x, y }) });
    } else if (k === 'Delete' || k === 'Backspace') {
      e.preventDefault();
      deleteSelection();
    } else if (k === 'b' || k === 'B') {
      if (!e.shiftKey) toggleFlag('bypass');
    } else if (k === 'd' && !e.metaKey && !e.ctrlKey) {
      toggleFlag('display');
    } else if (k === 'C' && e.shiftKey) {
      collapse();
    } else if (k === 'u' || k === 'U') {
      const net = store().get().network;
      if (net) store().set({ network: store().get().doc.nodes.find((n) => n.id === net)?.parent, selection: [net] });
    } else if (k === 'Enter' || k === 'i') {
      const sel = store().get().selection;
      const n = store().get().doc.nodes.find((x) => x.id === sel[0]);
      if (n?.op === 'subnet') store().set({ network: n.id, selection: [] });
    } else if (k === 'f') {
      void flow.fitView({ padding: 0.15, duration: 250 });
    }
  };

  const nodeMenu = (id: string): MenuItem[] => {
    const n = doc.nodes.find((x) => x.id === id);
    if (!n) return [];
    return [
      { heading: `${nameOf(n)} · ${OPERATOR_INDEX.get(n.op)?.label ?? n.op}` },
      { label: n.flags?.bypass ? 'Un-bypass  (B)' : 'Bypass  (B)', onClick: () => toggleFlag('bypass') },
      { label: n.flags?.display ? 'Hide display  (D)' : 'Display  (D)', onClick: () => toggleFlag('display') },
      { separator: true },
      { label: 'Collapse selection into subnet  (⇧C)', onClick: collapse },
      { label: 'Enter subnet  (Enter)', disabled: n.op !== 'subnet', onClick: () => store().set({ network: n.id, selection: [] }) },
      { label: 'Show rows in spreadsheet', onClick: () => store().set({ tab: 'spreadsheet' }) },
      { separator: true },
      { label: 'Delete  (⌫)', onClick: deleteSelection },
    ];
  };

  return (
    <div
      style={{ position: 'absolute', inset: 0 }}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerMove={(e) => { mouse.current = { x: e.clientX, y: e.clientY }; }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        deleteKeyCode={null}
        selectionKeyCode="Shift"
        multiSelectionKeyCode={['Meta', 'Control']}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.2}
        maxZoom={2}
        onNodeDoubleClick={(_, n) => { if (n.data.doc.op === 'subnet') store().set({ network: n.id, selection: [] }); }}
        onNodeContextMenu={(e, n) => {
          e.preventDefault();
          if (!store().get().selection.includes(n.id)) store().set({ selection: [n.id] });
          setMenu({ kind: 'node', x: e.clientX, y: e.clientY, id: n.id });
        }}
        onEdgeContextMenu={(e, edge) => {
          e.preventDefault();
          if (edge.id.startsWith('ref:')) return;
          setMenu({ kind: 'edge', x: e.clientX, y: e.clientY, id: edge.id });
        }}
        onPaneContextMenu={(e) => {
          e.preventDefault();
          setMenu({ kind: 'tab', x: e.clientX, y: e.clientY, flow: flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }) });
        }}
        onPaneClick={() => store().set({ selection: [] })}
      >
        <Background gap={24} size={1} color="#1e222c" />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
      {menu?.kind === 'tab' && (
        <TabMenu
          x={menu.x} y={menu.y}
          inSubnet={network !== undefined}
          filter={menu.edge ? (o) => o.inputs.some((p) => p.type === 'table') && o.outputs.some((p) => p.type === 'table') : undefined}
          onPick={(op) => place(op, menu.flow, menu.edge)}
          onClose={() => setMenu(undefined)}
        />
      )}
      {menu?.kind === 'node' && <ContextMenu x={menu.x} y={menu.y} items={nodeMenu(menu.id)} onClose={() => setMenu(undefined)} />}
      {menu?.kind === 'edge' && (
        <ContextMenu
          x={menu.x} y={menu.y} onClose={() => setMenu(undefined)}
          items={[
            { label: 'Insert node here…', onClick: () => setTimeout(() => setMenu({ kind: 'tab', x: menu.x, y: menu.y, flow: { x: 0, y: 0 }, edge: menu.id })) },
            { label: 'Delete wire', onClick: () => store().edit((d) => { d.edges = d.edges.filter((e) => e.id !== menu.id); }) },
          ]}
        />
      )}
    </div>
  );
}

function fmt(n: number | undefined): string {
  if (n === undefined) return '?';
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}
