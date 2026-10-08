/**
 * luma.gl's GPU Dataframe as a filter backend: our expression IR in, compacted row ids out.
 *
 * luma 9.4.2 ships `@luma.gl/experimental/gpu-dataframe`, a WebGPU executor that compiles a
 * predicate into a command graph producing three GPU-resident outputs: a 0/1 selection mask,
 * the *compacted* ids of the selected rows, and a per-batch selected count. The last two are
 * what our own GPU path lacks — a kernel-evaluated filter here can only write a discard mask,
 * so a rejected row still costs an instance slot every frame (FINDINGS §4). luma's ids plus a
 * GPU-resident count feed `drawIndirect` directly, so row reduction happens on the GPU with no
 * readback and no requery.
 *
 * What it cannot do is most of what our kernels do. Its expression language is closed:
 * `+ - * /`, comparisons, `and`/`or`/`not`, null tests. No `%`, no function calls, no vectors,
 * no conditionals. So this is not a replacement GPU backend; it is a filter engine, and
 * `toLumaExpr` answering `null` is the capability test, in the same spirit as `enginesFor`.
 *
 * It runs over buffers we already own. A luma `Buffer` accepts an existing `GPUBuffer` as its
 * `handle`, and `WebGPUDevice` accepts an existing `GPUDevice`, so luma reads our attribute
 * buffers in place — no second upload, no second device, and none of the default-limits
 * problem FINDINGS §5a hit when luma created the device itself.
 */

import { Buffer as LumaBuffer, type CommandEncoder } from '@luma.gl/core';
import { WebGPUDevice } from '@luma.gl/webgpu';
import { GPUCommandGraph } from '@luma.gl/gpgpu/gpu-core';
import { GPUData } from '@luma.gl/gpgpu/gpu-data';
import { GPURecordBatch, GPUTable } from '@luma.gl/experimental/gpu-tables';
import {
  GPUDataFrame, column, literal, parameter, and, or, not,
  type GPUExpression, type CompiledGPUDataFrameQuery, type GPUDataFrameQueryParameters,
} from '@luma.gl/experimental/gpu-dataframe';
import type { Expr } from '@noodles.gl/planner';
import type { CompactorFactory } from '../webgpu/compaction.js';

type Numeric = GPUExpression<number | null, string>;
type Bool = GPUExpression<boolean, string>;
type Lowered = { kind: 'num'; e: Numeric } | { kind: 'bool'; e: Bool };


/**
 * Lower a predicate from our IR into a luma expression, or `null` when luma cannot express it.
 *
 * Parameters stay parameters, so a threshold change is an encode-time value rather than a
 * recompile — the same contract as our uniform path. `defaults` supplies the value luma
 * requires at plan time.
 */
export function toLumaExpr(e: Expr, defaults: Record<string, number> = {}): Bool | null {
  const out = lower(e, defaults);
  return out?.kind === 'bool' ? out.e : null;
}

function lower(e: Expr, defaults: Record<string, number>): Lowered | null {
  switch (e.kind) {
    case 'num':
      return { kind: 'num', e: literal(e.value) as Numeric };
    case 'col':
      return { kind: 'num', e: column(e.name) };
    case 'param':
      return { kind: 'num', e: parameter(e.name, defaults[e.name] ?? 0) as Numeric };
    case 'unary': {
      const operand = lower(e.operand, defaults);
      if (!operand) return null;
      if (e.op === '-' && operand.kind === 'num') return { kind: 'num', e: operand.e.negate() };
      if (e.op === '!' && operand.kind === 'bool') return { kind: 'bool', e: not(operand.e) };
      return null;
    }
    case 'binary': {
      const left = lower(e.left, defaults);
      const right = lower(e.right, defaults);
      if (!left || !right) return null;
      if (e.op === '&&' || e.op === '||') {
        if (left.kind !== 'bool' || right.kind !== 'bool') return null;
        return { kind: 'bool', e: e.op === '&&' ? and(left.e, right.e) : or(left.e, right.e) };
      }
      if (left.kind !== 'num' || right.kind !== 'num') return null;
      const [l, r] = [left.e, right.e];
      switch (e.op) {
        case '+': return { kind: 'num', e: l.add(r) };
        case '-': return { kind: 'num', e: l.subtract(r) };
        case '*': return { kind: 'num', e: l.multiply(r) };
        case '/': return { kind: 'num', e: l.divide(r) };
        case '>': return { kind: 'bool', e: l.greaterThan(r) };
        case '>=': return { kind: 'bool', e: l.greaterThanOrEqual(r) };
        case '<': return { kind: 'bool', e: l.lessThan(r) };
        case '<=': return { kind: 'bool', e: l.lessThanOrEqual(r) };
        case '==': return { kind: 'bool', e: l.equal(r) };
        case '!=': return { kind: 'bool', e: l.notEqual(r) };
        // `%` has no luma operator.
        default: return null;
      }
    }
    // Function calls, strings, vectors, swizzles and conditionals have no luma form.
    default:
      return null;
  }
}

