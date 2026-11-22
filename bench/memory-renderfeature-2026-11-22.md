# Memory with RenderFeatures (2026-11-22)

What a layer costs when its source holds RenderFeatures (`ol/render/Feature`,
what vector tile formats such as `ol/format/MVT` read) instead of
`ol/Feature`s, and whether anything leaks. Measured on `main` after
0.1.0-beta.5, Intel Iris Xe (D3D11; WebGPU: intel gen-12lp), Playwright
Chromium. This is another machine than the one of
[memory-2026-11-21.md](memory-2026-11-21.md), so the process numbers of the
two reports cannot be compared.

## Method

`test/rendering/renderFeatures.ts` turns each `ol/Feature` into the
RenderFeature `ol/format/MVT` would make of the same shape: Multi* only for
points and lines, and a polygon, also one with several outer rings, as one
`'Polygon'` with all its rings in one list, outer rings counter-clockwise and
holes clockwise.

- `npm run test:memory` runs each leak check scenario of
  `test/rendering/memory.ts` with both kinds of feature
  (`--features=feature,render`, the default).
- `npm run test:memory -- --big` measures one big layer step by step with
  both kinds: 300k points, 200k lines, 50k polygons, the data of the earlier
  report. Memory is read after a garbage collection.

## Leak checks

All scenarios pass with RenderFeatures on both backends, 12 cycles each after
3 to warm up. The heap growth per cycle is the same as with `ol/Feature`
(0–6 KB; about 35 KB for making and disposing a whole map and about 24 KB for
labels with new texts, both explained in the earlier report). The number of
live buffers, textures, programs, vertex arrays and framebuffers does not
change in any scenario. After disposing everything: 0 features, 0
RenderFeatures, 0 maps, 0 layers, 0 renderers, 0 canvases and 0 buffers.

ol keeps one RenderFeature of its own for as long as the page lives
(`textFeature` in `ol/render/webgl/textUtil.js`). The check now counts
instances against what is alive on the empty page, so that one is not taken
for a leak.

## A big layer

JS heap in MB after each step:

| | WebGL2, Feature | WebGL2, RenderFeature | WebGPU, Feature | WebGPU, RenderFeature |
|---|---|---|---|---|
| empty page | 7 | 7 | 7 | 7 |
| features made | 610 | 175 | 610 | 175 |
| layer drawn | 1137 | 592 | 978 | 427 |
| after 4 rebuilds (pan) | 1138 | 592 | 973 | 427 |
| map disposed | 785 | 226 | 786 | 226 |
| features dropped | 8 | 8 | 8 | 8 |

- **The features** take 175 MB as RenderFeatures against 610 MB as
  `ol/Feature`: 3.5 times less. A RenderFeature is one flat coordinate
  array with its properties; a Feature also has a geometry object, an
  observable with listeners, and its own property object.
- **The layer** adds 417 MB on WebGL2 and 252 MB on WebGPU with
  RenderFeatures, against 528 MB and 371 MB with Features: about 110 MB less
  on both backends. Not looked into; the layer's structure is ol's
  `MixedGeometryBatch` for both kinds.
- **Rebuilds** do not grow the heap with either kind.
- After the map is disposed and the features are dropped, the heap is back
  at 8 MB with both kinds.

Private memory of the renderer process in MB:

| | WebGL2, Feature | WebGL2, RenderFeature | WebGPU, Feature | WebGPU, RenderFeature |
|---|---|---|---|---|
| layer drawn | 1667 | 1517 | 1515 | 1360 |
| after 4 rebuilds | 1796 | 1235 | 1636 | 1080 |
| features dropped | 1470 | 912 | 1477 | 921 |

What stays after everything is dropped is memory the browser's allocators
have not given back to the system (see the earlier report); it is about
560 MB less with RenderFeatures.

The GPU process holds about the same with both kinds once the layer is
drawn: 564 MB on WebGL2 and 591–612 MB on WebGPU (one peak of 736 MB with
Features during a rebuild). One GPU process serves the whole browser, so its
value on the empty page depends on what ran before (80–419 MB) and is not
a baseline.

Seconds per step:

| | WebGL2, Feature | WebGL2, RenderFeature | WebGPU, Feature | WebGPU, RenderFeature |
|---|---|---|---|---|
| features made | 1.3 | 1.7 | 1.3 | 1.7 |
| layer drawn | 2.8 | 2.1 | 2.1 | 2.3 |
| a rebuild | 0.8–1.1 | 0.8–1.3 | 0.8–1.0 | 0.8–1.1 |

Making the RenderFeatures is slower only because the test makes Features
first and converts them. Drawing and rebuilding take about as long with
both kinds; one run per kind, so differences within a few tenths of a
second are not meaningful.

## Correctness

Alongside, `test/unit/renderfeature.test.ts` checks that RenderFeatures give
the same render instructions, Rust/WASM buffers and text styles as the same
shapes as Features, and `test/rendering/renderfeature.ts` that both draw the
same pixels and pick the same features on both backends, with GPU and with
canvas text.
