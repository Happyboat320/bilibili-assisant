/* 模拟浏览器解码和模型结果，验证内置服务的音轨处理、排队与取消。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function harness({ hold = false, failFirst = false, decodeDuration = 1, contentLength = 3 } = {}) {
  const calls = [], workers = [], decoded = [];
  class AudioContext {
    constructor(options) { assert.equal(options.sampleRate, 16000); }
    async decodeAudioData(bytes) {
      decoded.push(bytes);
      return { length: 16000, duration: decodeDuration, numberOfChannels: 2,
        getChannelData(channel) { return new Float32Array(16000).fill(channel ? 0.5 : -0.25); } };
    }
    async close() {}
  }
  class Worker {
    constructor(url, options) { workers.push(this); assert.equal(options.type, 'module'); }
    postMessage(data, transfer) {
      assert.equal(data.audio.length, 16000);
      assert.equal(data.audio[0], 0.125, '立体声应平均为单声道');
      assert.equal(transfer[0], data.audio.buffer);
      if (!hold) queueMicrotask(() => this.complete());
    }
    complete() { this.onmessage({ data: { type: 'done', cues: [{ from: 0, to: 1, content: '你好 world' }] } }); }
    terminate() { this.terminated = true; }
  }
  const ctx = vm.createContext({ URL, AudioContext, Worker, AbortController, AbortSignal, Float32Array, Uint8Array, Number,
    browser: { runtime: { getURL: path => 'moz-extension://test/' + path } },
    async fetch(url, options) {
      calls.push({ url, options });
      if (failFirst && calls.length === 1) throw new TypeError('CDN failed');
      const response = new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-length': String(contentLength) } });
      Object.defineProperty(response, 'url', { value: url });
      return response;
    } });
  vm.runInContext(fs.readFileSync(require.resolve('../extension/speech.js'), 'utf8'), ctx);
  return { service: ctx.BiliSpeech, calls, workers, decoded };
}
const payload = { urls: ['https://test.bilivideo.com/a'], model: 'small', language: 'auto', duration: 100 };
const tick = () => new Promise(setImmediate);

test('内置识别下载备用音轨、16k单声道解码并释放Worker，不发送Cookie', async () => {
  const h = harness({ failFirst: true });
  const result = await h.service.transcribe(1, { ...payload, urls: [...payload.urls, 'https://backup.bilivideo.cn/a'] }, () => {});
  assert.equal(result.cues[0].content, '你好 world');
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(call => call.options.credentials === 'omit'));
  assert.ok(h.workers[0].terminated);
});

test('拒绝非B站音轨和超长视频，解码后再次验证时长', async () => {
  const h = harness();
  await assert.rejects(h.service.transcribe(1, { ...payload, urls: ['https://evil.example/a'] }, () => {}), /B 站 HTTPS/);
  assert.equal(h.calls.length, 0);
  await assert.rejects(h.service.transcribe(2, { ...payload, duration: 10801 }, () => {}), /3 小时/);
  assert.equal(h.calls.length, 0);
  const tooLong = harness({ decodeDuration: 10801 });
  await assert.rejects(tooLong.service.transcribe(1, payload, () => {}), /3 小时/);
  assert.equal(tooLong.workers.length, 0);
});

test('超过30分钟和恰好3小时的音轨可识别，仍拒绝超过256MiB的文件', async () => {
  for (const duration of [1801, 10800]) {
    const h = harness({ decodeDuration: duration });
    const result = await h.service.transcribe(1, { ...payload, duration }, () => {});
    assert.equal(result.cues[0].content, '你好 world');
  }
  const oversized = harness({ contentLength: 256 * 1024 * 1024 + 1 });
  await assert.rejects(oversized.service.transcribe(1, payload, () => {}), /256 MiB/);
  assert.equal(oversized.decoded.length, 0);
});

test('串行识别、队列上限与关闭页面取消，不阻塞后续任务', async () => {
  const h = harness({ hold: true });
  const one = h.service.transcribe(1, payload, () => {});
  const canceled = assert.rejects(one, /已关闭/);
  const two = h.service.transcribe(2, payload, () => {});
  const three = h.service.transcribe(3, payload, () => {});
  await assert.rejects(h.service.transcribe(4, payload, () => {}), /队列已满/);
  await assert.rejects(h.service.transcribe(1, payload, () => {}), /已有字幕/);
  await tick();
  assert.equal(h.workers.length, 1);
  h.service.cancel(1);
  await canceled;
  await tick();
  assert.ok(h.workers[0].terminated);
  assert.equal(h.workers.length, 2);
  h.workers[1].complete();
  await two;
  await tick();
  h.workers[2].complete();
  await three;
});
