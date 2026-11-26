# Development

Requirements: Node 20+, Rust (stable, `rustup target add wasm32-unknown-unknown`).
On Windows without Visual Studio, the GNU host toolchain works
(`rustup-init --default-host x86_64-pc-windows-gnu`).

```sh
npm install
npx playwright install chromium   # for the browser tests and the benchmark
npm run build:wasm            # crates/* → src/wasm/*.wasm
npm run fetch-upstream        # ol's rendering tests + data for the installed ol version → .upstream/
npm run sync-upstream-tests   # copy ol's WebGLVector rendering cases + data into test/rendering
npm run dev                   # examples on http://localhost:5180 (compare.html, bench.html)
npm test                      # unit tests (vitest): golden buffers, shader translation
npm run test:rust             # cargo tests of both crates
npm run test:rendering        # screenshots, hit detection, text, labels, export, shared canvas and RenderFeature checks in Chromium
npm run test:memory           # leak checks: repeats what a layer does and counts what stays alive
npm run test:memory -- --big  # one big layer step by step, from ol/Feature and from RenderFeatures
npm run bench                 # benchmark, see bench/run.js for options
npm run build                 # dist/ (ES module + worker + wasm + .d.ts)
npm run test:dist             # production app build against dist/, checked in Chromium
```

`.upstream/openlayers` is a shallow, sparse clone of the ol tag matching the
installed version, made by `npm run fetch-upstream`.

Browser flags per platform are in `test/browser.js`. On Windows the tests use
the real GPU via D3D11. Playwright's bundled Chromium there lacks
`dxcompiler.dll`, so the runners pass `--disable-dawn-features=use_dxc`; use
`--channel=msedge` to test with an installed browser instead. On Linux in CI
they use SwiftShader, which provides both WebGL2 and WebGPU without a GPU.
Without a WebGPU adapter, `test:rendering` skips the WebGPU layer with a
warning; `--require-webgpu` makes that an error.

**Releasing.** Set the version, commit, and push a matching tag:

```sh
npm version 0.1.0-beta.1 --no-git-tag-version   # or edit package.json
git commit -am "Release 0.1.0-beta.1"
git tag v0.1.0-beta.1 && git push origin main v0.1.0-beta.1
```

The `Release` workflow (`.github/workflows/release.yml`) then publishes to
npm with trusted publishing: no npm token, the job identifies itself to npm
with GitHub's OIDC token, and npm adds a provenance statement. Versions
with a `-` (beta, rc) are published under the `next` tag, others under
`latest`. `npm publish` runs `prepublishOnly` first (`npm run build`,
including the wasm, then `npm run test:dist`), so the package is always
built from the tagged sources. Check the contents with `npm pack --dry-run`.

**CI.** GitHub Actions (`.github/workflows/ci.yml`) runs on every push to
`main` and on pull requests (Ubuntu, SwiftShader): wasm build, typecheck,
unit and Rust tests, a check that the synced upstream cases are current, all
rendering, hit detection, text, export, shared canvas and RenderFeature tests with WebGPU
required, the package
build and the dist smoke test. On failure, the screenshots and diffs are
uploaded as the `rendering-report` artifact.

[Back to the README](../README.md)
