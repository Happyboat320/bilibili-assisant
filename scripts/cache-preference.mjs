/* 下载独立 Firefox 实测使用的公开模型文件；不进入插件安装包。 */
import { mkdir, access, rename, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const model = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const root = fileURLToPath(new URL('../', import.meta.url));
const host = process.env.HF_ENDPOINT || 'https://hf-mirror.com';
for (const file of ['config.json','tokenizer.json','tokenizer_config.json','special_tokens_map.json','onnx/model_quantized.onnx']) {
  const target = path.join(root, 'artifacts/minilm', model, file);
  try { await access(target); console.log(`已缓存 ${file}`); continue; } catch {}
  await mkdir(path.dirname(target), { recursive: true });
  console.log(`正在下载 ${file}`);
  const response = await fetch(`${host}/${model}/resolve/main/${file}`, { signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw new Error(`模型下载失败 ${response.status}: ${file}`);
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(target + '.tmp'));
    await rename(target + '.tmp', target);
  } catch (error) { await rm(target + '.tmp', { force: true }); throw error; }
}