/**
 * How the source rows are presented to luma.
 *
 * `packed` is one record batch over the whole buffer. `batched` slices the same buffer into
 * fixed-size record batches — DuckDB-Wasm's 2048-row chunks are the realistic case — without
 * copying anything, which isolates what batch topology costs luma from what memory costs.
 * The compacted ids are per batch, so only `packed` yields one id list a single
 * `drawIndirect` can consume.
 */
export type LumaTopology = { kind: 'packed' } | { kind: 'batched'; rows: number };

export interface LumaFilterProps {
  device: GPUDevice;
  /** Needed by luma's device wrapper for adapter info; any adapter of this device will do. */
  adapter: GPUAdapter;
  /** One f32 column per name, `rows` long, already on the GPU. */
  columns: Record<string, GPUBuffer>;
  rows: number;
  predicate: Expr;
  params?: Record<string, number>;
  topology?: LumaTopology;
}

/**
 * A compiled luma filter over existing buffers. Re-encode with new parameter values; the
 * graph, pipelines and output buffers are built once.
 */
export class LumaFilter {
  readonly luma: WebGPUDevice;
  readonly batches: number;
  private readonly frame: GPUDataFrame;
  private readonly query: CompiledGPUDataFrameQuery;
  private readonly wrapped: LumaBuffer[] = [];

  constructor(props: LumaFilterProps) {
    const { device, adapter, columns, rows, predicate, params = {}, topology = { kind: 'packed' } } = props;
    const expr = toLumaExpr(predicate, params);
    if (!expr) throw new Error('predicate has no luma GPU Dataframe form');

    this.luma = lumaDeviceFor(device, adapter);
    const step = topology.kind === 'packed' ? Math.max(1, rows) : topology.rows;
    const formatted = Object.fromEntries(Object.entries(columns).map(([name, buffer]) => [name, { buffer, format: 'float32' as const }]));
    const recordBatches = borrowColumns(this.luma, formatted, rows, step, this.wrapped);
    this.batches = recordBatches.length;

    this.frame = new GPUDataFrame({ table: new GPUTable({ batches: recordBatches }), ownership: 'borrowed' });
    const graph = new GPUCommandGraph<GPUDataFrameQueryParameters>(this.luma, { id: 'noodles-luma-filter' });
    this.query = this.frame.filter(expr).compile(graph);
  }

  /**
   * Record the filter into a fresh luma encoder and submit it. luma's `encode` takes its own
   * `CommandEncoder`, not a `GPUCommandEncoder`, so this is a separate submission; queue order
   * still puts it ahead of any render pass submitted afterwards.
   */
  run(params: Record<string, number> = {}): void {
    const encoder: CommandEncoder = this.luma.createCommandEncoder({ id: 'noodles-luma-filter' });
    this.query.encode(encoder, params);
    this.luma.submit(encoder.finish() as Parameters<WebGPUDevice['submit']>[0]);
  }

  /** Compacted selected-row ids for batch `i` (u32, source-row numbering). */
  rowIndices(batch = 0): GPUBuffer {
    return bufferOf(this.query.rowIndices.data[batch]);
  }

  /** One u32: how many rows batch `i` selected. Stays on the GPU. */
  selectedCount(batch = 0): GPUBuffer {
    return bufferOf(this.query.selectedCounts.data[batch]);
  }

