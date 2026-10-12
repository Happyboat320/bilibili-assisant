/* 内置字幕服务：下载音轨、解码到 16 kHz 单声道，再交给模型 Worker。 */
(function (root) {
  'use strict';
  const MAX_BYTES = 256 * 1024 * 1024;
  const MAX_DURATION = 3 * 60 * 60;
  const tasks = new Map();
  let queue = Promise.resolve();

  function mediaURL(raw) {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !/(^|\.)(bilivideo\.com|bilivideo\.cn)$/.test(url.hostname)
        || url.username || url.password || (url.port && url.port !== '443')) {
      throw new Error('音轨地址必须属于 B 站 HTTPS 媒体 CDN。');
    }
    return url.href;
  }
  async function audioBytes(urls, signal, progress) {
    let lastError;
    for (const raw of urls) {
      try {
        const response = await fetch(mediaURL(raw), { credentials: 'omit', signal: AbortSignal.any([signal, AbortSignal.timeout(30 * 60 * 1000)]) });
        if (!response.ok) throw new Error(`音轨下载失败：HTTP ${response.status}`);
        mediaURL(response.url);
        if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('音轨超过 256 MiB 上限。');
        const reader = response.body.getReader();
        const chunks = [];
        let total = 0;
        let lastReport = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_BYTES) throw new Error('音轨超过 256 MiB 上限。');
            chunks.push(value);
            if (Date.now() - lastReport > 1000) {
              progress(`正在下载音轨：${(total / 1048576).toFixed(1)} MiB`);
              lastReport = Date.now();
            }
          }
        } finally { await reader.cancel().catch(() => {}); }
        if (!total) throw new Error('音轨文件为空。');
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        return bytes.buffer;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        lastError = error;
      }
    }
    throw lastError || new Error('没有可用音轨地址。');
  }
  async function decode(bytes) {
    // 浏览器原生解码 MP4/AAC；实际采样数再检查一次时长，避免依赖页面元数据。
    const context = new AudioContext({ sampleRate: 16000 });
    try {
      const decoded = await context.decodeAudioData(bytes);
      if (!decoded.length || decoded.duration > MAX_DURATION) throw new Error('内置识别支持最长 3 小时的音轨。');
      const pcm = new Float32Array(decoded.length);
      for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
        const values = decoded.getChannelData(channel);
        for (let index = 0; index < pcm.length; index++) pcm[index] += values[index] / decoded.numberOfChannels;
      }
      if (!pcm.every(Number.isFinite)) throw new Error('音轨含无效采样。');
      return pcm;
    } catch (error) {
      if (error.name === 'EncodingError' || error.name === 'NotSupportedError') throw new Error('Firefox 无法解码此音轨，请确认系统支持 AAC/MP4；FLV 暂不支持。');
      throw error;
    } finally { await context.close(); }
  }
  function infer(audio, settings, signal, progress) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(browser.runtime.getURL('speech-worker.js'), { type: 'module' });
      const finish = (error, result) => {
        signal.removeEventListener('abort', abort);
        worker.terminate(); // 释放模型内存，模型文件仍保留在浏览器缓存中。
        error ? reject(error) : resolve(result);
      };
      const abort = () => finish(signal.reason || new Error('识别已取消。'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      worker.onerror = () => finish(new Error('内置模型 Worker 无法启动，请重新构建插件并检查 Firefox 的 WASM 支持。'));
      worker.onmessage = ({ data }) => {
        if (data.type === 'progress') progress(data.message);
        else if (data.type === 'done') finish(null, data);
        else if (data.type === 'error') finish(new Error(data.message));
      };
      worker.postMessage({ audio, model: settings.model, modelSource: settings.modelSource, language: settings.language }, [audio.buffer]);
    });
  }
  function transcribe(tabId, payload, progress) {
    if (tasks.has(tabId)) return Promise.reject(new Error('当前页面已有字幕识别任务。'));
    if (tasks.size >= 3) return Promise.reject(new Error('内置识别队列已满，请稍后重试。'));
    if (!Number.isFinite(payload.duration) || payload.duration <= 0 || payload.duration > MAX_DURATION) {
      return Promise.reject(new Error('内置识别支持最长 3 小时的视频。'));
    }
    const controller = new AbortController();
    tasks.set(tabId, controller);
    progress('内置识别已排队…');
    const task = queue.then(async () => {
      controller.signal.throwIfAborted();
      const bytes = await audioBytes(payload.urls, controller.signal, progress);
      progress('正在解码音轨…');
      const audio = await decode(bytes);
      controller.signal.throwIfAborted();
      progress('正在加载内置 Whisper，首次使用需下载模型…');
      return infer(audio, payload, controller.signal, progress);
    }).finally(() => tasks.delete(tabId));
    queue = task.catch(() => {});
    return task;
  }
  function cancel(tabId) { tasks.get(tabId)?.abort(new Error('视频页面已关闭，识别已取消。')); }
  root.BiliSpeech = { transcribe, cancel };
})(globalThis);
