const test = require('node:test');
const assert = require('node:assert/strict');
const createService = require('../extension/preference-service.js');
const tick = () => new Promise(setImmediate);
function harness({ holdTraining = false, data } = {}) {
  const stored = data ? { preferenceData: data } : {};
  let checkpoint;
  const workers = [], writes = [];
  const storage = {
    async get(key) { return { [key]: stored[key] }; },
    async set(value) { Object.assign(stored, structuredClone(value)); }
  };
  const checkpoints = {
    async get() { return checkpoint; },
    async put(value) { checkpoint = structuredClone(value); writes.push(value); },
    async clear() { checkpoint = undefined; }
  };
  function createWorker() {
    const worker = { messages: [],
      postMessage(message) {
        this.messages.push(message);
        if (message.type === 'train' && holdTraining) return;
        queueMicrotask(() => this.complete(message));
      },
      complete(message = this.messages.at(-1)) {
        const result = message.type === 'train' ? { checkpoint: { weights: { sample: [1] } } } : message.items.map(item => ({ ...item, score: 0.1 }));
        this.onmessage({ data: { id: message.id, result } });
      },
      terminate() { this.terminated = true; }
    };
    workers.push(worker); return worker;
  }
  return { service: createService({ storage, checkpoints, createWorker }), storage, checkpoints, stored, workers, writes, createWorker };
}
const labels = count => Array.from({ length: count }, (_, i) => ({ id: String(i), title: '视频 ' + i, rating: i % 4 }));
async function ready(service) {
  for (let i = 0; i < 40; i++) { await tick(); const s = await service.status(); if (s.ready) return s; }
  throw new Error('模型未就绪');
}
test('默认和前30条不创建Worker，31条后训练；重开恢复已保存版本', async () => {
  const h = harness();
  await h.service.importLabels({ labels: labels(30) });
  await h.service.setActive(true);
  await tick();
  assert.equal(h.workers.length, 0);
  await h.service.label({ id: '31', title: '第31个', rating: 3 });
  const state = await ready(h.service);
  assert.equal(state.count, 31);
  assert.equal(h.workers.length, 1);
  assert.equal(h.writes.length, 1);
  const scores = await h.service.score([{ id: 'a', title: '新标题' }]);
  assert.equal(scores.scores[0].score, 0.1);
  await h.service.setActive(false);
  assert.ok(h.workers[0].terminated);
  const restored = createService({ storage: h.storage, checkpoints: h.checkpoints, createWorker: h.createWorker });
  assert.equal((await restored.status()).ready, false);
  assert.equal(h.workers.length, 1);
  await restored.setActive(true);
  assert.equal((await ready(restored)).revision, state.revision);
  assert.ok(h.workers.at(-1).messages[0].checkpoint);
  assert.equal((await restored.exportLabels()).labels.length, 31);
});
test('修改标注不发布旧训练版本，重复相同评级不触发训练', async () => {
  const h = harness({ holdTraining: true });
  await h.service.importLabels({ labels: labels(31) });
  await h.service.setActive(true); await tick();
  const original = h.workers[0].messages[0];
  await h.service.label({ id: '0', title: '视频 0', rating: 3 });
  h.workers[0].complete(original); await tick();
  assert.equal(h.writes.length, 0);
  assert.equal(h.workers[0].messages.length, 2);
  h.workers[0].complete(); await ready(h.service);
  const count = h.workers[0].messages.length;
  await h.service.label({ id: '0', title: '视频 0', rating: 3 }); await tick();
  assert.equal(h.workers[0].messages.length, count);
  assert.equal(h.writes.length, 1);
});
test('关闭页面中断训练，不保存半成品；再次开启可训练，清空保留基础缓存', async () => {
  const h = harness({ holdTraining: true });
  await h.service.importLabels(labels(31));
  await h.service.setActive(true); await tick();
  await h.service.setActive(false); await tick();
  assert.equal(h.writes.length, 0);
  assert.equal((await h.service.status()).training, false);
  await h.service.setActive(true); await tick();
  assert.equal(h.workers.length, 2);
  h.workers[1].complete(); await ready(h.service);
  await h.service.reset();
  assert.equal((await h.service.status()).count, 0);
  assert.equal(await h.checkpoints.get(), undefined);
  assert.equal(h.workers[1].terminated, true);
});
test('导入合并评级、验证文件并持久化，标签更新时丢弃旧推理结果', async () => {
  const h = harness();
  await h.service.importLabels(labels(31)); await h.service.setActive(true); await ready(h.service);
  const worker = h.workers[0];
  worker.postMessage = function (message) { this.messages.push(message); };
  const pending = h.service.score([{ id: 'x', title: '旧标题' }]); await tick();
  const scoring = worker.messages.at(-1);
  await h.service.label({ id: '0', title: '视频 0', rating: 3 });
  worker.complete(scoring);
  assert.equal((await pending).scores.length, 0);
  await assert.rejects(h.service.importLabels({ labels: [{ id: 'x', title: '无效', rating: 8 }] }), /无效/);
  assert.equal((await h.service.exportLabels()).labels.length, 31);
});
