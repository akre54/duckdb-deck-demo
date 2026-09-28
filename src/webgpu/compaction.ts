/**
 * The runtime's side of `TargetCaps.compaction`: a GPU engine that evaluates a filter and
 * leaves the survivors as a compacted id list and a GPU-resident count.
 *
 * An interface rather than an implementation so this entry keeps no dependency on the engine.
 * `src/luma` provides one over luma.gl's GPU Dataframe (`lumaCompactor`); a runtime built
 * without a factory plans as though compaction does not exist.
 */

import type { Expr } from '@noodles.gl/planner';

export interface CompactorInput {
  device: GPUDevice;
  adapter: GPUAdapter;
  /** The predicate's inputs: one f32 buffer per attribute, at least `rows` long. */
  columns: Record<string, GPUBuffer>;
  rows: number;
  predicate: Expr;
  /** Values for the predicate's parameters at compile time. */
  params: Record<string, number>;
}

/** A compiled compaction, sized to one row count. Rebuilt when the row count changes. */
export interface Compactor {
  /** Evaluate with these parameter values and submit. Queue order puts it before later work. */
  run(params: Record<string, number>): void;
  /** u32 ids of the surviving rows, in row order; the first `count` are valid. */
  readonly indices: GPUBuffer;
  /** One u32: how many rows survived. Never read by the runtime. */
  readonly count: GPUBuffer;
  destroy(): void;
}

export type CompactorFactory = (input: CompactorInput) => Compactor;
