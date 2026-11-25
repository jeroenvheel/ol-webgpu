# First render and memory after 0.1.0-beta.10 (2026-11-26)

Five points that the benchmark and the memory test of beta.10
([beta10-2026-11-25.md](beta10-2026-11-25.md)) left. Branch
`perf/first-render-memory`, on `ed5bc08` (0.1.0-beta.10). AMD Radeon R9 200
Series, D3D11, Playwright Chromium (which compiles WebGPU shaders with FXC;
an installed Chrome uses DXC).

## What changed

### The first frame does not wait for the hit index

**Was.** The worker made the buffers and the hit index of a build and sent
them together. A trace of the first render of a million points, in
milliseconds after the renderer was made (WebGPU / WebGL2):

| | WebGPU | WebGL2 |
|---|---|---|
| features in the batch | 164 | about the same |
| instructions made | 362 | 439 |
| worker done | 513 | 581 |
| of which the hit index | 149 | 139 |
| uploaded, first frame, `rendercomplete` | 564 | 636 |
| the frame is on the screen | 749 | 663 |

The buffers of points take the worker 0.05 ms; all of its time was the
index, which drawing does not need.

**Now.** The worker sends the buffers and then makes the index
(`src/worker/worker.ts`, `runIndex` in `src/worker/build.ts`); the client
gives the index to the renderer when it comes (`WorkerClient.build(request,
onIndex)`). Until then the index of the build before answers, so a layer
whose features change all the time is not without hits after every change;
after the first build there are no hits until the index is in.
`isPickingReady()` tells, and `renderer.indexPending`.

When the worker fails after the buffers, the renderer is told that no index
comes and builds again on the main thread.

### A WebGPU layer builds while its device is requested

**Was.** `prepareFrame` did nothing with the features until the device and
the shader translator were there: 362 ms in the trace above, of which the
batch and the instructions could have used all.

**Now.** The build starts at once and waits for the device with its buffers
(`whenBackend`). When the first request for a device fails, the build keeps
waiting without holding back `rendercomplete`, and is uploaded when a later
request gives one (it was made again before).

What is left between the backends for points is after the first frame is
submitted: the GPU process takes about 150 ms for it on WebGPU and 27 ms on
WebGL2. About 70 ms of that is the upload; the rest was not pinned down. It
is once per page: lines and polygons, measured after points in the same
page, are level with WebGL2.

### The layer's own batch

**Was.** ol's `MixedGeometryBatch` (with the refs kept another way). Taking
things from the renderer of the big layer (300 000 points, 200 000 lines,
50 000 polygons, WebGPU) one by one, and reading the heap:

| | MB |
|---|---|
| the features | 602 |
| added by the layer | 354 |
| of which: the entries of the lines | 105 |
| the entries of the points | 40 |
| the entries of the polygons | 14 |
| the kept attribute values | 16 |
| left after the map and the layer are disposed | 176 |

The 176 MB are not the layer's: the source is made in that step, and it
listens to every feature. The entries of the lines are that large because ol
copies the coordinates of every line and ring, as x, y, m.

**Now.** `src/render/batch.ts` keeps a ref per feature and a few numbers at
that ref in typed arrays. The coordinates are read from the geometries when
instructions are made (`visitGeometry`), in the parts and the order ol's
batch has them in. What ol's batch holds is made of it only for ol's own
generators (`toOl`), which are used with `text: 'canvas'` and for attributes
with text; it is kept until the features change.

The batch is 41 MB where the entries were 160 MB.

Refs of removed features are given again after the next build, not at once
(the lists per kind still have them until then).

### WebGL2 without its copy of the buffers

`keepBuffers: false` (new option, WebGL2 only, default `true`). The copy is
what WebGL2 uploads again after a lost context or when the layer goes to
another canvas; without it the buffers are built again then, and the layer
is not drawn until they are. WebGPU never kept one.

### Smaller things

- A WebGPU layer that was disposed between its frame and `rendercomplete`
  threw in the redraw for map export (`Cannot read properties of null
  (reading 'getContext')`, in the log of the rendering tests). It is left
  out of the redraw now.
