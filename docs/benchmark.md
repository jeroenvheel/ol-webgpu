# Benchmark

`npm run bench -- --layers=ol,webgl2,webgpu` (examples/bench.html in
Playwright Chromium, AMD Radeon R9 200, D3D11, 1100×900 map, all features in
view, one layer). Milliseconds, lower is better. A frame is `renderSync()`
plus a 1-pixel readback of the canvas, so it includes the GPU work. The
numbers are those of 0.1.0-beta.14, the median of three runs (ol's layer:
two).

**End to end per layer**

| Data set | | ol WebGLVector | WebGL2 | WebGPU |
|---|---|---|---|---|
| 1M points | ready (add layer → rendercomplete) | 847 | 625 | **594** |
| | frame (pan, no rebuild) | 47.8 | 12.4 | **11.2** |
| | pick (`forEachFeatureAtPixel`) | 0.00 | 0.09 | 0.08 |
| 200k lines | ready | 1717 | **563** | 570 |
| | frame | 359.8 | 15.1 | **14.4** |
| | pick | 0.01 | 0.03 | 0.04 |
| 100k polygons | ready | 1826 | **454** | 473 |
| | frame | 237.9 | 11.6 | **11.3** |
| | pick | 0.01 | 0.03 | 0.05 |

**Per release**

