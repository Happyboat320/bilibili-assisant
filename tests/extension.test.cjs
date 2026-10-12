/* 重点验证过滤边界、字幕时间、WBI 签名及后台的完整字幕流程。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const A = require("../extension/shared.js");
const W = require("../extension/wbi.js");

test("卡片过滤保留未知时长和等于阈值的视频；关键词按文字匹配", () => {
  const s = A.normalizeSettings({ filterKeywords: true, keywords: "剧透\nC++，spoiler", filterDuration: true, minDuration: 60 });
  assert.equal(A.filterReason({ title: "SPOILER alert", duration: 80 }, s), "关键词");
  assert.equal(A.filterReason({ title: "C++ 入门", duration: 80 }, s), "关键词");
  assert.equal(A.filterReason({ title: "正常视频", duration: 59 }, s), "时长");
  assert.equal(A.filterReason({ title: "正常视频", duration: 60 }, s), null);
  assert.equal(A.filterReason({ duration: null }, s), null);
  assert.equal(A.filterReason({ ad: true }, s), "广告");
  assert.equal(A.filterReason({ ad: true, duration: 1 }, A.normalizeSettings({ filterAds: false })), null);
  assert.equal(A.filterReason({ owner: "剧透" }, s), null);
  assert.equal(A.filterReason({ owner: "剧透" }, { ...s, keywordScope: "titleAndOwner" }), "关键词");
});

test("时长解析不会把播放量误当作秒数", () => {
  assert.equal(A.parseDuration("01:02:03"), 3723);
  assert.equal(A.parseDuration(" 5:04 "), 304);
  for (const value of ["1.5万", "直播", "", "00:99", "1:60:00"]) assert.equal(A.parseDuration(value), null);
});

test("字幕毫秒进位和格式输出正确，非法字幕不生成文件", () => {
  assert.equal(A.timestamp(59.9996), "00:01:00,000");
  const cues = [{ from: 1.25, to: 2.5, content: "你好 world" }, { from: -1, to: 0, content: "非法" }];
  assert.equal(A.serializeSubtitles(cues, "srt"), "1\n00:00:01,250 --> 00:00:02,500\n你好 world\n");
  assert.match(A.serializeSubtitles(cues, "vtt"), /^WEBVTT\n\n00:00:01\.250 --> 00:00:02\.500/);
  assert.equal(A.serializeSubtitles(cues, "txt"), "你好 world\n");
  assert.throws(() => A.serializeSubtitles([], "srt"));
  assert.equal(A.filename('标题:/测试?.'), "标题__测试_");
});

test("同语言人工字幕优先，找不到要求的语言时回退", () => {
  const tracks = [
    { lan: "ai-zh", subtitle_url: "https://x/ai", ai_type: 1 },
    { lan: "zh-CN", subtitle_url: "https://x/manual" }
  ];
  assert.equal(A.chooseSubtitle(tracks, "zh").lan, "zh-CN");
  assert.equal(A.chooseSubtitle(tracks, "en"), null);
});

test("WBI 的 MD5 与标准实现一致，并通过公开签名样例", () => {
  for (const value of ["", "abc", "你好 world", "x".repeat(1000)]) {
    assert.equal(W.md5(value), crypto.createHash("md5").update(value).digest("hex"));
  }
  const query = W.sign({ foo: "114", bar: "514", baz: 1919810 },
    "7cd084941338484aae1ad9425b84077c", "4932caff0ff746eab6f01bf08b70ac45", 1702204169);
  const unsigned = "bar=514&baz=1919810&foo=114&wts=1702204169";
  const expected = crypto.createHash("md5").update(unsigned + "ea1db124af3c7062474693fa704f4ff8").digest("hex");
  assert.equal(query, unsigned + "&w_rid=" + expected);
});

function makeBackground({ tracks = [], localFallback = false, apiError = false, settings = {}, copyFails = false, downloadFails = false, preferenceReady = false, speechError = false } = {}) {
  let listener;
  const downloads = [];
  const states = [];
  const requests = [];
  const pending = [];
  const copied = [];
  const speech = [];
  const storage = { settings: { localFallback, backendToken: "test-token", ...settings } };
  let tabUrl = "https://www.bilibili.com/video/BV1xx?p=2";
  let preferenceItems = [];
  const scriptRoot = path.join(__dirname, "../extension");
  const browser = {
    runtime: { id: "test@bili", getURL: () => "moz-extension://test/", onMessage: { addListener(fn) { listener = fn; } } },
    storage: { local: { async get(key) { return { [key]: storage[key] }; }, async set(values) { Object.assign(storage, values); } } },
    webRequest: { onBeforeSendHeaders: { addListener() {} } },
    tabs: { onRemoved: { addListener() {} }, async sendMessage(id, message) { states.push(message.state); },
      async get(id) { return { id, url: tabUrl }; } },
    downloads: { async download(value) { if (downloadFails) throw new Error("下载取消"); downloads.push(value); return 1; } }
  };
  const context = vm.createContext({ browser, console, URL, URLSearchParams, TextEncoder, Blob, AbortSignal,
    BiliSpeech: { async transcribe(tabId, payload, progress) {
      speech.push({ tabId, payload });
      if (speechError) throw new Error("模型下载失败");
      progress("内置识别中…");
      return { language: "zh", cues: [{ from: 0, to: 1, content: "内置字幕" }] };
    }, cancel() {} },
    setTimeout(fn, delay) { if (delay !== 60000) queueMicrotask(fn); }, Date,
    navigator: { clipboard: { async writeText(text) { if (copyFails) throw new Error("剪贴板不可用"); copied.push(text); } } },
    async fetch(url, options) {
      requests.push({ url: String(url), options });
      let data;
      if (String(url).includes("/nav")) data = { data: { wbi_img: { img_url: "https://x/" + "a".repeat(32) + ".png", sub_url: "https://x/" + "b".repeat(32) + ".png" } } };
      else if (String(url).includes("/view")) data = { code: 0, data: { bvid: "BV1xx", aid: 1, title: "测试视频", pages: [{ page: 1, cid: 10 }, { page: 2, cid: 20, part: "第二 P", duration: 100 }] } };
      else if (String(url).includes("/v2")) data = apiError ? { code: -403, message: "denied" } : { code: 0, data: { subtitle: { subtitles: tracks } } };
      else if (String(url).includes("/playurl")) data = { code: 0, data: { dash: { audio: [{ baseUrl: "https://test.bilivideo.com/audio.m4s", bandwidth: 300 }] } } };
      else if (String(url).includes("hdslb.com")) data = { body: [{ from: 0, to: 1, content: "官方字幕" }] };
      else if (String(url).includes("/v1/preferences/status")) data = { count: preferenceReady ? 31 : 30, ready: preferenceReady, modelVersion: 1 };
      else if (String(url).endsWith("/v1/preferences/runtime")) data = { ready: false };
      else if (String(url).endsWith("/v1/preferences/labels")) data = { count: 31, ready: false, revision: 2 };
      else if (String(url).endsWith("/v1/preferences/score")) {
        preferenceItems = JSON.parse(options.body).items;
        data = preferenceReady ? { count: 31, ready: true, taskId: "pref1", modelVersion: 1 } : { count: 30, ready: false, scores: [] };
      }
      else if (String(url).endsWith("/v1/preferences/tasks/pref1")) data = options.method === "DELETE" ? { ok: true } : { status: "done", ready: true, modelVersion: 1, scores: preferenceItems.map(item => ({ ...item, score: 0.1 })) };
      else throw new Error("Unexpected URL " + url);
      return { ok: true, async json() { return data; } };
    }
  });
  for (const file of ["shared.js", "wbi.js", "background.js"]) vm.runInContext(fs.readFileSync(path.join(scriptRoot, file), "utf8"), context);
  return { downloads, states, requests, copied, storage, speech,
    async enablePreference() {
      await listener({ type: "preferencePageReady", pageId: "test-page" }, { id: "test@bili", tab: { id: 1, url: tabUrl } });
      await listener({ type: "setPreferenceSession", tabId: 1, enabled: true }, { id: "test@bili" });
      await new Promise(setImmediate);
    },
    message(message, sender = { id: "test@bili" }) { return listener(message, sender); },
    navigate(url) { tabUrl = url; },
    async start(action = "download") {
      const response = await listener({ type: "extractSubtitles", tabId: 1, action }, { id: "test@bili" });
      pending.push(response);
      // 完整异步任务需要跨过所有微任务，setImmediate 只用于测试调度。
      for (let i = 0; i < 20 && !states.some(s => s.busy === false); i++) await new Promise(setImmediate);
      assert.ok(states.some(s => s.busy === false), "字幕任务必须完成");
      await new Promise(setImmediate);
    }
  };
}

test("两处设置同时保存不同字段时保留其他规则和服务令牌", async () => {
  const bg = makeBackground({ settings: { keywords: "剧透", minDuration: 120 } });
  await Promise.all([
    bg.message({ type: "saveSettings", settings: { filterAds: false } }),
    bg.message({ type: "saveSettings", settings: { localFallback: true } })
  ]);
  assert.equal(bg.storage.settings.filterAds, false);
  assert.equal(bg.storage.settings.localFallback, true);
  assert.equal(bg.storage.settings.keywords, "剧透");
  assert.equal(bg.storage.settings.minDuration, 120);
  assert.equal(bg.storage.settings.backendToken, "test-token");
});

test("Firefox 设置标签页携带 sender.tab 时仍能读取历史与令牌并保存，内容脚本仍被拒绝", async () => {
  const bg = makeBackground();
  const sender = { id: "test@bili", url: "moz-extension://test/options.html", tab: { id: 2, url: "moz-extension://test/options.html" } };
  const settings = await bg.message({ type: "getSettings" }, sender);
  assert.equal(settings.backendToken, "test-token");
  assert.equal((await bg.message({ type: "getFilterHistory" }, sender)).length, 0);
  await bg.message({ type: "saveSettings", settings: { filterAds: false } }, sender);
  assert.equal(bg.storage.settings.filterAds, false);
  const pageSender = { id: "test@bili", url: "https://www.bilibili.com/", tab: { id: 1, url: "https://www.bilibili.com/" } };
  assert.equal((await bg.message({ type: "getSettings" }, pageSender)).backendToken, "");
  await assert.rejects(bg.message({ type: "saveSettings", settings: { filterAds: true } }, pageSender), /页面不能/);
  await assert.rejects(bg.message({ type: "getFilterHistory" }, pageSender), /历史仅在/);
});

test("后台优先下载官方字幕，不联系本地服务，并使用当前分 P", async () => {
  const bg = makeBackground({ tracks: [{ lan: "zh-CN", subtitle_url: "//aisubtitle.hdslb.com/sub.json" }], localFallback: true });
  await bg.start();
  assert.equal(bg.downloads.length, 1);
  assert.match(bg.downloads[0].filename, /_P2_/);
  assert.ok(bg.requests.some(r => r.url.includes("cid=20")));
  assert.ok(!bg.requests.some(r => r.url.includes("127.0.0.1")));
});

test("预览不触发导出，复制和下载复用字幕并使用设置路径", async () => {
  const bg = makeBackground({ tracks: [{ lan: "zh-CN", subtitle_url: "//aisubtitle.hdslb.com/sub.json" }], settings: { downloadDirectory: "Bilibili/字幕" } });
  await bg.start("preview");
  assert.equal(bg.downloads.length, 0);
  assert.equal(bg.states.at(-1).source, "builtin");
  assert.equal(bg.states.at(-1).cues[0].content, "官方字幕");
  const requests = bg.requests.length;
  await bg.message({ type: "extractSubtitles", tabId: 1, action: "copy" });
  assert.deepEqual(bg.copied, ["官方字幕\n"]);
  await bg.message({ type: "extractSubtitles", tabId: 1, action: "download" });
  assert.equal(bg.requests.length, requests);
  assert.ok(bg.downloads[0].filename.startsWith("Bilibili/字幕/"));
  assert.equal(bg.downloads[0].saveAs, false);
});

test("下载失败保留官方预览，不错误启动内置识别", async () => {
  const bg = makeBackground({ tracks: [{ lan: "zh-CN", subtitle_url: "//aisubtitle.hdslb.com/sub.json" }], localFallback: true, downloadFails: true });
  await bg.start();
  assert.match(bg.states.at(-1).message, /导出失败/);
  assert.equal(bg.states.at(-1).cues.length, 1);
  assert.ok(!bg.requests.some(r => r.url.includes("127.0.0.1")));
});

test("切换分 P 后不返回旧字幕，重新获取当前 P", async () => {
  const bg = makeBackground({ tracks: [{ lan: "zh-CN", subtitle_url: "//aisubtitle.hdslb.com/sub.json" }], settings: { askDownloadLocation: true } });
  await bg.start("preview");
  bg.navigate("https://www.bilibili.com/video/BV1xx?p=1");
  const state = await bg.message({ type: "subtitleStatus", tabId: 1, url: "https://www.bilibili.com/video/BV1xx?p=1" });
  assert.ok(!state.cues);
  await bg.start("download");
  assert.ok(bg.requests.some(r => r.url.includes("cid=10")));
  assert.equal(bg.downloads[0].saveAs, true);
});

test("下载目录禁止绝对路径和路径穿越，默认 Downloads", () => {
  assert.equal(A.normalizeSettings().downloadDirectory, "");
  assert.equal(A.downloadDirectory("Bilibili\\字幕"), "Bilibili/字幕");
  for (const input of ["/", "/tmp/subtitles", "../other", "C:\\字幕", "Bili/../other", "Bili//字幕"]) assert.throws(() => A.downloadDirectory(input));
});

test("过滤历史跨标签页并发保存，去重，只保留最近 100 条且支持清空", async () => {
  const bg = makeBackground();
  const sender = { id: "test@bili", tab: { id: 1, url: "https://www.bilibili.com/" } };
  const records = Array.from({ length: 100 }, (_, i) => ({ url: `https://www.bilibili.com/video/BV${i}?spm_id_from=foo`, title: `视频 ${i}`, reason: "关键词", duration: 30 }));
  await Promise.all([
    bg.message({ type: "recordFilters", records }, sender),
    bg.message({ type: "recordFilters", records: [{ url: "https://www.bilibili.com/video/BVnew", title: "新视频", reason: "广告" }] }, sender)
  ]);
  let history = await bg.message({ type: "getFilterHistory" });
  assert.equal(history.length, 100);
  assert.equal(history[0].title, "新视频");
  assert.ok(!history.some(r => r.title === "视频 0"));
  await bg.message({ type: "recordFilters", records: [{ ...records[99], reason: "时长" }] }, sender);
  history = await bg.message({ type: "getFilterHistory" });
  assert.equal(history.length, 100);
  assert.equal(history[0].reason, "时长");
  assert.equal(history.filter(r => r.url.includes("/BV99?")).length, 1);
  assert.deepEqual(Array.from(await bg.message({ type: "clearFilterHistory" })), []);
  assert.equal(bg.storage.filterHistory.length, 0);
});

test("无字幕时使用内置识别，无需外置服务或令牌", async () => {
  const bg = makeBackground({ localFallback: true, settings: { backendToken: "" } });
  await bg.start();
  assert.equal(bg.downloads.length, 1);
  assert.equal(bg.speech.length, 1);
  assert.equal(bg.speech[0].payload.model, "small");
  assert.equal(bg.speech[0].payload.duration, 100);
  assert.ok(!bg.requests.some(r => r.url.includes("127.0.0.1")));
  assert.equal(bg.states.at(-1).cues[0].content, "内置字幕");
});

test("内置模型失败显示错误，下载失败仍保留识别结果", async () => {
  const failed = makeBackground({ localFallback: true, speechError: true });
  await failed.start();
  assert.equal(failed.downloads.length, 0);
  assert.match(failed.states.at(-1).message, /模型下载失败/);
  const exportFailed = makeBackground({ localFallback: true, downloadFails: true });
  await exportFailed.start();
  assert.match(exportFailed.states.at(-1).message, /导出失败/);
  assert.equal(exportFailed.states.at(-1).cues[0].content, "内置字幕");
});

test("官方接口失败且回退关闭时显示错误，不启动内置识别", async () => {
  const bg = makeBackground({ apiError: true });
  await bg.start();
  assert.equal(bg.downloads.length, 0);
  assert.match(bg.states.at(-1).message, /官方字幕获取失败/);
  assert.ok(!bg.requests.some(r => r.url.includes("127.0.0.1")));
});

test("偏好开关和阈值默认安全，分数无效时不隐藏，边界等于阈值保留", () => {
  const defaults = A.normalizeSettings();
  assert.equal(defaults.preferenceEnabled, false);
  assert.equal(defaults.preferenceFeedbackEnabled, false);
  assert.equal(A.filterReason({ preferenceScore: 0.01 }, defaults), null);
  const s = A.normalizeSettings({ filterAds: false, preferenceEnabled: true, preferenceThreshold: 0.35, preferenceFeedbackThreshold: 0.8 });
  assert.equal(s.preferenceFeedbackThreshold, 0.35);
  assert.equal(A.filterReason({ preferenceScore: 0.349 }, s), "偏好模型");
  assert.equal(A.filterReason({ preferenceScore: 0.35 }, s), null);
  for (const preferenceScore of [null, undefined, NaN, Infinity]) assert.equal(A.filterReason({ preferenceScore }, s), null);
});

test("后台拒绝关闭功能时推理，打开后按异步任务获取评分", async () => {
  const disabled = makeBackground();
  await assert.rejects(disabled.message({ type: "preferenceScore", items: [{ id: "1", title: "中文 title" }] }), /手动开启/);
  assert.equal(disabled.requests.length, 0);
  const bg = makeBackground({ preferenceReady: true, settings: { preferenceEnabled: true } });
  await bg.enablePreference();
  const result = await bg.message({ type: "preferenceScore", tabId: 1, items: [{ id: "1", title: "中文 title" }] });
  assert.equal(result.count, 31);
  assert.equal(result.scores[0].score, 0.1);
  assert.equal(result.scores[0].title, "中文 title");
  await new Promise(setImmediate);
  assert.ok(bg.requests.some(r => r.url.includes("/preferences/tasks/pref1") && r.options.method === "DELETE"));
});

test("四级标注验证数值并通知所有标签页偏好版本变化", async () => {
  const bg = makeBackground({ settings: { preferenceEnabled: true } });
  await bg.enablePreference();
  await assert.rejects(bg.message({ type: "preferenceLabel", tabId: 1, id: "1", title: "视频", rating: 4 }), /无效/);
  const result = await bg.message({ type: "preferenceLabel", tabId: 1, id: "1", title: "视频", rating: 2 });
  assert.equal(result.count, 31);
  assert.equal(bg.storage.preferenceRevision, 2);
  assert.equal(JSON.parse(bg.requests.find(r => r.url.endsWith("/labels")).options.body).rating, 2);
});

test("自动不感兴趣的持久化领取锁能去重、限速且默认禁用", async () => {
  const sender = { id: "test@bili", tab: { id: 1, url: "https://www.bilibili.com/" } };
  const disabled = makeBackground({ settings: { preferenceEnabled: true } });
  await disabled.enablePreference();
  assert.equal((await disabled.message({ type: "claimPreferenceFeedback", pageId: "test-page", id: "1", score: 0.01 }, sender)).allowed, false);
  const bg = makeBackground({ preferenceReady: true, settings: { preferenceFeedbackEnabled: true } });
  await bg.enablePreference();
  const results = await Promise.all([
    bg.message({ type: "claimPreferenceFeedback", pageId: "test-page", id: "1", score: 0.01 }, sender),
    bg.message({ type: "claimPreferenceFeedback", pageId: "test-page", id: "1", score: 0.01 }, sender),
    bg.message({ type: "claimPreferenceFeedback", pageId: "test-page", id: "2", score: 0.01 }, sender)
  ]);
  assert.deepEqual(results.map(r => r.allowed), [true, false, false]);
  assert.equal(bg.storage.preferenceFeedbackLedger.length, 1);
  assert.equal((await bg.message({ type: "claimPreferenceFeedback", pageId: "test-page", id: "3", score: 0.2 }, sender)).allowed, false);
});

test("每次重开页面必须手动开启，保存设置不会持久化开启状态", async () => {
  const bg = makeBackground({ settings: { preferenceEnabled: true } });
  assert.equal((await bg.message({ type: "getPreferenceSession", tabId: 1 })).enabled, false);
  await bg.enablePreference();
  assert.equal((await bg.message({ type: "getPreferenceSession", tabId: 1 })).enabled, true);
  await bg.message({ type: "saveSettings", settings: { preferenceEnabled: true, preferenceThreshold: 0.4 } });
  assert.equal(bg.storage.settings.preferenceEnabled, false);
  assert.equal(Object.hasOwn(bg.storage.settings, "preferenceChargingOnly"), false);
  await bg.message({ type: "preferencePageReady", pageId: "reopened" }, { id: "test@bili", tab: { id: 1, url: "https://www.bilibili.com/" } });
  assert.equal((await bg.message({ type: "getPreferenceSession", tabId: 1 })).enabled, false);
  await assert.rejects(bg.message({ type: "preferenceScore", tabId: 1, items: [{ id: "1", title: "标题" }] }), /手动开启/);
  await bg.message({ type: "setPreferenceSession", tabId: 1, enabled: true });
  assert.equal((await bg.message({ type: "getPreferenceSession", tabId: 1 })).enabled, true);
  await assert.rejects(bg.message({ type: "preferenceScore", pageId: "old-document", items: [{ id: "1", title: "标题" }] }, { id: "test@bili", tab: { id: 1, url: "https://www.bilibili.com/" } }), /手动开启/);
});
