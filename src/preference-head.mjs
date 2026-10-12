/* 与原 PyTorch PreferenceHead 对应的可训练 token Transformer，CPU 自动微分。 */
import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-cpu';

export const HEAD_CONFIG = Object.freeze({ dimension: 384, hidden: 64, heads: 4, feedforward: 128, maxTokens: 48, dropout: 0.15 });
export async function cpuReady() { await tf.setBackend('cpu'); await tf.ready(); }
function random(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
}
export class PreferenceHead {
  constructor({ dimension = 384, seed = 42, weights } = {}) {
    this.dimension = dimension;
    this.seed = seed;
    this.dropoutStep = 0;
    this.params = {};
    const rng = random(seed);
    const variable = (name, shape, kind = 'zero', fanIn = shape[0]) => {
      const count = shape.reduce((a, b) => a * b, 1);
      let values = new Float32Array(count);
      if (kind === 'one') values.fill(1);
      if (kind === 'uniform') for (let i = 0; i < count; i++) values[i] = (rng() * 2 - 1) / Math.sqrt(fanIn);
      if (kind === 'normal') for (let i = 0; i < count; i++) values[i] = Math.sqrt(-2 * Math.log(Math.max(rng(), 1e-9))) * Math.cos(2 * Math.PI * rng()) * 0.02;
      if (weights) {
        if (!weights[name] || weights[name].length !== count || !weights[name].every(Number.isFinite)) throw new Error(`训练权重无效：${name}`);
        values = Float32Array.from(weights[name]);
      }
      this.params[name] = tf.tidy(() => tf.variable(tf.tensor(values, shape)));
    };
    try {
      variable('projectW', [dimension, 64], 'uniform'); variable('projectB', [64], 'uniform', dimension);
      variable('cls', [1, 1, 64]); variable('position', [1, 49, 64], 'normal');
      for (const name of ['norm1', 'norm2', 'mlpNorm']) { variable(name + 'W', [64], 'one'); variable(name + 'B', [64]); }
      variable('qkvW', [64, 192], 'uniform', (64 + 192) / 6); variable('qkvB', [192]);
      variable('attentionW', [64, 64], 'uniform'); variable('attentionB', [64]);
      variable('ff1W', [64, 128], 'uniform'); variable('ff1B', [128], 'uniform', 64);
      variable('ff2W', [128, 64], 'uniform'); variable('ff2B', [64], 'uniform', 128);
      variable('mlp1W', [64, 32], 'uniform'); variable('mlp1B', [32], 'uniform', 64);
      variable('mlp2W', [32, 1], 'uniform'); variable('mlp2B', [1], 'uniform', 32);
    } catch (error) { this.dispose(); throw error; }
  }
  dense(x, name) {
    const shape = x.shape;
    return tf.matMul(x.reshape([-1, shape.at(-1)]), this.params[name + 'W']).add(this.params[name + 'B'])
      .reshape([...shape.slice(0, -1), this.params[name + 'B'].shape[0]]);
  }
  norm(x, name) {
    const { mean, variance } = tf.moments(x, -1, true);
    return x.sub(mean).div(variance.add(1e-5).sqrt()).mul(this.params[name + 'W']).add(this.params[name + 'B']);
  }
  dropout(x, training) { return training ? tf.dropout(x, 0.15, undefined, this.seed + ++this.dropoutStep) : x; }
  forward(embeddings, mask, training = false) {
    return tf.tidy(() => {
      const [batch, tokens] = embeddings.shape;
      const length = tokens + 1;
      let x = tf.concat([this.params.cls.tile([batch, 1, 1]), this.dense(embeddings, 'project')], 1)
        .add(this.params.position.slice([0, 0, 0], [1, length, 64]));
      const valid = tf.concat([tf.ones([batch, 1]), mask], 1);
      const normalized = this.norm(x, 'norm1');
      const qkv = this.dense(normalized, 'qkv');
      const [q, k, v] = tf.split(qkv, 3, -1).map(tensor => tensor.reshape([batch, length, 4, 16]).transpose([0, 2, 1, 3]));
      const scores = tf.matMul(q, k, false, true).div(4).add(tf.scalar(1).sub(valid).mul(-1e9).reshape([batch, 1, 1, length]));
      const attended = tf.matMul(this.dropout(tf.softmax(scores, -1), training), v).transpose([0, 2, 1, 3]).reshape([batch, length, 64]);
      x = x.add(this.dropout(this.dense(attended, 'attention'), training));
      const ff = this.dense(this.dropout(tf.relu(this.dense(this.norm(x, 'norm2'), 'ff1')), training), 'ff2');
      x = x.add(this.dropout(ff, training));
      const cls = this.norm(x.slice([0, 0, 0], [batch, 1, 64]).reshape([batch, 64]), 'mlpNorm');
      const hidden = this.dense(cls, 'mlp1');
      const gelu = hidden.mul(0.5).mul(tf.erf(hidden.div(Math.sqrt(2))).add(1));
      return this.dense(this.dropout(gelu, training), 'mlp2').reshape([batch]);
    });
  }
  async predict(features) {
    const { embeddings, mask } = packFeatures(features, this.dimension);
    try {
      const output = tf.tidy(() => tf.sigmoid(this.forward(embeddings, mask)));
      try { return Array.from(await output.data()); } finally { output.dispose(); }
    } finally { embeddings.dispose(); mask.dispose(); }
  }
  async serialize() {
    const weights = {};
    for (const [name, value] of Object.entries(this.params)) weights[name] = Array.from(await value.data());
    return { dimension: this.dimension, weights };
  }
  dispose() { Object.values(this.params).forEach(value => value.dispose()); }
}
export function packFeatures(features, dimension = 384) {
  if (!features.length) throw new Error('没有标题特征。');
  const lengths = features.map(f => f.length / dimension);
  if (lengths.some(n => !Number.isInteger(n) || n < 1 || n > 48)) throw new Error('标题 token 特征长度无效。');
  const length = Math.max(...lengths);
  const values = new Float32Array(features.length * length * dimension);
  const masks = new Float32Array(features.length * length);
  features.forEach((feature, i) => {
    if (!feature.every(Number.isFinite)) throw new Error('标题特征含无效数值。');
    values.set(feature, i * length * dimension);
    masks.fill(1, i * length, i * length + lengths[i]);
  });
  return { embeddings: tf.tensor3d(values, [features.length, length, dimension]), mask: tf.tensor2d(masks, [features.length, length]) };
}
export async function fitHead(features, ratings, { epochs = 45, seed = 42, dimension = 384, onProgress = () => {}, shouldContinue = () => true } = {}) {
  await cpuReady();
  const head = new PreferenceHead({ dimension, seed });
  const optimizer = tf.train.adam(0.001, 0.9, 0.999, 1e-8);
  const rng = random(seed);
  const variables = Object.values(head.params);
  const names = Object.keys(head.params);
  const losses = [];
  try {
    for (let epoch = 0; epoch < epochs; epoch++) {
      const order = features.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      let epochLoss = 0;
      for (let offset = 0; offset < order.length; offset += 32) {
        if (!shouldContinue()) throw new Error('偏好训练已暂停。');
        const indices = order.slice(offset, offset + 32);
        const { embeddings, mask } = packFeatures(indices.map(i => features[i]), dimension);
        const targets = tf.tensor1d(indices.map(i => ratings[i] / 3));
        let grads, loss;
        try {
          ({ value: loss, grads } = tf.variableGrads(() => {
            const logits = head.forward(embeddings, mask, true);
            // BCEWithLogits：softplus 使用 logSumExp 保持数值稳定及零点梯度正确。
            return tf.logSumExp(tf.stack([tf.zerosLike(logits), logits]), 0).sub(logits.mul(targets)).mean();
          }, variables));
          const lossValue = (await loss.data())[0];
          if (!Number.isFinite(lossValue)) throw new Error('训练损失无效。');
          epochLoss += lossValue * indices.length;
          tf.tidy(() => {
            const norm = tf.addN(Object.values(grads).map(g => g.square().sum())).sqrt();
            const scale = tf.minimum(tf.scalar(1), tf.scalar(1).div(norm.add(1e-6)));
            const clipped = {};
            for (const name of names) clipped[head.params[name].name] = grads[head.params[name].name].mul(scale);
            // PyTorch AdamW 的解耦权重衰减先作用于参数，再应用 Adam 更新。
            for (const variable of variables) variable.assign(variable.mul(1 - 0.001 * 0.05));
            optimizer.applyGradients(clipped);
          });
        } finally {
          embeddings.dispose(); mask.dispose(); targets.dispose(); loss?.dispose();
          if (grads) Object.values(grads).forEach(g => g.dispose());
        }
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      losses.push(epochLoss / features.length);
      onProgress({ epoch: epoch + 1, epochs, loss: losses.at(-1) });
    }
    return { head, losses };
  } catch (error) { head.dispose(); throw error; }
  finally { optimizer.dispose(); }
}