![Time to first render per release: 1M points, 200k lines and 100k polygons on WebGL2 and WebGPU, with ol's WebGLVector layer as a reference](../bench/first-render.svg)

Every release was built again and measured on the same machine on one day
([bench/history-2026-11-26.md](../bench/history-2026-11-26.md), numbers in
`bench/history.json`, chart by `node bench/chart.js`). Time to first render,
median of three runs:

| Release | Points WebGL2 | Points WebGPU | Lines WebGL2 | Lines WebGPU | Polygons WebGL2 | Polygons WebGPU | What changed for speed |
|---|---|---|---|---|---|---|---|
| beta.0 | 901 | 1162 | 833 | 901 | 731 | 755 | |
| beta.5 | 877 | 1093 | 838 | 870 | 733 | 767 | |
| beta.6 | 670 | 893 | 784 | 824 | 672 | 700 | the layer's refs instead of ol's uid map; attributes kept per feature |
| beta.10 | 653 | 909 | 776 | 838 | 670 | 699 | |
| beta.11 | 609 | 708 | 555 | 578 | 436 | 440 | the first frame does not wait for the hit index; the layer's own batch of features |
| beta.12 | 593 | 601 | 551 | 571 | 440 | 456 | shaders compiled and the device requested ahead |
| beta.13 | 587 | 603 | 552 | 560 | 434 | 452 | |
| beta.14 | 625 | 594 | 563 | 570 | 454 | 473 | 10–38 ms later, for a page that keeps moving: the features go into the layer in slices |
| beta.0 → beta.14 | −31% | −49% | −32% | −37% | −38% | −37% | |

Frame times did not change over the releases (11–13 ms for points and
polygons, 14–16 ms for lines, on both backends), nor did a pick.

**Memory per release**

![Memory of a big layer per release: the heap that 300 000 points, 200 000 lines and 50 000 polygons take on top of the features, as ol/Feature and as RenderFeatures, on WebGL2 and WebGPU, with ol's WebGLVector layer as a reference](../bench/memory.svg)

The JavaScript heap that a layer of 300 000 points, 200 000 lines and 50 000
polygons adds to its features, in MB: once with the features as `ol/Feature`
(609 MB themselves) and once as RenderFeatures (`ol/render/Feature`, 174 MB
themselves, what vector tile formats read and what a GeoJSON format can
make). Every release was built again and measured on the same machine, one
run each; the heap differs by 0.1 MB between runs.

| Release | WebGL2, ol/Feature | WebGPU, ol/Feature | WebGL2, RenderFeatures | WebGPU, RenderFeatures | What changed for memory |
|---|---|---|---|---|---|
| beta.0 | 528 | 528 | 417 | 417 |  |
| beta.1 | 528 | 528 | 417 | 417 |  |
| beta.2 | 528 | 528 | 417 | 417 |  |
| beta.3 | 528 | 528 | 417 | 417 |  |
| beta.4 | 528 | 528 | 417 | 417 |  |
| beta.5 | 528 | 363 | 417 | 252 | WebGPU keeps no copy of its buffers |
| beta.6 | 518 | 354 | 407 | 243 | the refs of the features without ol's map of uids |
| beta.7 | 518 | 354 | 407 | 243 |  |
| beta.8 | 518 | 354 | 407 | 243 |  |
| beta.9 | 518 | 354 | 407 | 243 |  |
| beta.10 | 518 | 354 | 407 | 243 |  |
| beta.11 | 398 | 233 | 280 | 116 | the layer's own batch of features instead of ol's |
| beta.12 | 398 | 233 | 280 | 116 |  |
| beta.13 | 398 | 233 | 280 | 116 |  |
| beta.14 | 235 | 235 | 117 | 118 | WebGL2 keeps no copy of buffers over 32 MB |
| ol/layer/WebGLVector | 541 | | 430 | | |

- From beta.0 to beta.14 the layer takes 55% less with `ol/Feature` and 72%
  less with RenderFeatures, on both backends: less than half, and close to a
  quarter, of what ol's own layer takes.
- Part of every number is ol's vector source, the same in every release:
  175 MB with `ol/Feature` (it listens to each of them) and 57 MB with
  RenderFeatures. Without it the layer went from about 355 MB to 60 MB with
  either kind.
- With RenderFeatures the features and the layer together are 292 MB where
  they are 844 MB with `ol/Feature`: for layers that are only shown and
  picked, that is the largest saving there is.
- `keepBuffers: true` on WebGL2 brings back the copy of the buffers that
  beta.14 leaves out for large layers: 398 and 280 MB.

**Buffer generation (worker), ol's JS vs Rust/WASM**

| | ol JS | Rust/WASM |
|---|---|---|
| 200k lines | 1003 | **270** (3.7×) |
| 100k polygons (earcut) | 526 | **51** (10×) |
| hit index build, 1M points / 200k lines / 100k polygons | – | 167 / 56 / 29 |

What this shows:

- **Frames** are 20–24× faster than ol's layer for lines and polygons, and
  about 4× for points, with the same shaders and buffers. The gap is in how
  frames are drawn (ol renders into an offscreen framebuffer and copies it,
  among other things); it has not been profiled further.
- **Time to first render** is 3× shorter than ol's for lines, 4× for
  polygons and 1.4× for points. The tessellation is Rust's, the features are
  read into typed arrays of the layer's own instead of ol's
  `MixedGeometryBatch`, and the first frame waits for neither the hit index
  nor, on WebGPU, the shaders.
- **WebGPU and WebGL2 are level** on this GPU since beta.12, for the first
  frame and for the frames after it. On other GPUs they are not: on an Intel
  Iris Xe a frame of a million points takes 87 ms on WebGL2 and 24 ms on
  WebGPU, and on an NVIDIA T550 WebGPU draws lines and polygons faster
  ([bench/beta12-2026-11-26.md](../bench/beta12-2026-11-26.md)).
- **Picking** costs about 0.1 ms or less, like ol's GPU readback, but works
  on WebGPU and is correct in the two cases where ol's is not. The first
  pick after a rebuild is slower (a few ms, up to about 50 ms for 1M
  points) while feature-dependent sizes are still being measured.
- Point buffers are a plain copy, so WASM gains nothing there.
- This benchmark has one layer. On maps with many layers, the shared
  canvases matter more: on a real map with 24 vector layers (660k
  features, Intel Iris Xe, 60 Hz), zooming with the whole map in view ran
  at 16 fps with ol's layers, 18 fps with WebGL2 and 29 fps with WebGPU
  (measured with an early release).

**Labels** (`examples/labels.html`: country names and random place names,
1100×900 map, decluttered, AMD Radeon R9 200, Chromium). A frame is
`renderSync()` while panning:

| Places | | ol Canvas layer | GPU text |
|---|---|---|---|
| 20 000 (5 900 in view) | frame while panning | 20 | **0.9** |
| | label layout after a zoom | (in the frame) | 34, over 3 frames |
| 200 000 (59 000 in view) | frame while panning | 168 | **4.8** |
| | label layout after a zoom | (in the frame) | 280, over 26 frames |
| | worst frame while panning | 330 | 15 |

The Canvas layer lays out and declutters all labels in every frame; GPU
text measures them once per layout, gives glyphs to the 1 700 to 2 300 that
can win a place, and declutters those per frame (0.4 ms). A layout is made
in steps of at most 10 ms a frame (4 ms while the view moves): collecting
the features of the area, measuring them, choosing the labels that can win a
place, and laying those out. Up to 0.1.0-beta.12 the first and the third of
those were done in one go each, and the worst frame was 121 ms.

[Back to the README](../README.md)
