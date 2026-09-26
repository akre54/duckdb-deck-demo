import { useEffect, useState } from 'react';
import { OPERATOR_INDEX, nameOf } from '@noodles.gl/planner';
import { useEditor } from '../store.js';
import type { Engine } from '../engine.js';
import type { Preview } from '../../../src/program/index.js';

/**
 * Houdini's geometry spreadsheet: the rows at the selected node's output, read from its
 * memoized relation (or lowered to SQL over it), so looking costs one LIMIT query.
 */
export function Spreadsheet({ engine }: { engine: Engine }) {
  const selection = useEditor((s) => s.selection);
  const doc = useEditor((s) => s.doc);
  const version = useEditor((s) => s.runtime.version);
  const lowered = useEditor((s) => s.runtime.lowered);
  const [preview, setPreview] = useState<Preview | undefined>();
  const [error, setError] = useState<string | undefined>();
  const node = doc.nodes.find((n) => n.id === selection[0]);
  const ir = node ? lowered?.outputs[node.id]?.out ?? (lowered?.irNodes[node.id] ?? []).slice(-1)[0] : undefined;

  useEffect(() => {
    let live = true;
    setError(undefined);
    if (!ir || !engine.runtime) { setPreview(undefined); return; }
    engine.runtime.preview(ir).then((p) => { if (live) setPreview(p); }, (err) => { if (live) setError(String(err)); });
    return () => { live = false; };
  }, [ir, version, engine]);

  if (!node) return <div className="sheet"><div className="bar">Select a node to see its rows.</div></div>;
  const def = OPERATOR_INDEX.get(node.op);
  if (def?.category === 'number') return <div className="sheet"><div className="bar">{nameOf(node)} is a number, not rows.</div></div>;
  return (
    <div className="sheet">
      <div className="bar">
        <b style={{ color: 'var(--ink)' }}>{nameOf(node)}</b>
        {preview && <span>{preview.total.toLocaleString()} rows · {preview.columns.length} columns · first {preview.rows.length}</span>}
        {preview?.note && <span style={{ color: '#e2c75b' }}>{preview.note}</span>}
        {error && <span style={{ color: 'var(--warn)' }}>{error}</span>}
      </div>
      <div className="scroll">
        {preview && (
          <table>
            <thead>
              <tr>
                <th className="idx">#</th>
                {preview.columns.map((c) => <th key={c.name}>{c.name}<small>{c.duckType}</small></th>)}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((r, i) => (
                <tr key={i}>
                  <td className="idx">{i}</td>
                  {preview.columns.map((c) => {
                    const v = r[c.name];
                    return <td key={c.name} className={v == null ? 'null' : c.type === 'str' ? 'str' : ''}>{show(v)}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function show(v: unknown): string {
  if (v == null) return 'null';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toPrecision(7).replace(/\.?0+$/, '');
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'object') {
    try { return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x)).slice(0, 120); } catch { return String(v); }
  }
  return String(v);
}
