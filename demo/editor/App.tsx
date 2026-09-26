import { useEffect, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import type { EditorDoc } from '@noodles.gl/planner';
import { store, useEditor, type PaneTab } from './store.js';
import type { Engine } from './engine.js';
import { EXAMPLES } from './examples.js';
import { NetworkEditor } from './network/NetworkEditor.js';
import { ParamPane } from './params/ParamPane.js';
import { Spreadsheet } from './panes/Spreadsheet.js';
import { PlanView } from './panes/PlanView.js';
import { Timeline } from './timeline/Timeline.js';
import { Viewport } from './panes/Viewport.js';

export function App({ engine }: { engine: Engine }) {
  const tab = useEditor((s) => s.tab);
  const workRef = useRef<HTMLDivElement>(null);
  const [viewportH, setViewportH] = useState(46);

  useGlobalShortcuts();

  const startSplit = (e: React.PointerEvent) => {
    const host = workRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const move = (ev: PointerEvent) => setViewportH(Math.min(85, Math.max(12, ((ev.clientY - rect.top) / rect.height) * 100)));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); engine.map?.resize(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    e.preventDefault();
  };
  useEffect(() => { engine.map?.resize(); }, [viewportH, engine]);

  return (
    <div className="app">
      <TopBar engine={engine} />
      <div className="work" ref={workRef} style={{ ['--viewport-h' as string]: `${viewportH}%` }}>
        <Viewport engine={engine} />
        <div className="splitter" onPointerDown={startSplit} />
        <div className="lower">
          <LowerTabs tab={tab} />
          <div className="tabbody">
            <ReactFlowProvider>
              <div style={{ position: 'absolute', inset: 0, visibility: tab === 'network' ? 'visible' : 'hidden' }}>
                <NetworkEditor />
              </div>
            </ReactFlowProvider>
            {tab === 'spreadsheet' && <Spreadsheet engine={engine} />}
            {tab === 'plan' && <PlanView />}
          </div>
        </div>
        <Timeline engine={engine} />
      </div>
      <aside className="side">
        <ParamPane engine={engine} />
      </aside>
    </div>
  );
}

function LowerTabs({ tab }: { tab: PaneTab }) {
  const network = useEditor((s) => s.network);
  const doc = useEditor((s) => s.doc);
  const crumbs: { id?: string; name: string }[] = [{ name: '/' }];
  let at = network;
  const chain: { id: string; name: string }[] = [];
  while (at) {
    const n = doc.nodes.find((x) => x.id === at);
    if (!n) break;
    chain.unshift({ id: n.id, name: n.name ?? n.id });
    at = n.parent;
  }
  crumbs.push(...chain);
  const set = (t: PaneTab) => store().set({ tab: t });
  return (
    <div className="tabs" role="tablist">
      {(['network', 'spreadsheet', 'plan'] as PaneTab[]).map((t) => (
        <button key={t} role="tab" aria-selected={tab === t} onClick={() => set(t)}>
          {t === 'network' ? 'Network' : t === 'spreadsheet' ? 'Spreadsheet' : 'Plan'}
        </button>
      ))}
      <div className="crumbs">
        {crumbs.map((c, i) => (
          <span key={c.id ?? 'root'}>
            {i > 1 && '/'}
            <button onClick={() => store().set({ network: c.id, selection: [] })}>{c.name}</button>
          </span>
        ))}
      </div>
      <div className="spacer" />
      {tab === 'network' && (
        <div className="hint">
          <kbd>Tab</kbd> add · <kbd>⇧C</kbd> collapse · <kbd>B</kbd> bypass · <kbd>D</kbd> display · <kbd>⌫</kbd> delete · dbl-click subnet to enter · <kbd>U</kbd> up
        </div>
      )}
    </div>
  );
}

function TopBar({ engine }: { engine: Engine }) {
  const example = useEditor((s) => s.example);
  const runtime = useEditor((s) => s.runtime);
  const doc = useEditor((s) => s.doc);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = (key: string) => {
    const ex = EXAMPLES[key];
    if (!ex) return;
    store().load(structuredClone(ex.doc), key);
    history.replaceState(null, '', `#example=${key}`);
  };
  const save = () => {
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${doc.name.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase() || 'project'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const open = async (file: File) => {
    const parsed = JSON.parse(await file.text()) as EditorDoc;
    if (parsed.version !== 1 || !Array.isArray(parsed.nodes)) throw new Error('Not an editor document');
    store().load(parsed);
  };

  return (
    <header className="topbar">
      <span className="brand">noodles<small>DuckDB → planner → deck.gl</small></span>
      <select value={example ?? ''} onChange={(e) => load(e.target.value)} title="Examples">
        {example === undefined && <option value="">{doc.name} (edited)</option>}
        {Object.entries(EXAMPLES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
      </select>
      <button onClick={() => example && load(example)} disabled={!example} title="Reload the example, discarding edits">Reset</button>
      <button onClick={save}>Save</button>
      <button onClick={() => fileRef.current?.click()}>Open…</button>
      <input ref={fileRef} type="file" accept="application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void open(f).catch((err) => alert(String(err))); e.target.value = ''; }} />
      <a href="../" title="The planner inspector: SQL/WGSL, cost model, candidates">inspector ↗</a>
      <div className="status">
        {runtime.busy && <span className="spinner" />}
        {runtime.error ? <span className="err" title={runtime.error}>{runtime.error}</span> : <span>{runtime.status}</span>}
        <button className="btn small" title="Frame the Deck node's camera" onClick={() => engine.applyCamera(true)}>⌖</button>
      </div>
    </header>
  );
}

function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable]')) return;
      const s = store();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) s.redo(); else s.undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        s.redo();
      } else if (e.key === ' ') {
        e.preventDefault();
        s.set((st) => ({ playing: !st.playing }));
      } else if (e.key === 'Home') {
        s.set({ time: 0 });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
