const test = require('node:test');
const assert = require('node:assert/strict');

function feature(sign, length = 3, dimension = 384) {
  return Float32Array.from({ length: length * dimension }, (_, i) => sign * (0.25 + (i % 7) / 10));
}
test('token Transformer 掩码隔离 padding，保存重载保持评分且释放张量', async () => {
  const tf = await import('@tensorflow/tfjs');
  const { cpuReady, PreferenceHead, packFeatures } = await import('../src/preference-head.mjs');
  await cpuReady();
  const initial = tf.memory().numTensors;
  const head = new PreferenceHead();
  const one = feature(1, 2), two = feature(-1, 5);
  const alone = await head.predict([one]);
  const together = await head.predict([one, two]);
  assert.ok(Math.abs(alone[0] - together[0]) < 1e-6, '短标题评分不受另一标题 padding 长度影响');
  const { embeddings, mask } = packFeatures([one, two]);
  const changed = tf.tidy(() => embeddings.add(tf.scalar(1).sub(mask).expandDims(-1).mul(1000)));
  const logits = head.forward(changed, mask);
  const score = tf.sigmoid(logits);
  assert.ok(Math.abs((await score.data())[0] - alone[0]) < 1e-6, 'padding 内容不影响 CLS');
  score.dispose(); logits.dispose(); changed.dispose(); embeddings.dispose(); mask.dispose();
  const restored = new PreferenceHead(await head.serialize());
  assert.deepEqual(await restored.predict([one, two]), together);
  restored.dispose(); head.dispose();
  assert.equal(tf.memory().numTensors, initial);
});

test('真实反向传播训练全部 Transformer 参数，损失下降、评级可分且无张量泄漏', async () => {
  const tf = await import('@tensorflow/tfjs');
  const { cpuReady, fitHead } = await import('../src/preference-head.mjs');
  await cpuReady();
  const initial = tf.memory().numTensors;
  const features = Array.from({ length: 32 }, (_, i) => feature(i < 16 ? -1 : 1, 2 + i % 4));
  const ratings = features.map((_, i) => i < 16 ? 0 : 3);
  const result = await fitHead(features, ratings, { epochs: 15 });
  assert.ok(result.losses.at(-1) < result.losses[0] * 0.6, JSON.stringify(result.losses));
  const scores = await result.head.predict([feature(-1), feature(1)]);
  assert.ok(scores[0] < 0.3 && scores[1] > 0.7, JSON.stringify(scores));
  result.head.dispose();
  assert.equal(tf.memory().numTensors, initial);
});

test('训练取消不发布半成品并释放优化器与权重', async () => {
  const tf = await import('@tensorflow/tfjs');
  const { cpuReady, fitHead } = await import('../src/preference-head.mjs');
  await cpuReady();
  const initial = tf.memory().numTensors;
  await assert.rejects(fitHead([feature(1)], [3], { shouldContinue: () => false }), /暂停/);
  assert.equal(tf.memory().numTensors, initial);
});

test('与原 PyTorch 训练头的前向输出、BCE 损失和全部参数梯度一致', async () => {
  const tf = await import('@tensorflow/tfjs');
  const { cpuReady, PreferenceHead, packFeatures } = await import('../src/preference-head.mjs');
  const expected = require('./fixtures/preference-head-parity.json');
  await cpuReady();
  const initial = tf.memory().numTensors;
  const head = new PreferenceHead();
  for (const [name, variable] of Object.entries(head.params)) {
    const normWeight = name === 'norm1W' || name === 'norm2W' || name === 'mlpNormW';
    tf.tidy(() => variable.assign(tf.tensor(Float32Array.from({ length: variable.size }, (_, i) => ((i % 13) - 6) * 0.02 + Number(normWeight)), variable.shape)));
  }
  const features = [2, 5].map(length => Float32Array.from({ length: length * 384 }, (_, i) => ((i % 17) - 8) * 0.05));
  const { embeddings, mask } = packFeatures(features);
  const logits = head.forward(embeddings, mask);
  const values = await logits.data();
  values.forEach((value, i) => assert.ok(Math.abs(value - expected.logits[i]) < 1e-5, `logits ${i}: ${value}`));
  const targets = tf.tensor1d([0, 1]);
  const { value: loss, grads } = tf.variableGrads(() => {
    const output = head.forward(embeddings, mask);
    return tf.logSumExp(tf.stack([tf.zerosLike(output), output]), 0).sub(output.mul(targets)).mean();
  }, Object.values(head.params));
  assert.ok(Math.abs((await loss.data())[0] - expected.loss) < 1e-5);
  for (const [name, variable] of Object.entries(head.params)) {
    const gradient = await grads[variable.name].data();
    [0, Math.min(7, gradient.length - 1), gradient.length - 1].forEach((index, i) => {
      assert.ok(Math.abs(gradient[index] - expected.gradientSamples[name][i]) < 2e-5, `gradient ${name}[${index}]: ${gradient[index]} / ${expected.gradientSamples[name][i]}`);
    });
  }
  Object.values(grads).forEach(g => g.dispose());
  loss.dispose(); targets.dispose(); logits.dispose(); embeddings.dispose(); mask.dispose(); head.dispose();
  assert.equal(tf.memory().numTensors, initial);
});
