const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

test("设置页安全展示过滤历史，响应新增记录并支持清空", async () => {
  const root = path.join(__dirname, "../extension");
  const dom = new JSDOM(fs.readFileSync(path.join(root, "options.html"), "utf8"), { runScripts: "outside-only", url: "https://extension.test/options.html" });
  let storageListener;
  let cleared = false;
  dom.window.browser = {
    runtime: { async sendMessage(message) {
      if (message.type === "getSettings") return {};
      if (message.type === "getFilterHistory") return [{ title: '<img src=x onerror="alert(1)">', url: "javascript:alert(1)", reason: "广告", duration: null, filteredAt: Date.now() }];
      if (message.type === "clearFilterHistory") { cleared = true; return []; }
    } },
    storage: { onChanged: { addListener(fn) { storageListener = fn; } } }
  };
  try {
    for (const file of ["shared.js", "settings-ui.js", "options.js"]) dom.window.eval(fs.readFileSync(path.join(root, file), "utf8"));
    await new Promise(setImmediate);
    const doc = dom.window.document;
    assert.equal(doc.querySelector("#history-table").hidden, false);
    assert.equal(doc.querySelectorAll("#history-body tr").length, 1);
    assert.equal(doc.querySelector("#history-body img"), null);
    assert.equal(doc.querySelector("#history-body a"), null);
    storageListener({ filterHistory: { newValue: [{ title: "普通视频", owner: "作者", url: "https://www.bilibili.com/video/BV1xx", reason: "时长", duration: 50, filteredAt: Date.now() }] } }, "local");
    assert.equal(doc.querySelector("#history-body a").href, "https://www.bilibili.com/video/BV1xx?p=1");
    assert.match(doc.querySelector("#history-body").textContent, /00:00:50/);
    doc.querySelector("#clear-history").click();
    await new Promise(setImmediate);
    assert.equal(cleared, true);
    assert.equal(doc.querySelector("#history-table").hidden, true);
    assert.equal(doc.querySelector("#history-empty").hidden, false);
  } finally { dom.window.close(); }
});

