# Bundlers, Content Security Policy and Jest

The package is an ES module that loads three files next to itself with
`new URL('assets/…', import.meta.url)`: the geometry worker
(`assets/worker-*.js`), `assets/ol_gpu_core-*.wasm` and, for WebGPU only,
`assets/ol_gpu_shader-*.wasm`. Bundlers that understand this pattern copy
the files for you; for the others, copy `node_modules/ol-webgpu/dist/assets`
to an `assets/` folder next to the app's JavaScript.

- **Vite**: production builds work as is (`npm run test:dist` checks this).
  If the dev server's dependency pre-bundling breaks the URLs, add
  `optimizeDeps: {exclude: ['ol-webgpu']}`.
- **Angular** (application builder, esbuild): the files are not bundled, so
  copy them and keep the package out of the dev server's pre-bundling. In
  `angular.json` / `project.json`:

  ```json
  "build": {"options": {"assets": [
    {"glob": "*.{wasm,js}", "input": "node_modules/ol-webgpu/dist/assets", "output": "assets"}
  ]}},
  "serve": {"options": {"prebundle": {"exclude": ["ol-webgpu"]}}}
  ```

- **webpack 5** handles `new URL(…, import.meta.url)` and
  `new Worker(new URL(…))` itself (asset modules); not tested here.
- **Other setups**: if the wasm files are served elsewhere, pass their URLs
  with the `wasmUrl` and `shaderWasmUrl` layer options. The worker is always
  loaded from `assets/` next to the module.

**Content Security Policy.** Compiling WebAssembly needs `'wasm-unsafe-eval'`
in `script-src`. With `text: 'canvas'`, labels use ol's text worker, which
starts from a `blob:` URL (as with ol's own `WebGLVector`):

```
script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:
```

A worker gets the CSP of its own script response, not the page's: if your
server sends the CSP as an HTTP header for the worker file too, it needs
`'wasm-unsafe-eval'` there as well.

**Jest** (CommonJS) cannot load ES modules that use `import.meta.url`. Map
the package to a stub in unit tests, for example one that exports ol's
`WebGLVectorLayer` under the same names:

```js
// jest config
moduleNameMapper: {'^ol-webgpu$': '<rootDir>/test/ol-webgpu.stub.ts'},
```

```ts
// test/ol-webgpu.stub.ts
import WebGLVectorLayer from 'ol/layer/WebGLVector';
export const GpuVectorLayer = WebGLVectorLayer;
export const WebGL2VectorLayer = WebGLVectorLayer;
export const WebGPUVectorLayer = WebGLVectorLayer;
export const isWebGPUAvailable = () => false;
export const prepareWebGPU = () => {};
```

[Back to the README](../README.md)
