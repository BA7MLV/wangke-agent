/** VAD 用的 ORT wasm：必须是 public/ort 里实际部署的非 jsep 变体。
 *  默认 onnxruntime-web 会去拉 jsep（~26MB，超 Cloudflare Pages 上限）。 */

export const ORT_WASM_PATHS = {
  mjs: '/ort/ort-wasm-simd-threaded.mjs',
  wasm: '/ort/ort-wasm-simd-threaded.wasm',
} as const;

export function configureOrt(
  ort: { env: { wasm: { wasmPaths?: unknown; numThreads?: number } } },
  isolation: { crossOriginIsolated?: boolean } = globalThis,
): void {
  ort.env.wasm.wasmPaths = { ...ORT_WASM_PATHS };
  if (!isolation.crossOriginIsolated) {
    ort.env.wasm.numThreads = 1;
  }
}
