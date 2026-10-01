<!--
Destination: message to @ibgreen, on the OpenJS Slack or as a comment on https://github.com/visgl/luma.gl/issues/2550 (v10 tracker)
Status: draft, not posted
-->

I have a stack of luma PRs open and want to make review easy. Here is the order I'd suggest, by
what each unblocks. None depends on another, so any order works mechanically.

1. **#3313 `WebGPUAdapter.attach()`**, so an app's own `GPUDevice` can host luma compute. This
   removes the `new WebGPUDevice(props, device, adapter, info)` workaround.
2. **#3326 GPU Dataframe fusion over contiguous batches** (11,722 → 8 dispatches at 4M rows), with
   its split-out fixes #3330, #3331, #3332 and #3338, which are small and reviewable alone.
3. **#3337 `packBatches` on Arrow analytics upload**, the upload-side half of the same problem.
4. **#3328 `Model` drawIndirect**, the render-side half: draw a GPU-compacted subset without
   readback.
5. **#3302 pipeline cache**, then the conformance and parity set (#3287, #3333, #3334) and the
   shadertools pair (#3286, #3288). #3333 is currently over the bundle-size budget; I'll fix that
   before asking for another look.

If a different order suits you, or you'd rather some of these land as one PR, tell me and I'll
restack.
