/* 仅打包 extension/，模型缓存、个人数据和开发依赖不进入 XPI。 */
import { readdir, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { zipSync } from 'fflate';
const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'extension');
for (const file of ['speech-worker.js', 'preference-worker.js', 'vendor/ort-wasm-simd-threaded.wasm']) await access(path.join(source, file));
const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
const entries = {};
async function collect(directory, prefix = '') {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    // 点文件是本地发布凭据（如 .amo-upload-uuid），不进入分发包。
    if (item.name.startsWith('.')) continue;
    const name = prefix + item.name;
    if (item.isDirectory()) await collect(path.join(directory, item.name), name + '/');
    else if (item.isFile()) entries[name] = new Uint8Array(await readFile(path.join(directory, item.name)));
  }
}
await collect(source);
const target = path.join(root, 'artifacts', `bilibili-assistant-${manifest.version}.xpi`);
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, zipSync(entries, { level: 6 }));
console.log(`已生成未签名插件：${target}`);