  /** 0/1 u32 per source row, for comparison with our own discard mask. */
  selectionMask(batch = 0): GPUBuffer {
    return bufferOf(this.query.selectionMask.data[batch]);
  }

  /**
   * Copy the selected count into the `instanceCount` slot of a `drawIndirect` argument buffer,
   * so the draw that follows sizes itself without the CPU ever learning the count.
   */
  writeIndirectCount(encoder: GPUCommandEncoder, indirect: GPUBuffer, batch = 0): void {
    encoder.copyBufferToBuffer(this.selectedCount(batch), 0, indirect, 4, 4);
  }

  destroy(): void {
    this.query.destroy();
    this.frame.destroy();
    // The wrappers borrow our buffers; luma's destroy would destroy the handle, so drop them
    // without calling it.
    this.wrapped.length = 0;
  }
}

/** One aggregate over the filtered rows, per group: luma's dense count/sum/min/max/mean. */
export type LumaAggregate = 'count' | { sum: string } | { min: string } | { max: string } | { mean: string };

export interface LumaGroupByProps {
  device: GPUDevice;
  adapter: GPUAdapter;
  /**
   * The group key: u32, dense in `[0, groupCount)`. luma's group-by only takes dense keys, so
   * it never has to size an output on the CPU; DuckDB makes a key dense at load time
   * (`floor(...)` for a bin, `dense_rank()` for a sparse id).
   */
  key: { name: string; buffer: GPUBuffer };
  groupCount: number;
  /** f32 columns the predicate and the aggregates read, `rows` long, already on the GPU. */
  columns: Record<string, GPUBuffer>;
  rows: number;
  aggregates: Record<string, LumaAggregate>;
  /** Optional filter ahead of the grouping, in our IR; must be `compactable`. */
  predicate?: Expr;
  params?: Record<string, number>;
}

/**
 * A compiled luma dense group-by over existing buffers: `WHERE predicate GROUP BY key`.
 *
 * Every output is `groupCount` long and stays on the GPU. A parameter change re-encodes the
 * same graph — no recompile, no allocation, no readback — which is what makes a linked
 * histogram's brush a uniform write rather than a requery.
 */
export class LumaGroupBy {
  readonly luma: WebGPUDevice;
  readonly groupCount: number;
  private readonly frame: GPUDataFrame;
  private readonly query: CompiledGPUDataFrameQuery;
  private readonly wrapped: LumaBuffer[] = [];

  constructor(props: LumaGroupByProps) {
    const { device, adapter, key, groupCount, columns, rows, aggregates, predicate, params = {} } = props;
    const expr = predicate ? toLumaExpr(predicate, params) : null;
    if (predicate && !expr) throw new Error('predicate has no luma GPU Dataframe form');

    this.luma = lumaDeviceFor(device, adapter);
    this.groupCount = groupCount;
    const formatted: Record<string, ColumnRef> = { [key.name]: { buffer: key.buffer, format: 'uint32' } };
    for (const [name, buffer] of Object.entries(columns)) formatted[name] = { buffer, format: 'float32' };
    const batches = borrowColumns(this.luma, formatted, rows, Math.max(1, rows), this.wrapped);

    this.frame = new GPUDataFrame({ table: new GPUTable({ batches }), ownership: 'borrowed' });
    const graph = new GPUCommandGraph<GPUDataFrameQueryParameters>(this.luma, { id: 'noodles-luma-group-by' });
    // Column names are runtime strings here, so luma's schema-typed builders see `never`. LuSQL
    // crosses the same boundary the same way.
    const base = (expr ? this.frame.filter(expr) : this.frame) as unknown as {
      groupBy(key: string, options: { groupCount: number }): {
        aggregate(definitions: Record<string, LumaAggregate>): { compile(g: typeof graph): CompiledGPUDataFrameQuery };
      };
    };
    this.query = base.groupBy(key.name, { groupCount }).aggregate(aggregates).compile(graph);
  }

