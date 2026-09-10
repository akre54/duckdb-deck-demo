/**
 * `@webgpu/types` predates TypeScript 5.7's generic typed arrays. It declares
 * `writeBuffer` as taking `ArrayBufferView<ArrayBuffer>`, while every view we hold is
 * `ArrayBufferView<ArrayBufferLike>` — which is correct, because duckdb-wasm's COI
 * bundle can legitimately hand back SharedArrayBuffer-backed memory, and WebGPU's
 * `GPUAllowSharedBufferSource` exists precisely to accept it.
 *
 * So the cast bridges a stale type definition, not a real narrowing. Isolated here
 * rather than sprinkled at call sites so it stays one deletable thing.
 */
export function gpuData(view: ArrayBufferView): GPUAllowSharedBufferSource {
  return view as unknown as GPUAllowSharedBufferSource;
}
