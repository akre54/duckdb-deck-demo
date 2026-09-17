/**
 * The wrangle editor: type a line of VEX, see which engine it landed on.
 *
 * This is the pane that makes "programmable pipeline" checkable rather than asserted. Each
 * statement in the body becomes one attribute node, is placed independently, and the badges
 * report where each one went — so you can watch a statement move from GPU to SQL by changing
 * nothing but the expression, and watch four statements collapse into one dispatch.
 *
 * Planning is headless and takes single-digit milliseconds, so the badges update on a short
 * debounce as you type. Actually *rebuilding* (requery, re-upload, recompile) is left to an
 * explicit apply, because it is the expensive half and because a half-typed expression should
 * not blank the canvas.
 */

import type { Runtime } from '../../src/webgpu/runtime.js';
import {
  analyze, optimize, plan as planGraph, stageOf, parseWrangle, WrangleError,
  type Graph, type WrangleNode, type Policy,
} from '@noodles.gl/planner';
import { escapeHtml } from './inspector.js';

const DEBOUNCE_MS = 180;

export interface EditorHooks {
  /** The graph currently loaded, which the editor mutates a copy of. */
  graph: () => Graph;
  runtime: () => Runtime;
  policy: () => Policy;
  /** Apply an edited body: replaces the wrangle node's body and triggers a rebuild. */
  apply: (body: string) => void;
}

export class WrangleEditor {
  private area: HTMLTextAreaElement;
  private status: HTMLElement;
  private badges: HTMLElement;
  private timer: number | undefined;

  constructor(private readonly host: HTMLElement, private readonly hooks: EditorHooks) {
    host.innerHTML = `
      <div class="editor-head">
        <span class="hint">Each statement is placed independently. <code>fn name(a) = expr;</code>
        declares a function; <code>var</code> declares a local that costs no buffer.</span>
        <button class="editor-apply" type="button">apply &amp; rebuild</button>
      </div>
      <div class="editor-split">
        <textarea class="editor-body" spellcheck="false" rows="14"></textarea>
        <div class="editor-badges"></div>
      </div>
      <div class="editor-status hint"></div>
    `;
    this.area = host.querySelector('textarea')!;
    this.status = host.querySelector('.editor-status')!;
    this.badges = host.querySelector('.editor-badges')!;

    this.area.addEventListener('input', () => {
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.preview(), DEBOUNCE_MS);
    });
    host.querySelector('.editor-apply')!.addEventListener('click', () => {
      this.hooks.apply(this.area.value);
    });
    // Tab should indent, not leave the field: this is a code editor, however small.
    this.area.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const { selectionStart: a, selectionEnd: b, value } = this.area;
        this.area.value = `${value.slice(0, a)}  ${value.slice(b)}`;
        this.area.selectionStart = this.area.selectionEnd = a + 2;
        this.preview();
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.hooks.apply(this.area.value);
      }
    });
  }

  /** Load the wrangle node's body from the current graph, or explain that there isn't one. */
  sync(): void {
    const node = wrangleOf(this.hooks.graph());
    if (!node) {
      this.host.setAttribute('data-empty', '');
      this.status.textContent =
        'This graph has no wrangle node. Switch to the "wrangle" graph to edit one.';
      this.area.value = '';
      this.area.disabled = true;
      this.badges.innerHTML = '';
      return;
    }
    this.host.removeAttribute('data-empty');
    this.area.disabled = false;
    if (this.area.value.trim() === '' || normalize(this.area.value) !== normalize(node.body)) {
      this.area.value = dedent(node.body);
    }
    this.preview();
  }

  /**
   * Replan the edited body without touching the GPU.
   *
   * `plan()` is pure and headless, so this can run on every keystroke. A parse error is shown
   * against its line and nothing else changes — the previous plan stays on screen, which is
   * what you want while an expression is half-written.
   */
  private preview(): void {
    const rt = this.hooks.runtime();
    const base = this.hooks.graph();
    const node = wrangleOf(base);
    if (!node) return;

    const body = this.area.value;
    const t0 = performance.now();
    try {
      // Statement list first: it gives per-line kinds even when the full plan fails.
      const statements = parseWrangle(body);

      const candidate: Graph = structuredClone(base);
      const target = wrangleOf(candidate)!;
      target.body = body;

      const analysis = analyze(candidate, rt.sourceSchema);
      const result = optimize(analysis, {
        costs: rt.costs,
        caps: rt.target,
        stats: rt.sourceStats,
        params: rt.params(),
        policy: this.hooks.policy(),
      });
      const physical = planGraph(candidate, rt.sourceSchema, {
        policy: this.hooks.policy(),
        costs: rt.costs,
        caps: rt.target,
        stats: rt.sourceStats,
        params: rt.params(),
        relation: rt.relation,
      });
      const ms = performance.now() - t0;

      // Statement -> the node id desugaring gave it, so its stage can be looked up.
      const stageByName = new Map<string, string>();
      analysis.order.forEach((n, i) => {
        if (n.name) stageByName.set(n.name, stageOf(result.chosen, i));
      });

      const rows: string[] = [];
      for (const s of statements) {
        if (s.kind === 'function') {
          rows.push(badge(s.line, `fn ${s.name}()`, 'inlined', 'scalar'));
          continue;
        }
        const emittedName = s.kind === 'local' ? localised(node.id, s.name) : s.name;
        const stage = stageByName.get(emittedName);
        const registerOnly = s.kind === 'local'
          && !physical.attributes.some((a) => a.name === emittedName);
        rows.push(badge(
          s.line,
          s.kind === 'local' ? `var ${s.name}` : `@${s.name}`,
          registerOnly ? `${stage ?? '—'} · register` : stage ?? 'dropped',
          stage ?? 'scalar',
        ));
      }
      this.badges.innerHTML = rows.join('');
      this.status.innerHTML =
        `replanned in ${ms.toFixed(1)} ms · ${physical.kernels.length} dispatch(es) · `
        + `${physical.attributes.filter((a) => !a.internal).length} attributes`
        + ` <span class="hint">⌘/Ctrl+Enter to apply</span>`;
      this.status.removeAttribute('data-error');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.status.textContent = err instanceof WrangleError
        ? message
        : `plan failed: ${message}`;
      this.status.setAttribute('data-error', '');
    }
  }
}

function badge(line: number, name: string, stage: string, cls: string): string {
  return `<div class="editor-badge"><span class="ln">${line}</span>`
    + `<code>${escapeHtml(name)}</code>`
    + `<span class="tag ${cls}">${escapeHtml(stage)}</span></div>`;
}

function wrangleOf(graph: Graph): WrangleNode | undefined {
  return graph.nodes.find((n): n is WrangleNode => n.type === 'wrangle');
}

/** Mirrors `localName` in the planner: a local becomes `__<nodeId>_<name>`. */
function localised(nodeId: string, name: string): string {
  return `__${nodeId.replace(/[^A-Za-z0-9_]/g, '_')}_${name}`;
}

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Strip the common leading indentation, so a body embedded in JSON reads as written. */
function dedent(body: string): string {
  const lines = body.replace(/^\n/, '').replace(/\s+$/, '').split('\n');
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(cut)).join('\n');
}
