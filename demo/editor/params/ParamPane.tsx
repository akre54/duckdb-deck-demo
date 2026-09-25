import { useState } from 'react';
import {
  OPERATOR_INDEX, nameOf, nodePath, isExpr, isRef, bindingOf, keyframeAt,
  type DocNode, type ParamDef, type ParamValue, type EditorDoc, type RelColumn,
} from '@noodles.gl/planner';
import { store, useEditor } from '../store.js';
import type { Engine } from '../engine.js';
import { CATEGORY_COLORS } from '../network/OpNode.js';
import { ParamRow } from './ParamRow.js';
import { unpromote, renameNode } from '../doc-ops.js';

/**
 * The parameter pane: the selected node's parameters and nothing else, laid out from its
 * operator's schema — folders as tabs, a widget per kind, column menus filled from what the
 * compiled program says arrives at the node's input. What each parameter costs to change is
 * on the row: its route badge comes from the plan, not from the schema.
 */
export function ParamPane({ engine }: { engine: Engine }) {
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const node = doc.nodes.find((n) => n.id === selection[0]);
  if (!node) return <DocumentInfo doc={doc} />;
  return <NodeParams key={node.id} node={node} doc={doc} engine={engine} multi={selection.length > 1} />;
}

function DocumentInfo({ doc }: { doc: EditorDoc }) {
  return (
    <div className="params">
      <div className="phead">
        <div className="row1">
          <span className="chip" style={{ background: 'var(--cat-output)' }}>project</span>
          <input className="name" value={doc.name} onChange={(e) => store().edit((d) => { d.name = e.target.value; }, 'doc-name')} />
        </div>
        {doc.description && <div className="desc">{doc.description}</div>}
      </div>
      <div className="empty">
        <h3>Select a node to edit its parameters</h3>
        Parameters show up here for one node at a time, grouped into folders, like Houdini's parameter pane.
        <br /><br />
        <kbd>Tab</kbd> in the network adds an operator. Drag from a port to wire it, and right-click a wire to
        insert a node. Drag a <b>Number</b> or <b>Time</b> output toward a node to see which parameters can take it.
        <br /><br />
        Right-click a parameter label for expressions, references, keyframes and promotion. Drag a label
        sideways to scrub the value.
        {doc.credits?.length ? (
          <>
            <br /><br />
            <b>Data</b>
            {doc.credits.map((c) => <div key={c} style={{ fontSize: 11 }}>{c}</div>)}
          </>
        ) : null}
      </div>
    </div>
  );
}

