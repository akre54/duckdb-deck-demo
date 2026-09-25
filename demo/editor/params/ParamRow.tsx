import { useEffect, useRef, useState } from 'react';
import {
  bindingOf, isExpr, isRef, nameOf, keyframeAt, exprError,
  type DocNode, type ParamDef, type ParamValue, type RelColumn,
} from '@noodles.gl/planner';
import { store, useEditor, type RuntimeView } from '../store.js';
import { ContextMenu, type MenuItem } from '../menus.js';
import { setKey, removeKey, clearTrack, promote, pathTo } from '../doc-ops.js';

type Mode = 'literal' | 'expr' | 'ref';

const ROUTE_HELP: Record<string, string> = {
  prop: 'deck applies it as a uniform: no query, no CPU pass',
  uniform: 'a uniform write into the fused GPU kernel',
  cpu: 'the layer’s generated JS loop re-runs; no query',
  requery: 'the layer’s prepared statement is rebound and re-run',
  rematerialize: 'a relation is rebuilt (memoized by value) and its readers requeried',
  rebuild: 'structural: the graph recompiles; memoization limits it to what changed',
};

export function ParamRow({ node, def, columns, onUnpromote }: {
  node: DocNode; def: ParamDef; columns: RelColumn[]; onUnpromote?: () => void;
}) {
  const doc = useEditor((s) => s.doc);
  const time = useEditor((s) => s.time);
  const runtime = useEditor((s) => s.runtime);
  const copied = useEditor((s) => s.copiedParam);
  const [menu, setMenu] = useState<{ x: number; y: number } | undefined>();

  const key = `${node.id}.${def.name}`;
  const raw: ParamValue = node.params[def.name] ?? def.default;
  const mode: Mode = isExpr(raw) && def.kind !== 'expr' && def.kind !== 'code' ? 'expr' : isRef(raw) ? 'ref' : 'literal';
  const wire = doc.edges.find((e) => e.target === node.id && e.targetPort === `par:${def.name}`);
  const evaluated = runtime.slots.get(key);
  const slotError = runtime.slotErrors.get(key);
  const track = doc.timeline?.tracks.find((t) => t.target === key);
  const keyHere = keyframeAt(track, time);
  const numeric = def.kind === 'float' || def.kind === 'int';
  const animatable = numeric && bindingOf(def) !== 'structural' && !wire;

  const set = (value: ParamValue, tag = `p:${key}`) => store().edit((d) => {
    const n = d.nodes.find((x) => x.id === node.id)!;
    // Editing a keyframed parameter keys it at the playhead, as Houdini does.
    const tr = d.timeline?.tracks.find((t) => t.target === key);
    if (tr && typeof value === 'number') setKey(d, key, store().get().time, value);
    else n.params[def.name] = value;
  }, tag);

  const routes = routeBadges(def, key, runtime);

  const items: MenuItem[] = [
    { heading: `${def.label} · ${key}` },
    ...(numeric ? [
      mode === 'expr'
        ? { label: 'Revert to value', onClick: () => set(Number(evaluated ?? def.default)) }
        : { label: 'Set expression…', onClick: () => { const e = prompt('Expression (T = seconds, F = frame, ch(\'node/param\') reads a parameter):', mode === 'ref' && isRef(raw) ? `ch('${raw.ref}')` : String(evaluated ?? def.default)); if (e) set({ expr: e }); } },
    ] : []),
    { label: 'Copy parameter', onClick: () => store().set({ copiedParam: key }) },
    {
      label: copied ? `Paste relative reference (${copied})` : 'Paste relative reference',
      disabled: !copied || copied === key,
      onClick: () => { if (copied) set({ ref: pathTo(doc, node, copied) }); },
    },
    ...(mode === 'ref' ? [{ label: 'Remove reference', onClick: () => set(Number.isFinite(Number(evaluated)) ? Number(evaluated) : def.default) }] : []),
    { separator: true },
    ...(animatable ? [
      { label: keyHere ? 'Remove keyframe' : 'Set keyframe', onClick: () => store().edit((d) => { if (keyHere) removeKey(d, key, time); else setKey(d, key, time, Number(evaluated ?? def.default)); }) },
      { label: 'Delete channel (all keyframes)', disabled: !track, onClick: () => store().edit((d) => clearTrack(d, key)) },
    ] : []),
    { label: 'Revert to default', onClick: () => store().edit((d) => { delete d.nodes.find((x) => x.id === node.id)!.params[def.name]; clearTrack(d, key); }) },
    ...(node.parent && !onUnpromote ? [{ separator: true }, { label: 'Promote to subnet', onClick: () => store().edit((d) => promote(d, node.id, def.name, raw)) }] : []),
    ...(onUnpromote ? [{ separator: true }, { label: 'Remove promotion', onClick: onUnpromote }] : []),
  ];

  const scrub = useScrub(numeric && mode === 'literal' && !wire, def, () => Number(evaluated ?? raw ?? 0), (v) => set(v, `scrub:${key}`));
  const wide = def.kind === 'code';

  return (
    <div className={`prow${wide ? ' wide' : ''}`}>
      <span
        className={`plabel${numeric && mode === 'literal' && !wire ? '' : ' static'}`}
        title={`${def.help ?? def.label}\n${key}`}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
        onPointerDown={scrub}
      >{def.label}</span>
      <div className="widget">
        {wire ? (
          <span className="wired">← {nameOf(doc.nodes.find((n) => n.id === wire.source) ?? node)} = {fmt(evaluated)}</span>
        ) : mode === 'expr' ? (
          <>
            <Text value={(raw as { expr: string }).expr} className="expr expr-mode" onCommit={(v) => set({ expr: v })} />
            <span className="evaluated">{fmt(evaluated)}</span>
          </>
        ) : mode === 'ref' ? (
          <>
            <Text value={(raw as { ref: string }).ref} className="expr ref-mode" onCommit={(v) => set({ ref: v })} />
            <span className="evaluated">{fmt(evaluated)}</span>
          </>
        ) : (
          <Widget def={def} value={raw} evaluated={evaluated} columns={columns} onChange={set} keyed={!!track} />
        )}
      </div>
      {animatable ? (
        <button
          className={`diamond${track ? ' track' : ''}${keyHere ? ' on' : ''}`}
          title={keyHere ? 'Keyframe at playhead (click to remove)' : track ? 'Animated: click to key the current value' : 'Click to set a keyframe'}
          onClick={() => store().edit((d) => { if (keyHere) removeKey(d, key, time); else setKey(d, key, time, Number(evaluated ?? def.default)); })}
        />
      ) : <span />}
      {slotError && <div className="perr">{slotError}</div>}
      {mode === 'literal' && !wire && (def.kind === 'expr') && <ExprCheck text={String(raw)} />}
      {routes.length > 0 && (
        <div className="routes">
          {routes.map((r) => <span key={r.route + r.target} className={`route ${r.route}`} title={`${ROUTE_HELP[r.route]}${r.target ? ` → ${r.target}` : ''}`}>{r.route}{r.target && routes.length > 1 ? ` ${r.target}` : ''}</span>)}
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(undefined)} />}
    </div>
  );
}

