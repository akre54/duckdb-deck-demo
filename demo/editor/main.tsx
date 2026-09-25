/**
 * The node editor: a Noodles-style graph whose operators compile, through the planner, to
 * DuckDB SQL and generated JS, drawn by deck.gl over MapLibre.
 */

import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './editor.css';
import type { EditorDoc } from '@noodles.gl/planner';
import { createStore } from './store.js';
import { Engine } from './engine.js';
import { App } from './App.js';
import { EXAMPLES, DEFAULT_EXAMPLE } from './examples.js';

const fromHash = new URLSearchParams(location.hash.slice(1)).get('example');
const saved = localStorage.getItem('noodles-editor-doc');
const key = fromHash && EXAMPLES[fromHash] ? fromHash : saved ? undefined : DEFAULT_EXAMPLE;
const doc: EditorDoc = key ? structuredClone(EXAMPLES[key].doc) : JSON.parse(saved!);

const store = createStore(doc);
store.set({ example: key });
const engine = new Engine(store);
// Debug handles, as the inspector exposes `rt`: the store is the quickest way to drive the editor.
Object.assign(window as unknown as Record<string, unknown>, { store });

// Autosave, so a reload keeps the work.
store.subscribe(() => {
  const d = store.get().doc;
  if (d !== lastSaved) {
    lastSaved = d;
    localStorage.setItem('noodles-editor-doc', JSON.stringify(d));
  }
});
let lastSaved: EditorDoc | undefined;

createRoot(document.getElementById('root')!).render(<App engine={engine} />);
void engine.start().catch((err) => {
  console.error(err);
  store.setRuntime({ busy: false, error: String(err), status: 'failed to start' });
});
engine.startClock();
