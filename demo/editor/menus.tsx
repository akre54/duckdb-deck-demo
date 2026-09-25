import { useEffect, useMemo, useRef, useState } from 'react';
import { OPERATORS, type OpDef } from '@noodles.gl/planner';
import { CATEGORY_COLORS } from './network/OpNode.js';

const CATEGORY_ORDER = ['data', 'table', 'rows', 'color', 'layer', 'output', 'number', 'structure'];
const HIDDEN = new Set(['subnet-input', 'subnet-output']);

/** Houdini's TAB menu: type to filter, arrows to move, Enter to place. */
export function TabMenu({ x, y, onPick, onClose, filter, inSubnet }: {
  x: number; y: number;
  onPick: (op: OpDef) => void;
  onClose: () => void;
  filter?: (op: OpDef) => boolean;
  inSubnet?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return OPERATORS
      .filter((o) => (inSubnet || !HIDDEN.has(o.type)) && (!filter || filter(o)))
      .filter((o) => !q || o.label.toLowerCase().includes(q) || o.type.includes(q) || o.category.includes(q))
      .sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));
  }, [query, filter, inSubnet]);

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [onClose]);

  const left = Math.min(x, window.innerWidth - 310);
  const top = Math.min(y, window.innerHeight - 420);
  let lastCat = '';
  return (
    <div className="tabmenu" ref={ref} style={{ left, top }}>
      <input
        autoFocus placeholder="Add operator…" value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
          else if (e.key === 'Enter' && items[active]) onPick(items[active]);
          else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); onClose(); }
        }}
      />
      <div className="list">
        {items.map((o, i) => {
          const header = o.category !== lastCat ? <div className="cat" key={`c-${o.category}`}>{o.category}</div> : null;
          lastCat = o.category;
          return [
            header,
            <div
              key={o.type} className={`item${i === active ? ' active' : ''}`} title={o.description}
              onMouseEnter={() => setActive(i)} onClick={() => onPick(o)}
            >
              <span className="sw" style={{ background: CATEGORY_COLORS[o.category] }} />
              <span>{o.label}</span>
              <small>{o.description}</small>
            </div>,
          ];
        })}
        {items.length === 0 && <div className="cat">nothing matches</div>}
      </div>
    </div>
  );
}

export interface MenuItem {
  label?: string;
  onClick?: () => void;
  disabled?: boolean;
  separator?: boolean;
  heading?: string;
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey); };
  }, [onClose]);
  return (
    <div className="menu" ref={ref} style={{ left: Math.min(x, window.innerWidth - 200), top: Math.min(y, window.innerHeight - items.length * 28 - 10) }}>
      {items.map((it, i) => {
        if (it.separator) return <hr key={i} />;
        if (it.heading) return <div className="label" key={i}>{it.heading}</div>;
        return (
          <button key={i} disabled={it.disabled} onClick={() => { it.onClick?.(); onClose(); }}>{it.label}</button>
        );
      })}
    </div>
  );
}