test("弹窗和详细设置同步开关与时长，只提交修改字段并显示实际保存的值", async () => {
  const root = path.join(__dirname, "../extension");
  const A = require("../extension/shared.js");
  const listeners = [], saves = [];
  let settings = A.normalizeSettings({ preferenceModelSource: "huggingface" });
  const browser = {
    tabs: {
      async query() { return [{ id: 1, url: "https://www.bilibili.com/video/BV1xx" }]; },
      async get() { return { id: 1, url: "https://www.bilibili.com/video/BV1xx" }; }
    },
    storage: { onChanged: { addListener(fn) { listeners.push(fn); } } },
    runtime: { async sendMessage(message) {
      if (message.type === "getSettings") return { ...settings };
      if (message.type === "getFilterHistory") return [];
      if (message.type === "getPreferenceSession") return { enabled: true };
      if (message.type === "subtitleStatus") return { busy: false };
      if (message.type === "saveSettings") {
        saves.push(message.settings);
        settings = A.normalizeSettings({ ...settings, ...message.settings });
        for (const listener of listeners) listener({ settings: { newValue: { ...settings } } }, "local");
        return { ...settings };
      }
      throw new Error("unexpected message " + message.type);
    } }
  };
  const options = new JSDOM(fs.readFileSync(path.join(root, "options.html"), "utf8"), { runScripts: "outside-only" });
  const popup = new JSDOM(fs.readFileSync(path.join(root, "popup.html"), "utf8"), { runScripts: "outside-only" });
  const tick = () => new Promise(setImmediate);
  function change(dom, field, value, type = "change") {
    field.type === "checkbox" ? field.checked = value : field.value = value;
    field.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
  }
  try {
    options.window.browser = browser;
    popup.window.browser = browser;
    options.window.eval(fs.readFileSync(path.join(root, "shared.js"), "utf8"));
    options.window.eval(fs.readFileSync(path.join(root, "settings-ui.js"), "utf8"));
    options.window.eval(fs.readFileSync(path.join(root, "options.js"), "utf8"));
    popup.window.eval(fs.readFileSync(path.join(root, "shared.js"), "utf8"));
    popup.window.eval(fs.readFileSync(path.join(root, "settings-ui.js"), "utf8"));
    popup.window.eval(fs.readFileSync(path.join(root, "popup.js"), "utf8"));
    await tick();
    const form = options.window.document.querySelector("form");
    const popupField = name => popup.window.document.querySelector(`[data-setting="${name}"]`);
    change(popup, popupField("filterAds"), false);
    await tick();
    assert.equal(form.elements.filterAds.checked, false);
    assert.deepEqual(Object.keys(saves.at(-1)), ["filterAds"]);
    change(options, form.elements.keywords, "剧透", "input");
    change(popup, popupField("localFallback"), true);
    await tick();
    assert.equal(form.elements.keywords.value, "剧透");
    assert.equal(form.elements.localFallback.checked, true);
    form.dispatchEvent(new options.window.Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    assert.deepEqual(Object.keys(saves.at(-1)), ["keywords"]);
    assert.equal(settings.filterAds, false);
    assert.equal(settings.localFallback, true);
    assert.equal(settings.preferenceModelSource, "huggingface");
    change(options, form.elements.minDuration, "120");
    await tick();
    assert.equal(popup.window.document.querySelector("#duration").textContent, "< 120 秒");
    change(options, form.elements.subtitlesEnabled, false);
    await tick();
    assert.equal(popupField("subtitlesEnabled").checked, false);
    assert.equal(popup.window.document.querySelector("#download").disabled, true);
    assert.equal(popup.window.document.querySelector("#copy").disabled, true);
    assert.equal(popupField("preferenceEnabled").checked, true, "全局设置保存不关闭页面偏好会话");
    change(options, form.elements.preferenceThreshold, "0.04");
    await tick();
    assert.equal(form.elements.preferenceFeedbackThreshold.value, "0.04", "显示后台归一化后的阈值");
  } finally { options.window.close(); popup.window.close(); }
});

test("无效的时长输入不阻止详细设置开关保存，切换开关不提前提交文本草稿", async () => {
  const root = path.join(__dirname, "../extension");
  const A = require("../extension/shared.js");
  const dom = new JSDOM(fs.readFileSync(path.join(root, "options.html"), "utf8"), { runScripts: "outside-only" });
  let settings = A.normalizeSettings();
  let listener;
  const saves = [];
  dom.window.browser = {
    storage: { onChanged: { addListener(fn) { listener = fn; } } },
    runtime: { async sendMessage(message) {
      if (message.type === "getFilterHistory") return [];
      if (message.type === "getSettings") return { ...settings };
      if (message.type === "saveSettings") {
        saves.push(message.settings);
        settings = A.normalizeSettings({ ...settings, ...message.settings });
        listener({ settings: { newValue: { ...settings } } }, "local");
        return { ...settings };
      }
    } }
  };
  try {
    for (const file of ["shared.js", "settings-ui.js", "options.js"]) dom.window.eval(fs.readFileSync(path.join(root, file), "utf8"));
    await new Promise(setImmediate);
    const form = dom.window.document.querySelector("form");
    for (const [name, value] of [["minDuration", "-1"], ["keywords", "尚未保存"]]) {
      form.elements[name].value = value;
      form.elements[name].dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    }
    form.elements.filterAds.checked = false;
    form.elements.filterAds.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await new Promise(setImmediate);
    assert.equal(settings.filterAds, false);
    assert.deepEqual(Object.keys(saves.at(-1)), ["filterAds"]);
    assert.equal(settings.keywords, "");
    assert.equal(form.elements.keywords.value, "尚未保存");
    assert.equal(form.elements.minDuration.value, "-1");
    assert.match(dom.window.document.querySelector("#status").textContent, /已保存/);
  } finally { dom.window.close(); }
});

test("设置读取和保存回执迟到时，不覆盖其他窗口的新状态", async () => {
  const root = path.join(__dirname, "../extension");
  const A = require("../extension/shared.js");
  const dom = new JSDOM("", { runScripts: "outside-only" });
  let listener, resolveRead, resolveSave;
  let settings = A.normalizeSettings();
  let holdRead = true;
  const rendered = [];
  dom.window.browser = {
    storage: { onChanged: { addListener(fn) { listener = fn; } } },
    runtime: { sendMessage(message) {
      if (message.type === "getSettings") return holdRead ? new Promise(resolve => { resolveRead = resolve; }) : Promise.resolve({ ...settings });
      if (message.type === "saveSettings") return new Promise(resolve => { resolveSave = resolve; });
    } }
  };
  try {
    for (const file of ["shared.js", "settings-ui.js"]) dom.window.eval(fs.readFileSync(path.join(root, file), "utf8"));
    const ui = dom.window.BiliSettingsUI(value => rendered.push(value));
    const initial = ui.refresh();
    settings = { ...settings, filterAds: false };
    listener({ settings: { newValue: settings } }, "local");
    resolveRead(A.normalizeSettings());
    await initial;
    assert.equal(ui.value.filterAds, false);
    const saving = ui.save({ filterAds: true });
    const oldReceipt = { ...settings, filterAds: true };
    listener({ settings: { newValue: oldReceipt } }, "local");
    settings = { ...settings, filterAds: false, minDuration: 120 };
    listener({ settings: { newValue: settings } }, "local");
    holdRead = false;
    resolveSave(oldReceipt);
    await saving;
    assert.equal(ui.value.filterAds, false);
    assert.equal(ui.value.minDuration, 120);
    assert.equal(rendered.at(-1).filterAds, false);
    // 即使页面错过 storage 事件，重新读取也会恢复后台状态。
    settings = { ...settings, localFallback: true };
    await ui.refresh();
    assert.equal(ui.value.localFallback, true);
  } finally { dom.window.close(); }
});
