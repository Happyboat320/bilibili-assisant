const test = require("node:test");
const assert = require("node:assert/strict");
const data = require("./fixtures/preference_titles.json");

test("模拟偏好数据严格为150个唯一标题，120训练30测试，无泄漏", () => {
  assert.equal(data.length, 150);
  assert.equal(new Set(data.map(item => item.title)).size, 150);
  const train = data.filter(item => item.split === "train");
  const holdout = data.filter(item => item.split === "test");
  assert.equal(train.length, 120);
  assert.equal(holdout.length, 30);
  assert.equal(holdout.filter(item => item.liked).length, 15);
  for (const category of new Set(data.map(item => item.category))) {
    assert.equal(train.filter(item => item.category === category).length, 20);
    assert.equal(holdout.filter(item => item.category === category).length, 5);
  }
  for (let size = 20; size <= 120; size += 10) {
    const liked = train.slice(0, size).filter(item => item.liked).length;
    assert.ok(Math.abs(liked - size / 2) <= 3);
  }
  assert.ok(data.every(item => item.liked === ["访谈", "硬核", "户外"].includes(item.category)));
});

test("真实偏好基准报告包含20–120全部梯度和固定30测试的三个种子预测", () => {
  const report = require("../reports/preference-benchmark/results.json");
  const predictions = require("../reports/preference-benchmark/predictions.json");
  assert.equal(report.train_count, 120);
  assert.equal(report.test_count, 30);
  assert.equal(report.device, "cpu");
  assert.match(report.embedding_model, /multilingual-MiniLM/);
  assert.equal(report.results.length, 11);
  assert.deepEqual(report.results.map(row => row.training_samples), Array.from({ length: 11 }, (_, i) => 20 + i * 10));
  assert.equal(predictions.length, 11 * 3 * 30);
  const testIds = new Set(data.filter(item => item.split === "test").map(item => item.id));
  for (const row of report.results) {
    assert.equal(row.production_enabled, row.training_samples > 30);
    assert.equal(row.runs.length, 3);
    assert.ok(row.accuracy >= 0 && row.accuracy <= 1);
    for (const seed of report.seeds) {
      const batch = predictions.filter(item => item.training_samples === row.training_samples && item.seed === seed);
      assert.equal(batch.length, 30);
      assert.ok(batch.every(item => testIds.has(item.id) && item.score >= 0 && item.score <= 1));
    }
  }
});