  /** Re-run the graph with new parameter values; a separate submission, like `LumaFilter.run`. */
  run(params: Record<string, number> = {}): void {
    const encoder: CommandEncoder = this.luma.createCommandEncoder({ id: 'noodles-luma-group-by' });
    this.query.encode(encoder, params);
    this.luma.submit(encoder.finish() as Parameters<WebGPUDevice['submit']>[0]);
  }

  /** One aggregate's `groupCount` values: u32 for `count`, f32 otherwise. */
  output(name: string): GPUBuffer {
    const data = this.query.table.batches[0].gpuData[name];
    if (!data) throw new Error(`no group-by output "${name}"`);
    return bufferOf(data);
  }

  destroy(): void {
    this.query.destroy();
    this.frame.destroy();
    this.wrapped.length = 0;
  }
}

type ColumnRef = { buffer: GPUBuffer; format: 'float32' | 'uint32' };

/**
 * Present our buffers to luma as record batches of `step` rows, borrowed rather than copied.
 * The luma wrappers are pushed onto `wrapped` so the owner can drop them without destroying
 * the handles.
 */
function borrowColumns(
  luma: WebGPUDevice, columns: Record<string, ColumnRef>, rows: number, step: number, wrapped: LumaBuffer[],
): GPURecordBatch[] {
  const buffers: Record<string, { buffer: LumaBuffer; format: ColumnRef['format'] }> = {};
  for (const [name, { buffer: handle, format }] of Object.entries(columns)) {
    const buffer = luma.createBuffer({
      id: `luma:${name}`,
      handle,
      byteLength: handle.size,
      usage: LumaBuffer.STORAGE | LumaBuffer.COPY_SRC | LumaBuffer.COPY_DST,
    });
    wrapped.push(buffer);
    buffers[name] = { buffer, format };
  }

  const batches: GPURecordBatch[] = [];
  for (let offset = 0, index = 0; offset < rows; offset += step, index++) {
    const length = Math.min(step, rows - offset);
    const gpuData: Record<string, GPUData> = {};
    for (const [name, { buffer, format }] of Object.entries(buffers)) {
      // A view at a byte offset, not a copy. Storage bindings need 256-byte-aligned offsets,
      // which 2048 four-byte rows (8 KiB) satisfy.
      gpuData[name] = new GPUData({ buffer, format, length, byteOffset: offset * 4, ownsBuffer: false });
    }
    batches.push(new GPURecordBatch({
      gpuData,
      fields: Object.entries(buffers).map(([name, { format }]) => ({ name, format, nullable: false })),
      sourceInfo: { sourceBatchIndex: index, sourceRowIndexOffset: offset, sourceRowCount: length },
    }));
  }
  return batches;
}

/**
 * One luma wrapper per `GPUDevice`. The wrapper installs an `uncapturederror` listener and
 * owns a command encoder, so building one per filter — a runtime recompiles after every
 * requery — would pile both up on the device.
 */
const wrappers = new WeakMap<GPUDevice, WebGPUDevice>();

function lumaDeviceFor(device: GPUDevice, adapter: GPUAdapter): WebGPUDevice {
  let luma = wrappers.get(device);
  if (!luma) {
    // TODO(luma#3313): `WebGPUAdapter.attach()` is merged (v10.0.0-alpha.3, not in 9.4). Replace
    // this constructor call with `attach()` once we can pin a release that has it.
    // No `createCanvasContext`: this wrapper exists for compute, and the canvas stays ours.
    luma = new WebGPUDevice({}, device, adapter, adapter.info);
    wrappers.set(device, luma);
  }
  return luma;
}

/**
 * The runtime's compaction engine: `new Runtime(gpu, sql, { compactor: lumaCompactor })`
 * lets the planner remove rows on the GPU (`TargetCaps.compaction`).
 */
export const lumaCompactor: CompactorFactory = (input) => {
  const filter = new LumaFilter({ ...input, topology: { kind: 'packed' } });
  return {
    run: (params) => filter.run(params),
    indices: filter.rowIndices(),
    count: filter.selectedCount(),
    destroy: () => filter.destroy(),
  };
};

function bufferOf(data: GPUData): GPUBuffer {
  const buffer = data.buffer instanceof LumaBuffer ? data.buffer : data.buffer.buffer;
  return (buffer as unknown as { handle: GPUBuffer }).handle;
}