function NodeParams({ node, doc, engine, multi }: { node: DocNode; doc: EditorDoc; engine: Engine; multi: boolean }) {
  const def = OPERATOR_INDEX.get(node.op);
  const runtime = useEditor((s) => s.runtime);
  const [folder, setFolder] = useState<string | undefined>();
  const [nameDraft, setNameDraft] = useState<string | undefined>();
  if (!def) return <div className="params"><div className="empty">Unknown operator {node.op}</div></div>;

  const visible = def.params.filter((p) => !p.when || p.when.is.includes(paramLiteral(node, p.when.param, def.params)));
  const folders = [...new Set(visible.map((p) => p.folder ?? 'Parameters'))];
  const current = folder && folders.includes(folder) ? folder : folders[0];
  const shown = visible.filter((p) => (p.folder ?? 'Parameters') === current);

  const irIds = runtime.lowered?.irNodes[node.id] ?? [];
  const errors = [
    ...(runtime.lowered?.errors.filter((e) => e.nodeId === node.id).map((e) => e.message) ?? []),
    ...irIds.map((id) => runtime.program?.nodes[id]?.error).filter((e): e is string => !!e),
    ...runtime.layers.filter((l) => l.id === node.id && l.error).map((l) => l.error!),
  ];

  const rename = (name: string) => {
    const clean = name.trim().replace(/[^A-Za-z0-9_]/g, '_');
    if (!clean || doc.nodes.some((n) => n.id !== node.id && n.parent === node.parent && nameOf(n) === clean)) return;
    store().edit((d) => { renameNode(d, node.id, clean); });
  };
  const flag = (f: 'bypass' | 'display') => store().edit((d) => {
    const n = d.nodes.find((x) => x.id === node.id)!;
    n.flags = { ...n.flags, [f]: !n.flags?.[f] };
  });

  /** Columns arriving at an input port, from the compiled program. */
  const columnsOf = (port: string | undefined): RelColumn[] => {
    const edge = doc.edges.find((e) => e.target === node.id && e.targetPort === (port ?? def.inputs[0]?.name));
    if (!edge) return [];
    const ir = runtime.lowered?.outputs[edge.source]?.[edge.sourcePort];
    return (ir && runtime.program?.nodes[ir]?.columns) || [];
  };

  const sub = node.op === 'subnet' ? node : undefined;

  return (
    <div className="params">
      <div className="phead">
        <div className="row1">
          <span className="chip" style={{ background: CATEGORY_COLORS[def.category] }}>{def.label}</span>
          <input
            className="name" value={nameDraft ?? nameOf(node)}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => { if (nameDraft !== undefined) rename(nameDraft); setNameDraft(undefined); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          />
          <div className="flags">
            <button className={`flag bypass${node.flags?.bypass ? ' on' : ''}`} title="Bypass (B)" onClick={() => flag('bypass')}>B</button>
            <button className={`flag display${node.flags?.display ? ' on' : ''}`} title="Display: preview rows as a layer (D)" onClick={() => flag('display')}>D</button>
          </div>
        </div>
        <div className="path">{nodePath(doc, node)}{multi ? '  · first of the selection' : ''}</div>
        <div className="desc">{def.description}</div>
      </div>
      {errors.map((e, i) => <div className="nodeerr" key={i}>{e}</div>)}
      {folders.length > 1 && (
        <div className="folders">
          {folders.map((f) => <button key={f} aria-selected={f === current} onClick={() => setFolder(f)}>{f}</button>)}
        </div>
      )}
      <div className="plist">
        {shown.map((p) => (
          <ParamRow key={p.name} node={node} def={p} columns={p.kind === 'column' || p.kind === 'expr' ? columnsOf(p.of) : []} />
        ))}
        {sub && (sub.promoted ?? []).map((pp) => {
          const child = doc.nodes.find((n) => n.id === pp.node);
          const childDef = child && OPERATOR_INDEX.get(child.op)?.params.find((x) => x.name === pp.param);
          if (!childDef) return null;
          return (
            <ParamRow
              key={pp.name} node={sub} def={{ ...childDef, name: pp.name, label: pp.label ?? pp.name, when: undefined }}
              columns={[]} onUnpromote={() => store().edit((d) => unpromote(d, sub.id, pp.name))}
            />
          );
        })}
        {sub && !(sub.promoted?.length) && (
          <div className="empty" style={{ padding: '8px 14px' }}>
            No promoted parameters. Inside the subnet, right-click a parameter label and choose <b>Promote to subnet</b>.
          </div>
        )}
      </div>
      <NodeInfo node={node} engine={engine} />
    </div>
  );
}

function paramLiteral(node: DocNode, name: string, defs: ParamDef[]): string | number | boolean {
  const v: ParamValue | undefined = node.params[name] ?? defs.find((d) => d.name === name)?.default;
  if (isExpr(v) || isRef(v) || Array.isArray(v) || v === undefined) return '';
  return v;
}

/** What the planner did with this node: its relation, its placement, its layer's numbers. */
function NodeInfo({ node }: { node: DocNode; engine: Engine }) {
  const runtime = useEditor((s) => s.runtime);
  const def = OPERATOR_INDEX.get(node.op)!;
  const irIds = runtime.lowered?.irNodes[node.id] ?? [];
  const out = runtime.lowered?.outputs[node.id]?.out ?? irIds[irIds.length - 1];
  const rel = runtime.program?.relations.find((r) => r.id === out);
  const layer = runtime.layers.find((l) => l.id === node.id);
  const info = out ? runtime.program?.nodes[out] : undefined;
  const engines = irIds.flatMap((id) => Object.entries(runtime.program?.nodes[id]?.engines ?? {}).map(([layerId, e]) => `${id} → ${e} (in ${layerId})`));
  const time = useEditor((s) => s.time);
  const animated = def.params.filter((p) => runtime.lowered?.scalars.animated(`${node.id}.${p.name}`));
  const doc = useEditor((s) => s.doc);
  const keyed = def.params.filter((p) => keyframeAt(doc.timeline?.tracks.find((t) => t.target === `${node.id}.${p.name}`), time));

  if (!rel && !layer && !engines.length && def.category !== 'number') return null;
  return (
    <>
      {rel && (
        <div className="section">
          <h4>Relation</h4>
          <dl className="kv">
            <dt>memo</dt><dd>{rel.materialize ? `temp table ${rel.table}` : 'inlined into its reader'}</dd>
            <dt>rows</dt><dd>{rel.rows?.toLocaleString() ?? '—'}</dd>
            <dt>columns</dt><dd>{rel.shape.columns.length}{rel.shape.vectors.length ? ` · vectors ${rel.shape.vectors.map((v) => `${v.name}[${v.width}]`).join(', ')}` : ''}</dd>
            {rel.params.length > 0 && <><dt>inlines</dt><dd>{rel.params.join(', ')}</dd></>}
          </dl>
          <pre className="code">{rel.sql}</pre>
        </div>
      )}
      {engines.length > 0 && (
        <div className="section">
          <h4>Placement</h4>
          <dl className="kv">{engines.map((e) => <dd key={e} style={{ gridColumn: '1 / -1' }}>{e}</dd>)}</dl>
          {info?.relation && !rel && <div style={{ color: 'var(--faint)', marginTop: 4, fontSize: 11 }}>reads relation {info.relation}</div>}
        </div>
      )}
      {layer && (
        <div className="section">
          <h4>Layer</h4>
          <dl className="kv">
            <dt>instances</dt><dd>{layer.data?.rows.toLocaleString() ?? '—'}{layer.data?.starts ? ` in ${layer.data.starts.length.toLocaleString()} paths` : ''}</dd>
            <dt>query</dt><dd>{layer.queryMs.toFixed(1)} ms</dd>
            <dt>cpu stage</dt><dd>{layer.evalMs.toFixed(1)} ms</dd>
            <dt>policy</dt><dd>{layer.plan.plan.explain.method}</dd>
            <dt>bindings</dt><dd>{layer.plan.plan.layer?.bindings.map((b) => `${b.channel}←${b.attribute}`).join(', ')}</dd>
            {layer.plan.plan.sqlParams.length > 0 && <><dt>binds</dt><dd>{layer.plan.plan.sqlParams.join(', ')}</dd></>}
          </dl>
          <pre className="code">{layer.plan.plan.sql}</pre>
        </div>
      )}
      {(animated.length > 0 || keyed.length > 0) && (
        <div className="section">
          <h4>Animation</h4>
          <dl className="kv">
            <dt>animated</dt><dd>{animated.map((p) => p.label).join(', ') || '—'}</dd>
            <dt>key here</dt><dd>{keyed.map((p) => p.label).join(', ') || '—'}</dd>
          </dl>
        </div>
      )}
    </>
  );
}

export { bindingOf };
