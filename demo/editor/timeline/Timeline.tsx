import { useEffect, useMemo, useRef, useState } from 'react';
import {
  EASING_PRESETS, evaluateTrack, presetName, nameOf, OPERATOR_INDEX,
  type Track, type Keyframe, type EditorDoc,
} from '@noodles.gl/planner';
import { store, useEditor } from '../store.js';
import type { Engine } from '../engine.js';
import { ContextMenu, type MenuItem } from '../menus.js';
import { ensureTimeline, removeKeysById, setKey, updateKey, clearTrack } from '../doc-ops.js';

/**
 * The keyframe editor, after Noodles' native timeline: a dope sheet of tracks with diamond
 * keys, and a curve view of the same tracks with editable bezier handles.
 *
 * A track drives one parameter, `node.param`. The interpolation math (`evaluateTrack`, the
 * bezier easing and its presets) is Noodles' own, ported to the planner; this file is only the
 * editing surface. Keying a parameter makes it animated, which the lowering declares to the
 * planner at the timeline's frame rate — so animating a filter threshold and animating a deck
 * prop are priced differently, and the plan view shows which one you built.
 */

const ROW = 22;
const RULER = 20;

type View = 'dope' | 'curves';

export function Timeline({ engine }: { engine: Engine }) {
  const doc = useEditor((s) => s.doc);
  const time = useEditor((s) => s.time);
  const playing = useEditor((s) => s.playing);
  const loop = useEditor((s) => s.loop);
  const selectedKeys = useEditor((s) => s.selectedKeys);
  const selection = useEditor((s) => s.selection);
  const [view, setView] = useState<View>('dope');
  const [collapsed, setCollapsed] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | undefined>();
  const canvas = useRef<HTMLDivElement>(null);
  const width = useWidth(canvas);

  const tl = doc.timeline ?? { length: 10, fps: 30, tracks: [] };
  const tracks = useMemo(() => [...tl.tracks].sort((a, b) => a.target.localeCompare(b.target)), [tl.tracks]);
  const x = (t: number) => (t / tl.length) * Math.max(1, width - 16) + 8;
  const tAt = (px: number) => Math.min(tl.length, Math.max(0, ((px - 8) / Math.max(1, width - 16)) * tl.length));
  const snap = (t: number) => Math.round(t * tl.fps) / tl.fps;

  const setTimeline = (patch: Partial<NonNullable<EditorDoc['timeline']>>) =>
    store().edit((d) => { Object.assign(ensureTimeline(d), patch); }, 'timeline-settings');

  // --- scrubbing ------------------------------------------------------------
  const scrub = (e: React.PointerEvent) => {
    const rect = canvas.current!.getBoundingClientRect();
    const go = (cx: number) => store().set({ time: snap(tAt(cx - rect.left)) });
    go(e.clientX);
    const move = (ev: PointerEvent) => go(ev.clientX);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // --- keys -----------------------------------------------------------------
  const dragKey = (e: React.PointerEvent, track: Track, key: Keyframe, mode: 'time' | 'both', valueScale?: (dy: number) => number) => {
    e.stopPropagation();
    const additive = e.shiftKey;
    const sel = store().get().selectedKeys;
    const next = additive ? (sel.includes(key.id) ? sel.filter((k) => k !== key.id) : [...sel, key.id]) : sel.includes(key.id) ? sel : [key.id];
    store().set({ selectedKeys: next });
    const rect = canvas.current!.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const originals = new Map(store().get().doc.timeline!.tracks.flatMap((t) => t.keyframes).filter((k) => next.includes(k.id)).map((k) => [k.id, { time: k.time, value: k.value }]));
    const move = (ev: PointerEvent) => {
      const dt = tAt(ev.clientX - rect.left) - tAt(startX - rect.left);
      const dv = mode === 'both' && valueScale ? valueScale(ev.clientY - startY) : 0;
      store().edit((d) => {
        for (const [id, o] of originals) {
          const patch: Partial<Keyframe> = { time: snap(Math.min(tl.length, Math.max(0, o.time + dt))) };
          if (mode === 'both' && typeof o.value === 'number' && id === key.id) patch.value = o.value + dv;
          updateKey(d, id, patch);
        }
      }, `drag-keys:${key.id}`);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    void track;
  };

  const keyMenu = (e: React.MouseEvent, key: Keyframe) => {
    e.preventDefault();
    e.stopPropagation();
    const ids = selectedKeys.includes(key.id) ? selectedKeys : [key.id];
    store().set({ selectedKeys: ids });
    const apply = (patch: Partial<Keyframe>) => store().edit((d) => { for (const id of ids) updateKey(d, id, patch); });
    setMenu({
      x: e.clientX, y: e.clientY, items: [
        { heading: `${ids.length} key${ids.length > 1 ? 's' : ''} · ${presetName(key.handles) ?? key.interpolation}` },
        { label: 'Linear', onClick: () => apply({ interpolation: 'linear' }) },
        { label: 'Hold (step)', onClick: () => apply({ interpolation: 'hold' }) },
        { separator: true },
        { heading: 'Bezier easing' },
        ...EASING_PRESETS.map((p) => ({ label: p.name, onClick: () => apply({ interpolation: 'bezier', handles: p.handles }) })),
        { separator: true },
        { label: 'Delete', onClick: () => { store().edit((d) => removeKeysById(d, ids)); store().set({ selectedKeys: [] }); } },
      ],
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      const sel = store().get().selectedKeys;
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel.length && store().get().selection.length === 0) {
        store().edit((d) => removeKeysById(d, sel));
        store().set({ selectedKeys: [] });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Key every camera parameter of the Deck node at the playhead, from where the map is now.
  const keyCamera = () => {
    const deck = doc.nodes.find((n) => n.op === 'deck');
    const cam = engine.cameraNow();
    if (!deck || !cam) return;
    store().edit((d) => {
      for (const [k, v] of Object.entries(cam)) setKey(d, `${deck.id}.${k}`, snap(store().get().time), v);
      const n = d.nodes.find((x) => x.id === deck.id)!;
      n.params.follow = true;
    });
  };

  const label = (target: string) => {
    const [id, param] = [target.slice(0, target.indexOf('.')), target.slice(target.indexOf('.') + 1)];
    const n = doc.nodes.find((x) => x.id === id);
    const def = n && OPERATOR_INDEX.get(n.op)?.params.find((p) => p.name === param);
    return { node: n ? nameOf(n) : id, param: def?.label ?? param, id };
  };

  const frame = Math.round(time * tl.fps);
  return (
    <div className={`timeline${collapsed ? ' collapsed' : ''}`}>
      <div className="tl-bar">
        <button onClick={() => store().set({ time: 0 })} title="To start (Home)">⏮</button>
        <button className={playing ? 'on' : ''} onClick={() => store().set({ playing: !playing })} title="Play / pause (Space)">{playing ? '❚❚' : '▶'}</button>
        <button className={loop ? 'on' : ''} onClick={() => store().set({ loop: !loop })} title="Loop">⟲</button>
        <span className="time">{time.toFixed(2)} s · f{frame}</span>
        <label>length <input type="number" min={1} step={1} value={tl.length} onChange={(e) => setTimeline({ length: Math.max(1, Number(e.target.value)) })} /> s</label>
        <label>fps <input type="number" min={1} max={120} step={1} value={tl.fps} onChange={(e) => setTimeline({ fps: Math.max(1, Math.round(Number(e.target.value))) })} /></label>
        <span style={{ flex: 1 }} />
        <button onClick={keyCamera} title="Key the Deck node's camera from the current map view, and make the map follow it">◆ key camera</button>
        <button className={view === 'dope' ? 'on' : ''} onClick={() => setView('dope')}>Dope sheet</button>
        <button className={view === 'curves' ? 'on' : ''} onClick={() => setView('curves')}>Curves</button>
        <button onClick={() => { setCollapsed(!collapsed); setTimeout(() => engine.map?.resize(), 0); }} title="Collapse">{collapsed ? '▴' : '▾'}</button>
      </div>
      {!collapsed && (
        <div className="tl-body">
          <div className="tl-tracks" style={{ paddingTop: RULER }}>
            {tracks.map((t) => {
              const l = label(t.target);
              const sel = selection.includes(l.id);
              return (
                <div key={t.target} className={`tl-track-label${sel ? ' sel' : ''}`} onClick={() => store().set({ selection: [l.id] })} title={t.target}>
                  <span style={{ color: '#e6b53d' }}>◆</span>{l.node}<span style={{ color: 'var(--faint)' }}>.{l.param}</span>
                  <span className="x" onClick={(e) => { e.stopPropagation(); store().edit((d) => clearTrack(d, t.target)); }}>✕</span>
                </div>
              );
            })}
          </div>
          <div className="tl-canvas" ref={canvas} onPointerDown={(e) => { if (e.button === 0) { store().set({ selectedKeys: [] }); scrub(e); } }}>
            <svg width={width} height="100%">
              <Ruler length={tl.length} fps={tl.fps} x={x} width={width} />
              {view === 'dope'
                ? tracks.map((t, i) => (
                  <g key={t.target} transform={`translate(0 ${RULER + i * ROW})`}>
                    <rect x={0} y={0} width={width} height={ROW} fill={i % 2 ? '#ffffff03' : 'transparent'}
                      onDoubleClick={(e) => {
                        const rect = canvas.current!.getBoundingClientRect();
                        const at = snap(tAt(e.clientX - rect.left));
                        const v = evaluateTrack(t, at);
                        if (typeof v === 'number') store().edit((d) => setKey(d, t.target, at, v));
                      }} />
                    {t.keyframes.map((k, j) => {
                      const next = t.keyframes[j + 1];
                      return next ? <line key={`s${k.id}`} x1={x(k.time)} x2={x(next.time)} y1={ROW / 2} y2={ROW / 2} stroke={k.interpolation === 'hold' ? '#6b5a2a' : '#5b4a1f'} strokeWidth={2} strokeDasharray={k.interpolation === 'hold' ? '2 3' : undefined} /> : null;
                    })}
                    {t.keyframes.map((k) => (
                      <rect key={k.id} x={x(k.time) - 5} y={ROW / 2 - 5} width={10} height={10} transform={`rotate(45 ${x(k.time)} ${ROW / 2})`}
                        fill={selectedKeys.includes(k.id) ? '#ffd76a' : k.interpolation === 'linear' ? '#9fb7e6' : k.interpolation === 'hold' ? '#b88e3a' : '#e6b53d'}
                        stroke="#1a1d25" strokeWidth={1} style={{ cursor: 'ew-resize' }}
                        onPointerDown={(e) => dragKey(e, t, k, 'time')}
                        onContextMenu={(e) => keyMenu(e, k)}>
                        <title>{`${k.time.toFixed(2)} s = ${k.value} · ${presetName(k.handles) ?? k.interpolation}`}</title>
                      </rect>
                    ))}
                  </g>
                ))
                : <Curves tracks={tracks.filter((t) => selection.length === 0 || selection.includes(t.target.split('.')[0]))} x={x} width={width} length={tl.length} selectedKeys={selectedKeys} onDragKey={dragKey} onKeyMenu={keyMenu} />}
              <line x1={x(time)} x2={x(time)} y1={0} y2="100%" stroke="#4d8dff" strokeWidth={1.5} pointerEvents="none" />
              <rect x={x(time) - 5} y={0} width={10} height={8} fill="#4d8dff" pointerEvents="none" />
            </svg>
            {tracks.length === 0 && (
              <div className="tl-empty">No animation yet. Click a ◇ next to a parameter to key it, or ◆ key camera to animate the map.</div>
            )}
          </div>
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(undefined)} />}
    </div>
  );
}

function Ruler({ length, fps, x, width }: { length: number; fps: number; x: (t: number) => number; width: number }) {
  // A major tick every 1, 2, 5, 10… seconds, whichever leaves at least ~60 px between labels.
  const pxPerSecond = (width - 16) / length;
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const major = steps.find((s) => s * pxPerSecond >= 60) ?? 600;
  const ticks: number[] = [];
  for (let t = 0; t <= length + 1e-9; t += major) ticks.push(+t.toFixed(3));
  return (
    <g>
      <rect x={0} y={0} width={width} height={RULER} fill="#1a1d25" />
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={RULER - 6} y2={RULER} stroke="#4a5064" />
          <line x1={x(t)} x2={x(t)} y1={RULER} y2="100%" stroke="#ffffff08" />
          <text x={x(t) + 3} y={12} fill="#7f889c" fontSize={9.5} fontFamily="ui-monospace, monospace">{t}s</text>
        </g>
      ))}
      <text x={width - 60} y={12} fill="#5b6377" fontSize={9} fontFamily="ui-monospace, monospace">{fps} fps</text>
    </g>
  );
}

/**
 * The curve view: value over time for the visible tracks, each normalized to its own range.
 * Keys drag in time and value; the handles of a bezier segment drag to reshape its easing.
 */
function Curves({ tracks, x, width, length, selectedKeys, onDragKey, onKeyMenu }: {
  tracks: Track[]; x: (t: number) => number; width: number; length: number; selectedKeys: string[];
  onDragKey: (e: React.PointerEvent, track: Track, key: Keyframe, mode: 'time' | 'both', valueScale?: (dy: number) => number) => void;
  onKeyMenu: (e: React.MouseEvent, key: Keyframe) => void;
}) {
  const height = 132 - RULER - 8;
  const colors = ['#e6b53d', '#6ea8fe', '#4fd6a8', '#f07a9a', '#b98cf0', '#f0a05a'];
  return (
    <g transform={`translate(0 ${RULER + 4})`}>
      {tracks.map((t, ti) => {
        const nums = t.keyframes.map((k) => Number(k.value)).filter(Number.isFinite);
        if (nums.length === 0) return null;
        let lo = Math.min(...nums);
        let hi = Math.max(...nums);
        if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
        const pad = (hi - lo) * 0.12;
        lo -= pad; hi += pad;
        const y = (v: number) => height - ((v - lo) / (hi - lo)) * height;
        const pts: string[] = [];
        const samples = Math.max(40, Math.round(width / 3));
        for (let i = 0; i <= samples; i++) {
          const tt = (i / samples) * length;
          const v = Number(evaluateTrack(t, tt));
          pts.push(`${x(tt).toFixed(1)},${y(v).toFixed(1)}`);
        }
        const color = colors[ti % colors.length];
        const scale = (dy: number) => -(dy / height) * (hi - lo);
        return (
          <g key={t.target}>
            <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={1.5} opacity={0.9} />
            {t.keyframes.map((k, j) => {
              const next = t.keyframes[j + 1];
              if (!next || k.interpolation !== 'bezier' || typeof k.value !== 'number' || typeof next.value !== 'number') return null;
              const h = k.handles ?? { left: [0, 0], right: [1, 1] };
              const x0 = x(k.time); const x1 = x(next.time);
              const y0 = y(k.value); const y1 = y(next.value);
              const c1 = [x0 + h.left[0] * (x1 - x0), y0 + h.left[1] * (y1 - y0)];
              const c2 = [x0 + h.right[0] * (x1 - x0), y0 + h.right[1] * (y1 - y0)];
              const dragHandle = (which: 'left' | 'right') => (e: React.PointerEvent) => {
                e.stopPropagation();
                const svg = (e.target as SVGElement).ownerSVGElement!.getBoundingClientRect();
                const move = (ev: PointerEvent) => {
                  const px = ev.clientX - svg.left;
                  const py = ev.clientY - svg.top - RULER - 4;
                  const nx = Math.min(1, Math.max(0, (px - x0) / Math.max(1, x1 - x0)));
                  const ny = Math.abs(y1 - y0) < 1e-6 ? h[which][1] : (py - y0) / (y1 - y0);
                  store().edit((d) => updateKey(d, k.id, { handles: { ...h, [which]: [nx, ny] } as Keyframe['handles'] }), `handle:${k.id}:${which}`);
                };
                const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
                window.addEventListener('pointermove', move);
                window.addEventListener('pointerup', up);
              };
              return (
                <g key={`h${k.id}`} opacity={selectedKeys.includes(k.id) || selectedKeys.includes(next.id) ? 1 : 0.45}>
                  <line x1={x0} y1={y0} x2={c1[0]} y2={c1[1]} stroke="#8a92a6" strokeWidth={1} />
                  <line x1={x1} y1={y1} x2={c2[0]} y2={c2[1]} stroke="#8a92a6" strokeWidth={1} />
                  <circle cx={c1[0]} cy={c1[1]} r={3.5} fill="#1a1d25" stroke="#c8cfdd" style={{ cursor: 'move' }} onPointerDown={dragHandle('left')} />
                  <circle cx={c2[0]} cy={c2[1]} r={3.5} fill="#1a1d25" stroke="#c8cfdd" style={{ cursor: 'move' }} onPointerDown={dragHandle('right')} />
                </g>
              );
            })}
            {t.keyframes.map((k) => (
              <rect key={k.id} x={x(k.time) - 4} y={y(Number(k.value)) - 4} width={8} height={8}
                transform={`rotate(45 ${x(k.time)} ${y(Number(k.value))})`}
                fill={selectedKeys.includes(k.id) ? '#ffffff' : color} stroke="#0b0c10" style={{ cursor: 'move' }}
                onPointerDown={(e) => onDragKey(e, t, k, 'both', scale)} onContextMenu={(e) => onKeyMenu(e, k)}>
                <title>{`${t.target} · ${k.time.toFixed(2)} s = ${Number(k.value).toFixed(3)}`}</title>
              </rect>
            ))}
            <text x={6} y={10 + ti * 12} fill={color} fontSize={9.5} fontFamily="ui-monospace, monospace">{t.target}</text>
          </g>
        );
      })}
    </g>
  );
}

function useWidth(ref: React.RefObject<HTMLDivElement | null>): number {
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}
