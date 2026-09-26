/**
 * Editor state: the document, what is selected, where the playhead is.
 *
 * A plain store with `useSyncExternalStore` rather than a state library — the editor has one
 * document and a handful of view fields, and the engine (DuckDB, the runtime) lives outside
 * React and subscribes the same way the components do.
 *
 * Undo is by document snapshot. Edits that arrive in a burst — a slider being dragged, a
 * keyframe being moved — coalesce into one step, so undo goes back to where the drag began
 * rather than one pixel.
 */

import { useSyncExternalStore } from 'react';
import type { EditorDoc } from '@noodles.gl/planner';
import type { Lowered, ProgramPlan } from '@noodles.gl/planner';
import type { UpdateReport, RuntimeCounters, LayerState } from '../../src/program/index.js';
import type { CatalogCounters } from '../../src/program/catalog.js';

export type PaneTab = 'network' | 'spreadsheet' | 'plan';

export interface RuntimeView {
  status: string;
  busy: boolean;
  error?: string;
  lowered?: Lowered;
  program?: ProgramPlan;
  layers: LayerState[];
  report?: UpdateReport;
  counters?: RuntimeCounters;
  catalog?: CatalogCounters;
  /** Bumped on every runtime update, so views that read the runtime can refetch. */
  version: number;
  /** Slot values at the current time, for parameter fields showing evaluated expressions. */
  slots: Map<string, unknown>;
  slotErrors: Map<string, string>;
}

export interface EditorState {
  doc: EditorDoc;
  /** The example key, if the document came from one. */
  example?: string;
  selection: string[];
  /** The subnet being viewed; undefined is the root network. */
  network?: string;
  time: number;
  playing: boolean;
  loop: boolean;
  tab: PaneTab;
  selectedKeys: string[];
  /** `nodeId.param` copied for "paste reference". */
  copiedParam?: string;
  /** Incremented by every `load`, so the engine frames a new document's camera once. */
  loadId: number;
  runtime: RuntimeView;
}

type Listener = () => void;

const COALESCE_MS = 500;

export class Store {
  private state: EditorState;
  private readonly listeners = new Set<Listener>();
  private undoStack: EditorDoc[] = [];
  private redoStack: EditorDoc[] = [];
  private lastEdit = 0;
  private lastTag?: string;

  constructor(doc: EditorDoc) {
    this.state = {
      doc, selection: [], time: 0, playing: false, loop: true, tab: 'network', selectedKeys: [], loadId: 0,
      runtime: { status: 'starting…', busy: true, layers: [], version: 0, slots: new Map(), slotErrors: new Map() },
    };
  }

  get = (): EditorState => this.state;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  set(patch: Partial<EditorState> | ((s: EditorState) => Partial<EditorState>)): void {
    const next = typeof patch === 'function' ? patch(this.state) : patch;
    this.state = { ...this.state, ...next };
    for (const l of this.listeners) l();
  }

  setRuntime(patch: Partial<RuntimeView>): void {
    this.set((s) => ({ runtime: { ...s.runtime, ...patch } }));
  }

  /**
   * Change the document. `tag` names the gesture: consecutive edits with the same tag inside
   * the coalescing window are one undo step.
   */
  edit(fn: (doc: EditorDoc) => EditorDoc | void, tag?: string): void {
    const now = performance.now();
    const coalesce = tag !== undefined && tag === this.lastTag && now - this.lastEdit < COALESCE_MS;
    if (!coalesce) {
      this.undoStack.push(this.state.doc);
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
    }
    this.lastEdit = now;
    this.lastTag = tag;
    const draft = structuredClone(this.state.doc);
    const result = fn(draft) ?? draft;
    this.set({ doc: result });
  }

  /** Replace the document outright, e.g. loading an example. Clears history. */
  load(doc: EditorDoc, example?: string): void {
    this.undoStack = [];
    this.redoStack = [];
    this.lastTag = undefined;
    this.set((st) => ({ doc, example, selection: [], network: undefined, time: 0, playing: false, selectedKeys: [], loadId: st.loadId + 1 }));
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.state.doc);
    this.lastTag = undefined;
    this.set({ doc: prev });
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.state.doc);
    this.lastTag = undefined;
    this.set({ doc: next });
  }
}

let current: Store | undefined;

export function createStore(doc: EditorDoc): Store {
  current = new Store(doc);
  return current;
}

export function store(): Store {
  if (!current) throw new Error('store not created');
  return current;
}

/** Subscribe a component to a slice of state. */
export function useEditor<T>(select: (s: EditorState) => T): T {
  const s = store();
  return useSyncExternalStore(s.subscribe, () => select(s.get()));
}
