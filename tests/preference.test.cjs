const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

function harness({ enabled = true, count = 31, native = false, automatic = false, fail = false, recycleBeforeFeedback = false } = {}) {
  const dom = new JSDOM(`<!doctype html><body><div class="feed-card"><div class="bili-video-card" id="low">
    <a class="bili-video-card__info--tit" href="/video/BVlow" title="低分视频">低分视频</a>
    ${native ? '<button class="bili-video-card__info--more">⋮</button><div class="bili-video-card__info--more-panel" hidden><button class="native-negative">不感兴趣</button><button class="native-report">举报</button></div>' : ""}
    </div></div><div class="bili-video-card" id="high"><a class="bili-video-card__info--tit" href="/video/BVhigh" title="高分视频">高分视频</a></div></body>`, { url: "https://www.bilibili.com/", runScripts: "outside-only", pretendToBeVisual: true });
  const requests = [];
  const storageListeners = [];
  const messageListeners = [];
  let pageId;
  let nativeClicks = 0;
  let reportClicks = 0;
  let state = { count, ready: count >= 31, modelVersion: 1, revision: 1, message: "测试状态" };
  let settings = { filterAds: false, preferenceEnabled: enabled, preferenceFeedbackEnabled: automatic, preferenceThreshold: 0.35, preferenceFeedbackThreshold: 0.08 };
  if (native) {
    dom.window.document.querySelector(".bili-video-card__info--more").addEventListener("click", () => {
      const panel = dom.window.document.querySelector(".bili-video-card__info--more-panel"); panel.hidden = !panel.hidden;
    });
    dom.window.document.querySelector(".native-negative").addEventListener("click", () => { nativeClicks++; });
    dom.window.document.querySelector(".native-report").addEventListener("click", () => { reportClicks++; });
  }
  dom.window.browser = {
    storage: { onChanged: { addListener(fn) { storageListeners.push(fn); } } },
    runtime: {
      onMessage: { addListener(fn) { messageListeners.push(fn); } },
      async sendMessage(message) {
        requests.push(message);
        if (message.type === "preferencePageReady") { pageId = message.pageId; return { ...settings, preferenceEnabled: false }; }
        if (message.type === "getSettings") return settings;
        if (message.type === "subtitleStatus") return { busy: false, message: "" };
        if (message.type === "recordFilters") return { ok: true };
        if (message.type === "claimPreferenceFeedback") {
          if (recycleBeforeFeedback) {
            const title = dom.window.document.querySelector("#low a");
            title.href = "/video/BVchanged"; title.title = "已更换的视频";
          }
          return { allowed: true };
        }
        if (message.type === "preferenceStatus") { if (fail) throw new Error("服务不可用"); return state; }
        if (message.type === "preferenceScore") return { ...state, scores: message.items.map(item => ({ ...item, score: item.title.includes("低分") ? 0.02 : 0.9 })) };
        if (message.type === "preferenceLabel") { state = { ...state, count: state.count + 1, ready: false }; return state; }
        throw new Error("unexpected message " + message.type);
      }
    }
  };
  for (const file of ["shared.js", "preference.js", "content.js"]) dom.window.eval(fs.readFileSync(path.join(__dirname, "../extension", file), "utf8"));
  if (enabled) Promise.resolve().then(() => Promise.resolve()).then(() => {
    for (const fn of messageListeners) fn({ type: "preferenceSession", pageId, enabled: true });
  });
  return { dom, requests,
    activate(enabled) { for (const fn of messageListeners) fn({ type: "preferenceSession", pageId, enabled }); },
    nativeClicks: () => nativeClicks, reportClicks: () => reportClicks,
    configure(update) {
      settings = { ...settings, ...update };
      if ("preferenceEnabled" in update) for (const fn of messageListeners) fn({ type: "preferenceSession", pageId, enabled: update.preferenceEnabled });
      for (const fn of storageListeners) fn({ settings: { newValue: settings } }, "local");
    },
    close() { dom.window.close(); }
  };
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test("实验功能默认关闭，不添加标注按钮、不请求偏好模型", async () => {
  const h = harness({ enabled: false });
  try {
    await wait(550);
    assert.equal(h.dom.window.document.querySelector(".bili-assistant-preference-trigger"), null);
    assert.ok(!h.requests.some(m => ["preferenceStatus", "preferenceScore", "preferenceLabel"].includes(m.type)));
    assert.equal(h.dom.window.document.querySelectorAll(".bili-assistant-hidden").length, 0);
  } finally { h.close(); }
});

test("30 条只收集标注、不推理；四级评级按正确数值保存", async () => {
  const h = harness({ count: 30 });
  try {
    await wait(550);
    assert.ok(!h.requests.some(m => m.type === "preferenceScore"));
    assert.equal(h.dom.window.document.querySelectorAll(".bili-assistant-hidden").length, 0);
    h.dom.window.document.querySelector("#low .bili-assistant-preference-trigger").click();
    const menu = h.dom.window.document.querySelector("#bili-assistant-preference-menu");
    assert.equal(menu.hidden, false);
    assert.deepEqual([...menu.querySelectorAll("button")].map(b => b.textContent), ["很喜欢", "喜欢", "不喜欢", "很不喜欢"]);
    menu.querySelector('[data-rating="2"]').click();
    await new Promise(setImmediate);
    const label = h.requests.find(m => m.type === "preferenceLabel");
    assert.equal(label.rating, 2);
    assert.equal(label.id, "https://www.bilibili.com/video/BVlow");
    assert.equal(label.title, "低分视频");
  } finally { h.close(); }
});

test("31 条后隐藏低分标题并记录历史，高分保留；关闭后全部恢复", async () => {
  const h = harness();
  try {
    await wait(900);
    const doc = h.dom.window.document;
    assert.ok(doc.querySelector("#low").closest(".feed-card").classList.contains("bili-assistant-hidden"));
    assert.ok(!doc.querySelector("#high").classList.contains("bili-assistant-hidden"));
    assert.ok(h.requests.some(m => m.type === "recordFilters" && m.records.some(r => r.reason === "偏好模型" && r.score === 0.02)));
    assert.ok(!h.requests.some(m => m.type === "claimPreferenceFeedback"), "自动反馈默认关闭");
    h.configure({ preferenceEnabled: false });
    await wait(230);
    assert.equal(doc.querySelectorAll(".bili-assistant-hidden").length, 0);
  } finally { h.close(); }
});

test("原生三点菜单追加四级标注，保留原有不感兴趣选项", async () => {
  const h = harness({ count: 0, native: true });
  try {
    await wait(250);
    h.dom.window.document.querySelector(".bili-video-card__info--more").click();
    await wait(150);
    const panel = h.dom.window.document.querySelector(".bili-video-card__info--more-panel");
    assert.ok(panel.querySelector("#bili-assistant-preference-menu"));
    assert.ok(panel.querySelector(".native-negative"));
    panel.querySelector('[data-rating="0"]').click();
    await new Promise(setImmediate);
    assert.equal(h.requests.find(m => m.type === "preferenceLabel").rating, 0);
    assert.equal(h.nativeClicks(), 0);
    assert.equal(h.reportClicks(), 0);
  } finally { h.close(); }
});

test("显式开启自动反馈后只点击明确的不感兴趣，不点击举报", async () => {
  const h = harness({ native: true, automatic: true });
  try {
    await wait(1000);
    assert.equal(h.nativeClicks(), 1);
    assert.equal(h.reportClicks(), 0);
    assert.ok(h.requests.some(m => m.type === "claimPreferenceFeedback"));
  } finally { h.close(); }
});

test("本地服务不可用时保留所有视频，展示错误", async () => {
  const h = harness({ fail: true });
  try {
    await wait(650);
    assert.equal(h.dom.window.document.querySelectorAll(".bili-assistant-hidden").length, 0);
    assert.match(h.dom.window.document.querySelector(".bili-assistant-preference-status").textContent, /保持可见/);
  } finally { h.close(); }
});

test("虚拟列表复用卡片时，不对已更换的视频提交旧评分反馈", async () => {
  const h = harness({ native: true, automatic: true, recycleBeforeFeedback: true });
  try {
    await wait(950);
    assert.ok(h.requests.some(m => m.type === "claimPreferenceFeedback"));
    assert.equal(h.nativeClicks(), 0);
    assert.equal(h.reportClicks(), 0);
  } finally { h.close(); }
});

test("持久化设置即使含旧开启状态，重开页面仍需手动开启", async () => {
  const h = harness({ enabled: false });
  try {
    // 模拟新版加载时旧版本设置仍保存为 true，仅 configure 不应激活会话。
    h.dom.window.BiliPreferences.configure({ preferenceEnabled: true });
    await wait(500);
    assert.equal(h.dom.window.BiliPreferences.isEnabled(), false);
    assert.ok(!h.requests.some(m => m.type === "preferenceStatus"));
    h.activate(true);
    await wait(700);
    assert.equal(h.dom.window.BiliPreferences.isEnabled(), true);
    assert.ok(h.requests.some(m => m.type === "preferenceScore"));
  } finally { h.close(); }
});