- `bench/run.js` stayed alive for five minutes after the results were
  written (a timer).

## Measured

Two runs each, milliseconds, lower is better. "beta.10" are the runs of
[beta10-2026-11-25.md](beta10-2026-11-25.md).

| Data set | | WebGL2 beta.10 | WebGL2 now | WebGPU beta.10 | WebGPU now |
|---|---|---|---|---|---|
| 1M points | ready | 759 / 676 | 603 / 590 | 937 / 893 | 713 / 707 |
| | frame | 12.5 / 13.1 | 12.8 / 12.4 | 11.4 / 11.6 | 11.5 / 11.6 |
| | pick | 0.09 / 0.08 | 0.08 / 0.09 | 0.08 / 0.19 | 0.16 / 0.10 |
| 200k lines | ready | 785 / 773 | 557 / 558 | 817 / 829 | 560 / 577 |
| | frame | 14.9 / 15.5 | 15.6 / 15.3 | 14.8 / 15.5 | 14.7 / 14.2 |
| | pick | 0.11 / 0.03 | 0.03 / 0.03 | 0.03 / 0.03 | 0.11 / 0.03 |
| 100k polygons | ready | 670 / 672 | 457 / 436 | 696 / 701 | 471 / 436 |
| | frame | 12.0 / 11.8 | 12.3 / 12.1 | 12.1 / 12.2 | 11.1 / 12.1 |
| | pick | 0.02 / 0.06 | 0.08 / 0.08 | 0.06 / 0.03 | 0.05 / 0.07 |

- Time to first render is 11–20% shorter for points on WebGL2 and 21–24% on
  WebGPU, 28–31% for lines and 32–38% for polygons.
- Frame times, picks and the worker stages did not change.

The big layer, heap added by the layer in MB:

| | WebGL2 | WebGPU |
|---|---|---|
| beta.10, `ol/Feature` | 518 | 354 |
| now | 398 | 233 |
| now, `keepBuffers: false` | 233 | – |
| beta.10, RenderFeatures | 407 | 243 |
| now | 280 | 116 |

A rebuild takes 0.6 s as before. `npm run test:memory`: 0 checks failed;
nothing is left after disposing. Heap growth per cycle is 0–9 KB, with a
whole map made and disposed at 44–49 KB (40–43 before) and labels with new
texts at 35–42 KB (27–32 before); the limit of the test is 100 KB.

## Looked at, not changed

- **GPU memory during a rebuild on WebGPU.** The GPU process goes from
  1097 MB to 1229, 1224 and 1216 MB over three rebuilds of the big layer and
  is back at 1094 MB after the fourth; with RenderFeatures 622, 752, 750,
  750 and 737 MB. So it does not grow with the rebuilds: it is about one
  upload more for a while. That fits the copy `queue.writeBuffer` makes on
  its way to a buffer that is used again, but which allocation it is was not
  measured. New buffers for every rebuild were tried before and were worse
  (see `upload` in the renderer).
- **Polygon frames on WebGPU**, which were 0.5–1 ms higher in both runs of
  beta.10. beta.7 and this branch measured in turns, three times each: 12.41
  / 12.47 / 11.85 ms and 11.79 / 12.28 / 11.84 ms. No difference.

## Tests

- Unit 120 of 120. New: the batch gives what ol's batch holds, with more
  kinds of geometry (lines with Z and M, multi lines, polygons with holes,
  RenderFeatures of several polygons), refs are used again and never for two
  features, and a geometry in another projection; the instructions equal
  those of ol's generators for the same; the index after the buffers gives
  the same buffers and index as both at once; the client hands the index on,
  and tells when the worker failed after the buffers.
- Rendering: 19 cases, 0 failures in every group, on both backends. New in
  `removed.ts`: a layer that goes to another canvas is drawn and hit there,
  built again only on WebGL2 with `keepBuffers: false`. The pages wait for
  the hit index too (`renderersSettled`). Two checks were changed: with a
  late device the page waits for the device, as the build is made ahead; a
  layer of `setMap` with labels needs one frame of its own, not two (the
  labels are laid out while the device is requested).
