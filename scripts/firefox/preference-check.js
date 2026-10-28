(async () => {
  const resultElement = document.querySelector('#result');
  const checks = [], start = performance.now();
  const assert = (value, name) => { if (!value) throw new Error(name); checks.push(name); };
  async function waitReady(service) {
    for (let i = 0; i < 2400; i++) {
      const state = await service.status();
      document.querySelector('#progress').textContent = state.message;
      if (state.ready) return state;
      if (state.message.includes('失败')) throw new Error(state.message);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('偏好训练或恢复超时');
  }
  try {
    const service = BiliPreferenceService();
    const before = await service.status();
    assert(!before.ready && !before.runtimeActive, '浏览器启动后默认不计算');
    if (before.count === 0) {
      const cache = await caches.open('transformers-cache');
      for (const name of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'onnx/model_quantized.onnx']) {
        const response = await fetch(browser.runtime.getURL('test-model/' + name));
        if (!response.ok) throw new Error('缺少真实模型文件 ' + name);
        await cache.put('https://hf-mirror.com/Xenova/paraphrase-multilingual-MiniLM-L12-v2/resolve/main/' + name, response);
      }
      const dataset = await (await fetch('preference-titles.json')).json();
      const labels = dataset.filter(item => item.split === 'train').slice(0, 31).map(item => ({ id: item.id, title: item.title, rating: item.rating }));
      await service.importLabels({ labels: labels.slice(0, 30) });
      await service.setActive(true);
      assert(!(await service.status()).training && !(await service.status()).ready, '30条不启动模型');
      await service.label(labels[30]);
      assert(!(await service.status()).training && !(await service.status()).ready, '第31条标注不自动训练');
      await service.train();
    } else {
      assert(before.count === 31, '重启后保留31条标注');
      await service.setActive(true);
    }
    const ready = await waitReady(service);
    assert(ready.count === 31 && ready.modelVersion === ready.revision, '真实MiniLM与45轮Transformer训练完成');
    const exported = await service.exportLabels();
    const items = exported.labels.slice(0, 12).map(({ id, title }) => ({ id, title }));
    const scored = await service.score(items);
    assert(scored.scores.length === items.length && scored.scores.every(item => Number.isFinite(item.score) && item.score >= 0 && item.score <= 1), '真实编码器输出可评分');
    assert(Math.max(...scored.scores.map(item => item.score)) - Math.min(...scored.scores.map(item => item.score)) > 0.05, '不同标题输出不同偏好分数');
    const positives = scored.scores.filter(item => exported.labels.find(label => label.id === item.id).rating >= 2);
    const negatives = scored.scores.filter(item => exported.labels.find(label => label.id === item.id).rating <= 1);
    const mean = values => values.reduce((sum, item) => sum + item.score, 0) / values.length;
    assert(mean(positives) > mean(negatives), '已标注的喜欢标题平均分高于不喜欢标题');
    const saved = await BiliPreferenceStore().get();
    assert(saved.revision === ready.revision && saved.format === 'token-transformer-64x4-v1', 'IndexedDB保存完整训练头');
    await service.setActive(false);
    assert(!(await service.status()).ready && !(await service.status()).training, '关闭会话终止Worker计算');
    await service.setActive(true);
    await waitReady(service);
    const restored = await service.score(items);
    assert(restored.scores.every((item, i) => Math.abs(item.score - scored.scores[i].score) < 1e-6), '新Worker恢复权重与评分完全一致');
    assert((await service.exportLabels()).labels.length === 31, '标注导出保留全部样本');
    await service.setActive(false);
    resultElement.textContent = JSON.stringify({ passed: checks.length, checks, scores: scored.scores, elapsedSeconds: (performance.now() - start) / 1000 });
  } catch (error) { resultElement.textContent = JSON.stringify({ error: error.message, checks, elapsedSeconds: (performance.now() - start) / 1000 }); }
})();
