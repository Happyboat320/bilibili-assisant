/* 偏好标注与会话留在后台，基础模型和训练头只在专用 Worker 中计算。 */
(function (root) {
  'use strict';
  const MINIMUM = 31, MAX_LABELS = 2000;
  function createService({ storage = browser.storage.local, checkpoints = BiliPreferenceStore(), createWorker = () => new Worker(browser.runtime.getURL('preference-worker.js'), { type: 'module' }) } = {}) {
    let labels = [], revision = 0, modelVersion = -1;
    let requestedRevision = -1, savedRevision = -1;
    let logs = [], loading = false;
    function log(value) {
      message = value;
      if (logs.at(-1)?.message !== value) logs.push({ time: Date.now(), message: value });
      logs = logs.slice(-300);
    }
    let active = false, training = false, source = 'mirror';
    let message = '请在详细设置手动训练模型。';
    let worker, generation = 0, requestId = 0, scoring = 0;
    let mutations = Promise.resolve();
    const pending = new Map();
    const initialized = Promise.all([storage.get('preferenceData'), checkpoints.get()]).then(([result, checkpoint]) => {
      savedRevision = checkpoint?.revision ?? -1;
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
      return { count: labels.length, minimum: MINIMUM, revision, modelVersion, training, loading, logs: logs.map(item => ({ ...item })), hasModel: savedRevision >= 0,
        ready: active && !training && modelVersion >= 0 && !!worker,
        pendingUpdate: savedRevision !== revision,
        runtimeActive: active, counts, device: 'cpu', embeddingModel: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
        message };
    }
    function stop(reason = '偏好计算已暂停。') {
      generation++;
      worker?.terminate(); worker = undefined;
      for (const item of pending.values()) item.reject(new Error(reason));
      pending.clear(); training = false; loading = false; modelVersion = -1;
    }
    function rpc(type, payload) {
      if (!worker) {
        worker = createWorker();
        worker.onmessage = ({ data }) => {
          if (data.type === 'progress') { if (training) log(data.message); else message = data.message; return; }
          const item = pending.get(data.id);
          if (!item) return;
          pending.delete(data.id);
          data.error ? item.reject(new Error(data.error)) : item.resolve(data.result);
        };
        worker.onerror = () => { const error = '内置偏好 Worker 运行失败，视频保持可见。'; if (training) log(`训练失败：${error}`); else message = error; stop(error); };
      }
      const id = ++requestId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try { worker.postMessage({ id, type, source, ...payload }); }
        catch (error) { pending.delete(id); reject(error); }
      });
    }
    async function restore() {
      if (loading || training || worker) return;
      loading = true;
      const currentGeneration = generation;
      try {
        const checkpoint = await checkpoints.get();
        if (!active || generation !== currentGeneration) return;
        if (!checkpoint) { message = '尚无训练模型，请在详细设置点击“训练模型”。'; return; }
        requestedRevision = checkpoint.revision;
        await rpc('restore', { checkpoint });
        if (!active || generation !== currentGeneration) return;
        modelVersion = checkpoint.revision;
        message = '已加载训练模型，可进行筛选。';
      } catch (error) {
        if (generation === currentGeneration) { stop(); message = `模型加载失败：${error.message} 请手动重新训练。`; }
      } finally { if (generation === currentGeneration) loading = false; }
    }
    async function runTraining(snapshot, version) {
      const currentGeneration = generation;
      try {
        const result = await rpc('train', { labels: snapshot, revision: version });
        if (generation !== currentGeneration) return;
        await checkpoints.put({ ...result.checkpoint, revision: version });
        if (generation !== currentGeneration) return;
        savedRevision = version; modelVersion = version;
        log('训练完成，模型已保存。' + (revision !== version ? '训练期间新增标注，可再次手动训练更新。' : ''));
      } catch (error) {
        if (generation === currentGeneration) { log(`训练失败：${error.message}`); stop(); }
      } finally {
        if (generation === currentGeneration) {
          training = false;
          if (!active) stop();
        }
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
    }
    return {
      async setActive(enabled, modelSource = source) {
        await initialized;
        active = enabled === true;
        if (!training) {
          source = modelSource;
          if (!active) stop();
          else if (!worker && !loading) void restore();
        }
        return state();
      },
      async train(modelSource = source) {
        await mutations; await initialized;
        if (training) return state();
        if (labels.length < MINIMUM) throw new Error('至少标注 31 个不同视频后才能训练。');
        stop(); source = modelSource; requestedRevision = revision;
        training = true; logs = [];
        log(`开始手动训练：${labels.length} 条标注，版本 ${revision}。`);
        void runTraining(labels.map(item => ({ ...item })), revision);
        return state();
      },
      async status() { await initialized; return state(); },
      label(item) { return mutate(async () => {
        const [value] = validateLabels([item]);
        const old = labels.find(label => label.id === value.id);
        if (!old || old.title !== value.title || old.rating !== value.rating) {
          await persist([...labels.filter(label => label.id !== value.id), value].slice(-MAX_LABELS), revision + 1);
        }
        return state();
      }); },
      async score(items) {
        await initialized;
        if (!items.length) return { ...state(), scores: [] };
        if (!state().ready) return { ...state(), scores: [] };
        if (scoring >= 2) return { ...state(), ready: false, scores: [], message: '偏好推理队列繁忙，稍后重试。' };
        const version = requestedRevision, currentGeneration = generation;
        scoring++;
        try {
          const scores = await rpc('score', { items });
          if (!active || generation !== currentGeneration || version !== modelVersion || !state().ready) return { ...state(), ready: false, scores: [] };
          return { ...state(), scores };
        } finally { scoring--; }
      },
      reset() { return mutate(async () => {
        active = false;
        if (training) log('训练已取消：清空标注和模型。');
        stop(); await checkpoints.clear(); savedRevision = -1;
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
        await persist([...merged.values()].slice(-MAX_LABELS), revision + 1);
        message = '标注已导入，请手动训练更新模型。';
        return state();
      }); }
    };
  }
  root.BiliPreferenceService = createService;
  if (typeof module !== 'undefined') module.exports = createService;
})(globalThis);