function routeBadges(def: ParamDef, key: string, runtime: RuntimeView) {
  const names = runtime.lowered?.slotParams[key] ?? [];
  const out: { route: string; target: string }[] = [];
  for (const n of names) for (const r of runtime.program?.routes[n] ?? []) {
    if (!out.some((x) => x.route === r.route && x.target === r.target)) out.push(r);
  }
  const binding = bindingOf(def);
  if (out.length === 0 && binding === 'structural' && def.kind !== 'code') out.push({ route: 'rebuild', target: '' });
  return out;
}

function ExprCheck({ text }: { text: string }) {
  // An empty channel is unbound, not malformed.
  if (!text.trim()) return null;
  // ch() references are rewritten to parameters before the planner sees the text.
  const err = exprError(text.replace(/\bch\(\s*(['"]).*?\1\s*\)/g, '{{ref}}'));
  return err ? <div className="perr">{err}</div> : null;
}

function Widget({ def, value, evaluated, columns, onChange, keyed }: {
  def: ParamDef; value: ParamValue; evaluated: unknown; columns: RelColumn[]; onChange: (v: ParamValue) => void; keyed: boolean;
}) {
  switch (def.kind) {
    case 'float':
    case 'int': {
      const v = Number(keyed ? evaluated : value);
      const step = def.step ?? (def.kind === 'int' ? 1 : 0.01);
      const lo = Math.min(def.min ?? 0, v);
      const hi = Math.max(def.max ?? 100, v);
      return (
        <>
          <input type="range" min={lo} max={hi} step={step} value={Number.isFinite(v) ? v : 0} onChange={(e) => onChange(clean(Number(e.target.value), def))} />
          <NumberField value={v} step={step} onCommit={(x) => onChange(clean(x, def))} />
        </>
      );
    }
    case 'toggle':
      return <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
    case 'menu':
      return (
        <select value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {def.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    case 'column': {
      const names = columns.filter((c) => !def.columnType || def.columnType === 'any' || c.type === def.columnType).map((c) => c.name);
      const cur = String(value ?? '');
      return (
        <select value={cur} onChange={(e) => onChange(e.target.value)}>
          {!names.includes(cur) && <option value={cur}>{cur || '— choose —'}{cur ? ' (not in input)' : ''}</option>}
          {columns.map((c) => <option key={c.name} value={c.name} disabled={!names.includes(c.name)}>{c.name}  ·  {c.duckType.toLowerCase()}</option>)}
        </select>
      );
    }
    case 'color': {
      const rgb = Array.isArray(value) ? value : [255, 255, 255];
      const hex = `#${rgb.slice(0, 3).map((c) => Math.round(Number(c)).toString(16).padStart(2, '0')).join('')}`;
      return (
        <>
          <input type="color" value={hex} onChange={(e) => {
            const h = e.target.value;
            onChange([parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
          }} />
          <span className="evaluated">{rgb.join(', ')}</span>
        </>
      );
    }
    case 'code':
      return <Code value={String(value)} language={def.language} onCommit={onChange} />;
    case 'expr':
      return <Text value={String(value)} className="expr" onCommit={onChange} list={columns.map((c) => c.name)} />;
    default:
      return <Text value={String(value ?? '')} onCommit={onChange} />;
  }
}

function clean(x: number, def: ParamDef): number {
  return def.kind === 'int' ? Math.round(x) : x;
}

/** Commits on Enter or blur, so each keystroke is not a recompile. */
function Text({ value, onCommit, className, list }: { value: string; onCommit: (v: string) => void; className?: string; list?: string[] }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const id = useRef(`dl${Math.random().toString(36).slice(2)}`).current;
  return (
    <>
      <input
        type="text" className={className} value={draft} spellCheck={false} list={list?.length ? id : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (draft !== value) onCommit(draft); }}
        onKeyDown={(e) => { if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); } if (e.key === 'Escape') setDraft(value); }}
      />
      {list?.length ? <datalist id={id}>{list.map((c) => <option key={c} value={c} />)}</datalist> : null}
    </>
  );
}

function NumberField({ value, step, onCommit }: { value: number; step: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState<string | undefined>();
  const decimals = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)));
  return (
    <input
      type="number" step={step}
      value={draft ?? (Number.isFinite(value) ? Number(value.toFixed(decimals)) : '')}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft !== undefined && draft !== '' && Number.isFinite(Number(draft))) onCommit(Number(draft)); setDraft(undefined); }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
    />
  );
}

function Code({ value, language, onCommit }: { value: string; language?: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const dirty = draft !== value;
  return (
    <div style={{ width: '100%' }}>
      <textarea
        value={draft} spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); onCommit(draft); }
          if (e.key === 'Tab') {
            e.preventDefault();
            const t = e.target as HTMLTextAreaElement;
            const at = t.selectionStart;
            setDraft(draft.slice(0, at) + '  ' + draft.slice(t.selectionEnd));
            requestAnimationFrame(() => { t.selectionStart = t.selectionEnd = at + 2; });
          }
        }}
      />
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 3 }}>
        <button className="btn small primary" disabled={!dirty} onClick={() => onCommit(draft)}>Apply</button>
        <span style={{ color: 'var(--faint)', fontSize: 10.5 }}>{language ?? 'code'} · ⌘/Ctrl+Enter</span>
        {dirty && <button className="btn small" onClick={() => setDraft(value)}>Revert</button>}
      </div>
    </div>
  );
}

/**
 * Drag a label sideways to change its value — Houdini's "ladder" in its simplest form. Shift
 * for fine, Alt for coarse. Each drag is one undo step.
 */
function useScrub(enabled: boolean, def: ParamDef, get: () => number, set: (v: number) => void) {
  return (e: React.PointerEvent) => {
    if (!enabled || e.button !== 0) return;
    const start = e.clientX;
    const from = get();
    const base = def.step ?? (def.kind === 'int' ? 1 : 0.01);
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start;
      if (Math.abs(dx) > 2) moved = true;
      if (!moved) return;
      const scale = ev.shiftKey ? 0.1 : ev.altKey ? 10 : 1;
      let v = from + dx * base * scale;
      if (def.kind === 'int') v = Math.round(v);
      set(Number(v.toFixed(6)));
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
}

function fmt(v: unknown): string {
  if (typeof v === 'number') return Number.isFinite(v) ? (Math.abs(v) >= 1e4 ? v.toExponential(2) : String(+v.toFixed(3))) : 'NaN';
  if (Array.isArray(v)) return v.join(', ');
  return v === undefined ? '' : String(v);
}
