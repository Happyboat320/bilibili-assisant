/* 偏好标注与会话留在后台，基础模型和训练头只在专用 Worker 中计算。 */
(function (root) {
  'use strict';
  const MINIMUM = 31, MAX_LABELS = 2000;
  function createService({ storage = browser.storage.local, checkpoints = BiliPreferenceStore(), createWorker = () => new Worker(browser.runtime.getURL('preference-worker.js'), { type: 'module' }) } = {}) {
    let labels = [], revision = 0, modelVersion = -1;
    let active = false, training = false, source = 'mirror';
    let message = '标注超过 30 个不同视频后才启动模型。';
    let worker, generation = 0, requestId = 0, scoring = 0, retryAfter = 0;
    let mutations = Promise.resolve();
    const pending = new Map();
    const initialized = storage.get('preferenceData').then(result => {
      const data = result.preferenceData;
      if (data) { labels = validateLabels(data.labels); revision = Number(data.revision) || 0; }
    });
    function validateLabels(values) {
      if (!Array.isArray(values) || values.length > MAX_LABELS) throw new Error('标注需为数组，最多 2000 条。');
      const result = new Map();
      for (const item of values) {
        const id = String(item.id || '').trim().slice(0, 512), title = String(item.title || '').trim().slice(0, 300);
        if (!id || !title || !Number.isInteger(item.rating) || item.rating < 0 || item.rating > 3) throw new Error('标注文件中存在无效的视频或评级。');
        result.set(id, { id, title, rating: item.rating });
      }
      return [...result.values()];
    }
    function state() {
      const counts = [0, 0, 0, 0];
      labels.forEach(item => counts[item.rating]++);
      return { count: labels.length, minimum: MINIMUM, revision, modelVersion, training,
        ready: active && !training && modelVersion === revision && !!worker,
        runtimeActive: active, counts, device: 'cpu', embeddingModel: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
        message: active ? message : '本页尚未手动开启或会话已结束；模型和标注保留。' };
    }
    function stop(reason = '偏好计算已暂停。') {
      generation++;
      worker?.terminate(); worker = undefined;
      for (const item of pending.values()) item.reject(new Error(reason));
      pending.clear(); training = false; modelVersion = -1;
    }
    function rpc(type, payload) {
      if (!worker) {
        worker = createWorker();
        worker.onmessage = ({ data }) => {
          if (data.type === 'progress') { message = data.message; return; }
          const item = pending.get(data.id);
          if (!item) return;
          pending.delete(data.id);
          data.error ? item.reject(new Error(data.error)) : item.resolve(data.result);
        };
        worker.onerror = () => { message = '内置偏好 Worker 运行失败，视频保持可见。'; retryAfter = Date.now() + 60000; stop(message); };
      }
      const id = ++requestId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try { worker.postMessage({ id, type, source, ...payload }); }
        catch (error) { pending.delete(id); reject(error); }
      });
    }
    async function ensureTraining() {
      await initialized;
      if (!active || labels.length < MINIMUM || training || modelVersion === revision || Date.now() < retryAfter) return;
      training = true;
      message = '正在准备内置 MiniLM 与 Transformer + MLP…';
      const version = revision, currentGeneration = generation, snapshot = labels.map(item => ({ ...item }));
      try {
        const checkpoint = await checkpoints.get();
        if (!active || generation !== currentGeneration) return;
        const result = await rpc('train', { labels: snapshot, revision: version, checkpoint: checkpoint?.revision === version ? checkpoint : undefined });
        if (generation !== currentGeneration || !active || revision !== version) return;
        await checkpoints.put({ ...result.checkpoint, revision: version });
        if (generation !== currentGeneration || !active || revision !== version) return;
        modelVersion = version;
        message = '内置偏好模型已就绪。分数是偏好估计，不是校准后的概率。';
      } catch (error) {
        if (generation === currentGeneration && active) { retryAfter = Date.now() + 60000; message = `内置偏好模型失败：${error.message} 视频保持可见。`; stop(message); }
      } finally {
        if (generation === currentGeneration) { training = false; if (active && revision !== version) void ensureTraining(); }
      }
    }
    function mutate(operation) {
      const result = mutations.then(async () => { await initialized; return operation(); });
      mutations = result.catch(() => {});
      return result;
    }
    async function persist(nextLabels, nextRevision) {
      await storage.set({ preferenceData: { labels: nextLabels, revision: nextRevision }, preferenceRevision: nextRevision,
        preferenceRatings: Object.fromEntries(nextLabels.map(item => [item.id, item.rating])) });
      labels = nextLabels; revision = nextRevision;
      retryAfter = 0;
    }
    return {
      async setActive(enabled, modelSource = source) {
        await initialized;
        const changedSource = modelSource !== source;
        source = modelSource;
        active = enabled === true;
        if (!active || changedSource) stop();
        if (active) void ensureTraining();
        return state();
      },
      async status() { await initialized; if (active) void ensureTraining(); return state(); },
      label(item) { return mutate(async () => {
        const [value] = validateLabels([item]);
        const old = labels.find(label => label.id === value.id);
        if (!old || old.title !== value.title || old.rating !== value.rating) {
          await persist([...labels.filter(label => label.id !== value.id), value].slice(-MAX_LABELS), revision + 1);
        }
        if (active) void ensureTraining();
        return state();
      }); },
      async score(items) {
        await initialized;
        if (!items.length) return { ...state(), scores: [] };
        if (!state().ready) { if (active) void ensureTraining(); return { ...state(), scores: [] }; }
        if (scoring >= 2) return { ...state(), ready: false, scores: [], message: '偏好推理队列繁忙，稍后重试。' };
        const version = revision, currentGeneration = generation;
        scoring++;
        try {
          const scores = await rpc('score', { items });
          if (!active || generation !== currentGeneration || version !== revision || !state().ready) return { ...state(), ready: false, scores: [] };
          return { ...state(), scores };
        } finally { scoring--; }
      },
      reset() { return mutate(async () => {
        stop(); await checkpoints.clear();
        await persist([], revision + 1);
        await storage.set({ preferenceFeedbackLedger: [] });
        message = '标注和个人训练头已清空，基础 MiniLM 缓存保留。';
        return state();
      }); },
      async exportLabels() { await mutations; await initialized; return { labels: labels.map(item => ({ ...item })), revision }; },
      importLabels(data) { return mutate(async () => {
        const imported = validateLabels(Array.isArray(data) ? data : data?.labels);
        const merged = new Map(labels.map(item => [item.id, item]));
        imported.forEach(item => { merged.delete(item.id); merged.set(item.id, item); });
        stop(); await checkpoints.clear();
        await persist([...merged.values()].slice(-MAX_LABELS), revision + 1);
        message = '标注已导入，手动开启后将在插件内重新训练。';
        if (active) void ensureTraining();
        return state();
      }); }
    };
  }
  root.BiliPreferenceService = createService;
  if (typeof module !== 'undefined') module.exports = createService;
})(globalThis);
