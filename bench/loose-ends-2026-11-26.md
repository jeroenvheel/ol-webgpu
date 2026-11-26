# Four points left after 0.1.0-beta.11 (2026-11-26)

What [first-render-memory-2026-11-26.md](first-render-memory-2026-11-26.md)
left open. Branch `perf/loose-ends`, on `0d543dc` (0.1.0-beta.11). AMD
Radeon R9 200 Series, D3D11, Playwright Chromium unless said.

## First render of the first WebGPU layer of a page

**Was.** The first WebGPU layer of a page was about 110 ms behind WebGL2,
whatever its data: with lines as the first data set
(`npm run bench -- --points=0`) the lines were 83–101 ms behind and the
polygons level; with 1000 points WebGPU took 366–384 ms and WebGL2 128–150.

Two things are once per page:

- `navigator.gpu.requestAdapter()` takes 165–190 ms in a new page (the
  browser starts WebGPU in its GPU process); the device after it 6–13 ms,
  the shader translator 13–17 ms. A WebGL2 context takes 12–16 ms. The same
  in Playwright Chromium and in the installed Chrome.
- The shaders of the style. The pipelines were made as soon as the device
  was there, but the browser kept those commands until the first frame was
  submitted, so the GPU process compiled them then: marks in the renderer
  gave 130 ms between making the pipelines and the GPU process being done
  with them, and that time was in the first frame.

**Now.**

- After making its pipelines the renderer asks about the queue
  (`onSubmittedWorkDone`), which sends the commands: the shaders are
  compiled while the buffers are built (`applyPasses`).
- A WebGPU layer asks for the device and the shader translator when it is
  made, not at its first frame. `prepareWebGPU()` (new export) does the same
  for a page that makes its layers late.

| 1M points, ready (ms) | WebGL2 | WebGPU |
|---|---|---|
| beta.11 | 603 / 590 | 713 / 707 |
| now | 585 / 588 | 602 / 618 |

Lines 563 / 570 and 577 / 601, polygons 444 / 449 and 433 / 442 (WebGL2 and
WebGPU, two runs): as before. Frame times and picks did not change.

A layer of 1000 points that is made right before it is drawn, in a new
page, still takes 352–355 ms on WebGPU (WebGL2 116–138): the device and the
shaders are then all there is to wait for. That is what `prepareWebGPU()`
is for.

## Heap growth per cycle in the memory test

- **A whole map made and disposed** (44–49 KB per cycle): not growth. The
  heap goes from 8.6 to 9.2 MB over 12 cycles and over 60 cycles alike
  (9–10 KB per cycle then). It is 0.6 MB once, in the first cycles after the
  warm-up.
- **Labels with new texts** (35–42 KB per cycle): this was growth, about 110
  bytes per text that was ever drawn, and it stayed after everything was
  disposed (15.1 MB against 11 MB after 180 cycles of 400 new texts). ol
  compiles the `text-*` properties of a style too, for its text worker:
  every property a text reads becomes an attribute, and every text gets a
  number in a table that is never emptied (`getStringNumberEquivalent`).
  Counted: 16 000 new entries in 40 cycles.

  With labels on the GPU those attributes are not read by anything. The
  style now goes to ol's compiler without its `text-*` properties then
  (`withoutText` in `src/render/stylePasses.ts`). Also one float less per
  vertex for every property that only a text reads.

  | labels with new texts, webgl2 | per cycle | heap after disposing |
  |---|---|---|
  | 180 cycles, before | 45 KB | 15.1 MB |
  | 180 cycles, now | 26 KB | 11.7 MB |
  | in the whole test (12 cycles), before | 35–42 KB | |
  | in the whole test, now | −1 to 6 KB | |

  What still grows while the layer lives are the glyph atlas and the
  measured texts, which have limits (58, 41 and 26 KB per cycle over 12, 60
  and 180 cycles). With `text: 'canvas'` the attributes and ol's table are
  as in ol.

## GPU memory during a rebuild on WebGPU: looked at, not changed

One buffer of 128 MB in an otherwise empty page, private memory of the GPU
process in MB (124 with the device alone):

| | right after | 6 s later |
|---|---|---|
| the buffer made (`mappedAtCreation`) | 381 | 251 |
| `writeBuffer` of all of it (what the layer does) | 379–510 | 251 |
| `writeBuffer` in parts of 4 MB | 384–508 | 508 |
| the same, waiting for the queue every 16 MB | 508 | 507 |
| a new buffer, the old one destroyed first | 764 | 507 |
| a new buffer, the old one destroyed after | 764–892 | 635 |

The rise is the copy the browser makes on the way to the buffer: once the
size of what is written, given back within six seconds. Writing all of it
into the buffer that is there is the least of what was tried; parts keep
their copies, and new buffers cost two to four times as much for a while.

## `text: 'canvas'` and ol's batch: looked at, not changed

ol's text worker reads the texts from a table that only ol's instruction
generators fill, at positions that are written into the instructions; ol's
generators read ol's batch. To do without, our generator would have to
write those positions too and keep them right between builds, for a way of
drawing text that is there for likeness with ol. Labels on the GPU are the
default and do not make ol's batch.

## Tests

- Unit 124 of 124. New (`test/unit/stylePasses.test.ts`): what only a text
  reads is no attribute, what something else reads too still is, the style
  still counts as having text, and there are as many passes in the same
  order, also for rules with filters.
- Rendering: 19 cases, 0 failures in every group, on both backends.
- `npm run test:memory`: 0 checks failed, nothing left after disposing.
