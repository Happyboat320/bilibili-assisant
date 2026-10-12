/* 冻结的多语言 MiniLM token 推理 + 真实可训练 Transformer/MLP；全部在 CPU Worker。 */
import { env, AutoTokenizer, AutoModel } from '@huggingface/transformers';
import { PreferenceHead, fitHead, cpuReady } from './preference-head.mjs';

const MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const HEAD_FORMAT = 'token-transformer-64x4-v1';
env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = new URL('./vendor/', self.location.href).href;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;
let tokenizer, encoder, head;
const cache = new Map();
const progress = message => self.postMessage({ type: 'progress', message });
async function loadEncoder(source) {
  if (encoder) return;
  env.remoteHost = source === 'huggingface' ? 'https://huggingface.co/' : 'https://hf-mirror.com/';
  progress('正在准备内置 MiniLM，首次使用需下载并缓存模型…');
  tokenizer = await AutoTokenizer.from_pretrained(MODEL);
  encoder = await AutoModel.from_pretrained(MODEL, { device: 'wasm', dtype: 'q8', progress_callback: value => {
    if (value.status === 'progress') progress(`正在下载 MiniLM：${value.file} ${Math.round(value.progress || 0)}%`);
  } });
}
async function features(titles, source) {
  await loadEncoder(source);
  const missing = [...new Set(titles.filter(title => !cache.has(title)))];
  // 保留本次计算的特征，即使训练快照超过常驻 256 项缓存。
  const computed = new Map();
  // 量化编码固定单标题批次，避免其他标题及 padding 改变动态量化特征。
  for (let offset = 0; offset < missing.length; offset += 1) {
    const batch = missing.slice(offset, offset + 1);
    const tokens = tokenizer(batch, { padding: true, truncation: true, max_length: 48 });
    const output = await encoder(tokens);
    const embeddings = output.last_hidden_state;
    try {
      if (!embeddings || embeddings.dims[2] !== 384) throw new Error('MiniLM token 输出维度无效。');
      const length = embeddings.dims[1];
      batch.forEach((title, index) => {
        let valid = 0;
        for (let token = 0; token < length; token++) valid += Number(tokens.attention_mask.data[index * length + token]);
        const feature = Float32Array.from(embeddings.data.subarray(index * length * 384, (index * length + valid) * 384));
        computed.set(title, feature);
      });
    } finally {
      for (const tensor of Object.values(output)) tensor?.dispose?.();
      for (const tensor of Object.values(tokens)) tensor?.dispose?.();
    }
    progress(`MiniLM 正在编码标题：${Math.min(offset + 1, missing.length)} / ${missing.length}`);
  }
  const result = titles.map(title => {
    const feature = computed.get(title) || cache.get(title);
    cache.delete(title); cache.set(title, feature);
    return feature;
  });
  while (cache.size > 256) cache.delete(cache.keys().next().value);
  return result;
}
async function dispatch(data) {
  await cpuReady();
  if (data.type === 'train') {
    head?.dispose(); head = undefined;
    if (data.checkpoint?.format === HEAD_FORMAT && data.checkpoint.model === MODEL && data.checkpoint.dimension === 384) {
      try {
        head = new PreferenceHead(data.checkpoint);
        progress('已恢复浏览器保存的个人 Transformer + MLP。');
        return { checkpoint: data.checkpoint, restored: true };
      } catch { progress('保存的训练头无效，正在根据标注重新训练。'); }
    }
    const encoded = await features(data.labels.map(item => item.title), data.source);
    const result = await fitHead(encoded, data.labels.map(item => item.rating), {
      onProgress: value => progress(`内置 Transformer + MLP 正在训练：${value.epoch} / ${value.epochs} 轮，损失 ${value.loss.toFixed(4)}`)
    });
    head = result.head;
    return { checkpoint: { ...await head.serialize(), format: HEAD_FORMAT, model: MODEL }, losses: result.losses };
  }
  if (data.type === 'score') {
    if (!head) throw new Error('个人训练头尚未就绪。');
    const values = await head.predict(await features(data.items.map(item => item.title), data.source));
    if (values.some(value => !Number.isFinite(value))) throw new Error('偏好评分含无效数值。');
    return data.items.map((item, index) => ({ ...item, score: values[index] }));
  }
  throw new Error('未知的偏好计算任务。');
}
let queue = Promise.resolve();
self.onmessage = ({ data }) => {
  const task = queue.then(() => dispatch(data)).then(result => self.postMessage({ id: data.id, result }), error => self.postMessage({ id: data.id, error: error.message }));
  queue = task.catch(() => {});
};
