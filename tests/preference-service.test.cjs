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
        const result = message.type === 'restore' ? { restored: true } : message.type === 'train' ? { checkpoint: { weights: { sample: [1] } } } : message.items.map(item => ({ ...item, score: 0.1 }));
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
test('标注、开启筛选和状态查询均不训练；手动训练后可恢复旧模型', async () => {
  const h = harness();
  await h.service.importLabels(labels(31));
  await h.service.setActive(true); await tick();
  assert.equal(h.workers.length, 0);
  await h.service.train(); await ready(h.service);
  assert.equal(h.workers[0].messages[0].type, 'train');
  await h.service.label({ id: '0', title: '新标题', rating: 3 });
  await h.service.setActive(false); await h.service.setActive(true); await ready(h.service);
  assert.equal(h.workers[1].messages[0].type, 'restore');
  assert.equal((await h.service.status()).pendingUpdate, true);
  assert.equal((await h.service.score([{ id: 'x', title: '新视频' }])).scores.length, 1);
  assert.equal(h.writes.length, 1);
});
test('手动训练无需筛选页面，关闭筛选不中断训练，日志记录进度和完成', async () => {
  const h = harness({ holdTraining: true });
  await assert.rejects(h.service.train(), /31/);
  await h.service.importLabels(labels(31));
  await h.service.train(); await tick();
  const worker = h.workers[0], original = worker.messages[0];
  worker.onmessage({ data: { type: 'progress', message: '训练：1 / 45 轮，损失 0.69' } });
  await h.service.label({ id: '0', title: '视频 0', rating: 3 });
  await h.service.setActive(false);
  assert.equal((await h.service.status()).training, true);
  await h.service.train();
  assert.equal(h.workers.length, 1);
  worker.complete(original); await tick(); await tick();
  const state = await h.service.status();
  assert.equal(state.training, false);
  assert.equal(state.hasModel, true);
  assert.equal(state.pendingUpdate, true);
  assert.equal(state.ready, false);
  assert.ok(worker.terminated);
  assert.match(state.logs.map(item => item.message).join('\n'), /开始手动训练.*\n.*损失.*\n.*训练完成/s);
  await h.service.setActive(true); await ready(h.service);
  await h.service.train(); await tick();
  h.workers.at(-1).complete(); await ready(h.service);
  assert.equal((await h.service.status()).pendingUpdate, false);
});
test('训练错误和清空取消记录在日志，半成品不保存', async () => {
  const h = harness({ holdTraining: true });
  await h.service.importLabels(labels(31)); await h.service.train(); await tick();
  const worker = h.workers[0];
  worker.onmessage({ data: { id: worker.messages[0].id, error: '下载失败' } });
  await tick();
  assert.equal(h.writes.length, 0);
  assert.match((await h.service.status()).logs.at(-1).message, /训练失败.*下载失败/);
  await h.service.train(); await tick();
  await h.service.reset();
  assert.equal(h.workers[1].terminated, true);
  assert.equal((await h.service.status()).hasModel, false);
  assert.match((await h.service.status()).logs.at(-1).message, /取消/);
});
