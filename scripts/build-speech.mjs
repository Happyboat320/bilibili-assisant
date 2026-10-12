/* 固定使用本地依赖构建，不从 CDN 载入可执行脚本。 */
import { build } from 'esbuild';
import { mkdir, copyFile, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const vendor = path.join(root, 'extension/vendor');
await rm(vendor, { recursive: true, force: true });
await mkdir(vendor, { recursive: true });
await build({
  entryPoints: [path.join(root, 'src/speech-worker.js')],
  outfile: path.join(root, 'extension/speech-worker.js'),
  bundle: true, platform: 'browser', format: 'esm', target: 'firefox142',
  minify: true, legalComments: 'eof',
  external: ['./vendor/ort-wasm-simd-threaded.mjs'],
  plugins: [{
    name: 'browser-wasm-only',
    setup(builder) {
      builder.onResolve({ filter: /^@huggingface\/transformers$/ }, () => ({
        path: path.join(root, 'node_modules/@huggingface/transformers/src/transformers.js')
      }));
      // Firefox 使用 CPU WASM，省去 GPU 运行时，并让 Tensor 与运行时共用实现。
      builder.onResolve({ filter: /^(onnxruntime-web|onnxruntime-common)$/ }, () => ({
        path: path.join(root, 'node_modules/onnxruntime-web/dist/ort.wasm.min.mjs')
      }));
      builder.onResolve({ filter: /^(node:.*|onnxruntime-node|sharp)$/ }, args => ({ path: args.path, namespace: 'browser-empty' }));
      builder.onLoad({ filter: /ort\.wasm\.min\.mjs$/ }, async args => {
        const source = await readFile(args.path, 'utf8');
        const original = 'import(/*webpackIgnore:true*/e)';
        if (!source.includes(original)) throw new Error('ONNX Runtime 加载器已变化，请更新本地 WASM 导入。');
        // CPU WASM 模块固定随插件打包，使用静态导入而非任意 URL 导入。
        return { contents: source.replace(original, 'import("./vendor/ort-wasm-simd-threaded.mjs")'), loader: 'js' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'browser-empty' }, () => ({ contents: 'export default {};', loader: 'js' }));
    }
  }]
});
for (const name of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  await copyFile(path.join(root, 'node_modules/onnxruntime-web/dist', name), path.join(vendor, name));
}
for (const [pkg, target] of [['@huggingface/transformers', 'TRANSFORMERS-LICENSE']]) {
  await copyFile(path.join(root, 'node_modules', pkg, 'LICENSE'), path.join(vendor, target));
}
await copyFile(path.join(root, 'src/ONNX-LICENSE'), path.join(vendor, 'ONNX-LICENSE'));
console.log('内置字幕 Worker 和 WASM 已构建。');
