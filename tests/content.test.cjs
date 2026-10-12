const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

test("动态卡片过滤、网格隐藏及关闭恢复，不会隐藏未知时长的视频", async () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div class="feed-card" id="short"><div class="bili-video-card"><a class="bili-video-card__info--tit">普通视频</a><span class="bili-video-card__stats__duration">00:30</span></div></div>
    <div class="feed-card" id="unknown"><div class="bili-video-card"><a class="bili-video-card__info--tit">未知时长</a></div></div>
    <div class="feed-card" id="advert"><div class="bili-video-card"><span class="ad-label">广告</span></div></div>
  </body>`, { url: "https://www.bilibili.com/", runScripts: "outside-only" });
  let storageListener;
  let messageListener;
  const reports = [];
  dom.window.browser = {
    runtime: {
      async sendMessage(message) {
        if (message.type === "recordFilters") { reports.push(message.records); return { ok: true }; }
        return message.type === "getSettings" ? { filterAds: true, filterDuration: true, minDuration: 60 } : { busy: false, message: "" };
      },
      onMessage: { addListener(fn) { messageListener = fn; } }
    },
    storage: { onChanged: { addListener(fn) { storageListener = fn; } } }
  };
  const load = file => dom.window.eval(fs.readFileSync(path.join(__dirname, "../extension", file), "utf8"));
  const waitScan = () => new Promise(resolve => setTimeout(resolve, 240));
  try {
    load("shared.js"); load("content.js");
    await waitScan();
    assert.ok(dom.window.document.querySelector("#short").classList.contains("bili-assistant-hidden"));
    assert.ok(dom.window.document.querySelector("#advert").classList.contains("bili-assistant-hidden"));
    assert.ok(!dom.window.document.querySelector("#unknown").classList.contains("bili-assistant-hidden"));
    assert.equal(reports.flat().length, 2);
    dom.window.document.body.insertAdjacentHTML("beforeend", '<div class="bili-video-card" id="new"><a class="bili-video-card__info--tit" title="剧透">剧透</a><span class="bili-video-card__stats__duration">02:00</span></div>');
    storageListener({ settings: { newValue: { filterAds: true, filterDuration: true, minDuration: 60, filterKeywords: true, keywords: "剧透" } } }, "local");
    await waitScan();
    assert.ok(dom.window.document.querySelector("#new").classList.contains("bili-assistant-hidden"));
    assert.equal((await messageListener({ type: "filterCount" })).count, 3);
    assert.equal(reports.flat().length, 3, "重复扫描不重复写入历史");
    // 修改卡片标题后也应重新匹配，不保留旧的过滤结果。
    dom.window.document.querySelector("#new a").setAttribute("title", "普通视频");
    await waitScan();
    assert.ok(!dom.window.document.querySelector("#new").classList.contains("bili-assistant-hidden"));
    storageListener({ settings: { newValue: { filterAds: false, filterDuration: false, filterKeywords: false } } }, "local");
    await waitScan();
    assert.equal(dom.window.document.querySelectorAll(".bili-assistant-hidden").length, 0);
  } finally { dom.window.close(); }
});

test("字幕预览按来源显示时间按钮，跳转播放器，切换分 P 清除旧字幕", async () => {
  const dom = new JSDOM("<!doctype html><body><video></video></body>", { url: "https://www.bilibili.com/video/BV1xx?p=1", runScripts: "outside-only" });
  let receive;
  let navigationTick;
  const requests = [];
  dom.window.setInterval = fn => { navigationTick = fn; return 1; };
  dom.window.browser = {
    runtime: {
      async sendMessage(message) {
        requests.push(message);
        return message.type === "getSettings" ? {} : { busy: false, message: "" };
      },
      onMessage: { addListener(fn) { receive = fn; } }
    },
    storage: { onChanged: { addListener() {} } }
  };
  const load = file => dom.window.eval(fs.readFileSync(path.join(__dirname, "../extension", file), "utf8"));
  try {
    load("shared.js"); load("content.js");
    await new Promise(resolve => setTimeout(resolve, 20));
    const doc = dom.window.document;
    doc.querySelector('[data-action="preview"]').click();
    await new Promise(setImmediate);
    assert.ok(requests.some(m => m.type === "extractSubtitles" && m.action === "preview"));
    const state = { videoKey: "https://www.bilibili.com/video/BV1xx?p=1", source: "builtin", busy: false,
      cues: [{ from: 42.5, to: 45, content: "<img src=x onerror=alert(1)>你好 world" }], message: "就绪" };
    receive({ type: "subtitleStatus", state });
    const preview = doc.querySelector("#bili-assistant-preview");
    assert.equal(preview.hidden, false);
    assert.match(preview.textContent, /你好 world/);
    assert.equal(preview.querySelector("img"), null, "字幕必须作为文字渲染");
    preview.querySelector(".bili-assistant-cue button").click();
    assert.equal(doc.querySelector("video").currentTime, 42.5);
    assert.equal(doc.querySelector("video").paused, true, "跳转不改变暂停状态");
    receive({ type: "subtitleStatus", state: { ...state, source: "local" } });
    assert.equal(preview.querySelector(".bili-assistant-cue button"), null);
    doc.querySelector('[data-action="copy"]').click();
    doc.querySelector('[data-action="download"]').click();
    await new Promise(setImmediate);
    assert.ok(requests.some(m => m.action === "copy"));
    assert.ok(requests.some(m => m.action === "download"));
    dom.window.history.pushState({}, "", "?p=2");
    navigationTick();
    await new Promise(resolve => setTimeout(resolve, 230));
    assert.equal(preview.hidden, true);
    assert.equal(preview.querySelectorAll(".bili-assistant-cue").length, 0);
    receive({ type: "subtitleStatus", state });
    assert.equal(preview.querySelectorAll(".bili-assistant-cue").length, 0, "迟到的旧字幕不得出现在新分 P");
  } finally { dom.window.close(); }
});
