/* B 站请求与本地偏好调度在扩展后台执行。 */
"use strict";
const A = BiliAssistant;
const preferenceService = BiliPreferenceService();
const jobs = new Map();
let wbiKeys = null;
let wbiFetched = 0;
let historyQueue = Promise.resolve();
let settingsSave = Promise.resolve();
const closedTabs = new Set();
let feedbackQueue = Promise.resolve();
const preferenceSessions = new Map();

async function syncPreferenceRuntime() {
  const s = await settings();
  return preferenceService.setActive([...preferenceSessions.values()].some(session => session.enabled), s.preferenceModelSource);

}

// B 站部分接口校验 Referer；只修改本扩展发出的请求。
browser.webRequest.onBeforeSendHeaders.addListener(details => {
  const origin = details.originUrl || details.documentUrl || "";
  if (!origin.startsWith(browser.runtime.getURL(""))) return {};
  const headers = details.requestHeaders.filter(h => h.name.toLowerCase() !== "referer");
  headers.push({ name: "Referer", value: "https://www.bilibili.com/" });
  return { requestHeaders: headers };
}, { urls: ["https://api.bilibili.com/*", "https://*.hdslb.com/*", "https://*.bilibili.com/*", "https://*.bilivideo.com/*", "https://*.bilivideo.cn/*"] }, ["blocking", "requestHeaders"]);

async function settings() {
  return A.normalizeSettings((await browser.storage.local.get("settings")).settings);
}
async function jsonFetch(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error(`请求失败：HTTP ${response.status}`);
  return response.json();
}
async function api(path, params, signed = false) {
  let query;
  if (signed) {
    if (!wbiKeys || Date.now() - wbiFetched > 3600000) {
      const nav = await jsonFetch("https://api.bilibili.com/x/web-interface/nav", { credentials: "include" });
      const urls = nav.data?.wbi_img;
      if (!urls) throw new Error("无法获取 B 站接口签名密钥，请检查网络或登录状态。");
      wbiKeys = [urls.img_url, urls.sub_url].map(url => new URL(url).pathname.split("/").pop().split(".")[0]);
      wbiFetched = Date.now();
    }
    query = BiliWbi.sign(params, ...wbiKeys);
  } else query = new URLSearchParams(params).toString();
  const result = await jsonFetch(`https://api.bilibili.com${path}?${query}`, { credentials: "include" });
  if (result.code !== 0) {
    if (result.code === -403) wbiKeys = null;
    throw new Error(`B 站接口 ${result.code}：${result.message || "请求被拒绝"}`);
  }
  return result.data;
}
async function compatibleApi(modern, legacy, params) {
  try { return await api(modern, params, true); }
  catch (error) {
    try { return await api(legacy, params); }
    catch { throw error; }
  }
}
async function videoInfo(rawUrl) {
  const url = new URL(rawUrl);
  if (url.origin !== "https://www.bilibili.com") throw new Error("请在 Bilibili 视频页使用。");
  const match = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]+|av\d+)\/?/);
  if (!match) throw new Error("请打开普通视频播放页（/video/BV…），暂不支持直播和番剧页面。");
  const params = match[1].startsWith("BV") ? { bvid: match[1] } : { aid: match[1].slice(2) };
  const view = await api("/x/web-interface/view", params);
  const index = Number(url.searchParams.get("p") || 1);
  const page = view.pages?.find(p => p.page === index);
  if (!page) throw new Error("无法确定当前分 P，请刷新视频页。");
  return { bvid: view.bvid, aid: view.aid, cid: page.cid, title: view.title, part: page.part,
    page: index, count: view.pages.length, duration: page.duration };
}
function setStatus(tabId, values) {
  const state = { ...(jobs.get(tabId) || {}), ...values };
  jobs.set(tabId, state);
  browser.tabs.sendMessage(tabId, { type: "subtitleStatus", state }).catch(() => {});
}
function recordFilters(records, clear = false) {
  // 各标签页共享一条写入队列，防止并发覆盖过滤历史。
  const task = historyQueue.then(async () => {
    const stored = await browser.storage.local.get("filterHistory");
    const history = clear ? [] : A.mergeHistory(stored.filterHistory, records);
    await browser.storage.local.set({ filterHistory: history });
    return history;
  });
  historyQueue = task.catch(() => {});
  return task;
}
async function exportSubtitles(tabId, state, action, s) {
  if (action === "preview") return;
  if (action === "copy") {
    // 复制正文便于粘贴到笔记；下载仍遵循 SRT / VTT / TXT 设置。
    await navigator.clipboard.writeText(A.serializeSubtitles(state.cues, "txt"));
    setStatus(tabId, { message: "字幕正文已复制到剪贴板。" });
  } else {
    await download(state.cues, state.info, state.language, s);
    setStatus(tabId, { message: "字幕已交给 Firefox 下载管理器。" });
  }
}
async function readySubtitles(tabId, body, info, language, source, action, s) {
  const cues = A.cleanCues(body);
  if (!cues.length) throw new Error("字幕内容为空，无法预览或导出。");
  setStatus(tabId, { busy: false, cues, info, language, source,
    message: source === "builtin" ? "B 站字幕已就绪，点击时间可跳转。" : "内置识别字幕已就绪。" });
  await exportSubtitles(tabId, jobs.get(tabId), action, s);
}
async function download(cues, info, language, s) {
  const text = A.serializeSubtitles(cues, s.format);
  const blob = new Blob([text], { type: s.format === "vtt" ? "text/vtt;charset=utf-8" : "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const name = `${A.filename(info.title)}${info.count > 1 ? `_P${info.page}_${A.filename(info.part)}` : ""}_${A.filename(language)}.${s.format}`;
  try {
    await browser.downloads.download({ url, filename: s.downloadDirectory ? `${s.downloadDirectory}/${name}` : name, saveAs: s.askDownloadLocation });
  } finally {
    // 下载管理器异步读取 Blob，延迟释放。
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}
async function extract(tabId, rawUrl, s, action) {
  try {
    setStatus(tabId, { busy: true, message: "正在读取当前分 P 和字幕列表…" });
    const info = await videoInfo(rawUrl);
    let subtitleError = null;
    try {
      const player = await compatibleApi("/x/player/wbi/v2", "/x/player/v2", { bvid: info.bvid, cid: info.cid });
      const track = A.chooseSubtitle(player.subtitle?.subtitles || [], s.subtitleLanguage);
      if (track) {
        setStatus(tabId, { message: `正在下载 B 站字幕：${track.lan_doc || track.lan}…` });
        const url = new URL(track.subtitle_url, "https://www.bilibili.com");
        if (url.protocol !== "https:" || !/(^|\.)(hdslb\.com|bilibili\.com)$/.test(url.hostname)) throw new Error("字幕地址不在受支持的 B 站域名中。");
        const subtitle = await jsonFetch(url.href, { credentials: "omit" });
        await readySubtitles(tabId, subtitle.body, info, track.lan || "subtitle", "builtin", "preview", s);
        // 导出失败不应被误判为官方字幕失败而启动模型。
        await exportSubtitles(tabId, jobs.get(tabId), action, s).catch(error => {
          setStatus(tabId, { busy: false, message: `字幕已就绪，但导出失败：${error.message}` });
        });
        return;
      }
    } catch (error) { subtitleError = error; }
    if (!s.localFallback) {
      throw new Error(subtitleError ? `官方字幕获取失败：${subtitleError.message}。可在设置中开启内置识别回退。` : "当前分 P 没有符合语言要求的可用字幕；可在设置中开启内置识别回退。登录 B 站后也可重试。");
    }
    setStatus(tabId, { message: "没有可用官方字幕，正在获取音轨…" });
    const playback = await compatibleApi("/x/player/wbi/playurl", "/x/player/playurl", {
      bvid: info.bvid, cid: info.cid, qn: 64, fnval: 16, fnver: 0, fourk: 0
    });
    const audios = playback.dash?.audio || [];
    // 高码率优先；没有 DASH 时让浏览器解码器读取正常播放接口的音视频文件。
    const audio = [...audios].sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
    const media = audio || (playback.durl?.length === 1 ? playback.durl[0] : null);
    if (!media) throw new Error("无法取得完整音轨。可能需要登录，或该视频受权限限制；不支持分段 FLV 音轨。");
    const urls = [media.baseUrl || media.base_url || media.url, ...(media.backupUrl || media.backup_url || [])]
      .filter(Boolean).slice(0, 4).map(raw => {
        const url = new URL(raw);
        // 正常播放接口偶尔返回 HTTP CDN 地址；内置服务只使用 HTTPS。
        if (url.protocol === "http:") url.protocol = "https:";
        return url.href;
      });
    if (closedTabs.has(tabId)) throw new Error("视频页面已关闭，识别已取消。");
    const status = await BiliSpeech.transcribe(tabId, {
      urls, model: s.model, modelSource: s.modelSource, language: s.language, duration: info.duration
    }, message => setStatus(tabId, { message }));
    await readySubtitles(tabId, status.cues, info, status.language || "auto", "local", "preview", s);
    await exportSubtitles(tabId, jobs.get(tabId), action, s).catch(error => {
      setStatus(tabId, { busy: false, message: `字幕已就绪，但导出失败：${error.message}` });
    });
  } catch (error) {
    setStatus(tabId, { busy: false, message: error.message || "字幕提取失败。" });
  } finally {
    if (closedTabs.delete(tabId)) jobs.delete(tabId);
  }
}
browser.runtime.onMessage.addListener(async (message, sender) => {
  // 仅接受扩展自身与匹配页面上的内容脚本消息。
  if (sender.id !== browser.runtime.id) return;
  // Firefox 的扩展设置标签页也可能携带 sender.tab；按来源 URL 区分内容脚本。
  const extensionPage = typeof sender.url === "string" && sender.url.startsWith(browser.runtime.getURL(""));
  const pageTab = extensionPage ? undefined : sender.tab;
  if (message.type === "preferencePageReady") {
    if (!pageTab?.url?.startsWith("https://www.bilibili.com/") || !message.pageId) return;
    const wasEnabled = preferenceSessions.get(pageTab.id)?.enabled;
    preferenceSessions.set(pageTab.id, { pageId: String(message.pageId), enabled: false });
    if (wasEnabled) void syncPreferenceRuntime().catch(() => {});
    const s = await settings();
    return { ...s, preferenceEnabled: false };
  }
  if (message.type === "getPreferenceSession") return preferenceSessions.get(pageTab?.id ?? message.tabId) || { enabled: false };
  if (message.type === "preferencePageClosed") {
    const session = preferenceSessions.get(pageTab?.id);
    if (session?.pageId === message.pageId) {
      preferenceSessions.delete(pageTab.id);
      if (session.enabled) void syncPreferenceRuntime().catch(() => {});
    }
    return { ok: true };
  }
  if (message.type === "setPreferenceSession") {
    if (pageTab) throw new Error("请用插件工具栏手动开启当前页面的偏好功能。");
    const tab = await browser.tabs.get(message.tabId);
    const session = preferenceSessions.get(tab.id);
    if (!tab.url?.startsWith("https://www.bilibili.com/") || !session) throw new Error("请先打开或刷新 B 站页面。");
    session.enabled = message.enabled === true;
    await browser.tabs.sendMessage(tab.id, { type: "preferenceSession", ...session });
    void syncPreferenceRuntime().catch(() => {});
    return session;
  }
  if (message.type === "getSettings") {
    const s = await settings();
    s.preferenceEnabled = !!preferenceSessions.get(pageTab?.id)?.enabled;
    return s;
  }
  if (message.type === "saveSettings") {
    if (pageTab) throw new Error("页面不能更改扩展设置。");
    // 串行合并两处界面的修改，避免同时保存时丢失其他字段。
    const saved = settingsSave.then(async () => {
      const s = A.normalizeSettings({ ...await settings(), ...message.settings });
      // 偏好开启状态只在当前文档会话中保存，绝不写进持久化设置。
      s.preferenceEnabled = false;
      await browser.storage.local.set({ settings: s });
      if (preferenceSessions.size) void syncPreferenceRuntime().catch(() => {});
      return s;
    });
    settingsSave = saved.catch(() => {});
    return saved;
  }
  if (["exportPreferenceLabels", "importPreferenceLabels"].includes(message.type)) {
    if (pageTab) throw new Error("请在详细设置中导入或导出标注。");
    return message.type === "exportPreferenceLabels" ? preferenceService.exportLabels() : preferenceService.importLabels(message.data);
  }
  if (["preferenceStatus", "preferenceScore", "preferenceLabel", "resetPreferences", "claimPreferenceFeedback"].includes(message.type)) {
    const s = await settings();
    if (pageTab && !pageTab.url?.startsWith("https://www.bilibili.com/")) return;
    if (message.type === "resetPreferences") {
      if (pageTab) throw new Error("请在详细设置中清空偏好模型。");
      return preferenceService.reset();
    }
    const session = preferenceSessions.get(pageTab?.id ?? message.tabId);
    const active = !!session?.enabled && (!pageTab || session.pageId === message.pageId);
    if (message.type === "preferenceStatus") {
      const state = await preferenceService.status();
      return pageTab && !active ? { ...state, ready: false, runtimeActive: false } : state;
    }
    if (!active) throw new Error("请先手动开启当前页面的实验性偏好筛选。");
    if (message.type === "claimPreferenceFeedback") {
      if (!pageTab || !s.preferenceFeedbackEnabled || !Number.isFinite(message.score) || message.score >= s.preferenceFeedbackThreshold) return { allowed: false };
      const state = await preferenceService.status();
      if (!state.ready) return { allowed: false };
      const id = String(message.id || "").slice(0, 512);
      if (!id) return { allowed: false };
      const task = feedbackQueue.then(async () => {
        const records = (await browser.storage.local.get("preferenceFeedbackLedger")).preferenceFeedbackLedger || [];
        const now = Date.now();
        // 持久化去重：一天内同一视频只尝试一次，全局最多每 10 秒一次。
        if (records.some(r => r.id === id && now - r.time < 86400000) || records.some(r => now - r.time < 10000)) return { allowed: false };
        records.unshift({ id, time: now });
        await browser.storage.local.set({ preferenceFeedbackLedger: records.slice(0, 500) });
        return { allowed: true };
      });
      feedbackQueue = task.catch(() => {});
      return task;
    }
    if (message.type === "preferenceLabel") {
      const id = String(message.id || "").trim().slice(0, 512);
      const title = String(message.title || "").trim().slice(0, 300);
      if (!id || !title || !Number.isInteger(message.rating) || message.rating < 0 || message.rating > 3) throw new Error("无效的偏好标注。");
      return preferenceService.label({ id, title, rating: message.rating });
    }
    const items = (Array.isArray(message.items) ? message.items : []).slice(0, 20).map(item => ({
      id: String(item.id || "").trim().slice(0, 512), title: String(item.title || "").trim().slice(0, 300)
    })).filter(item => item.id && item.title);
    return preferenceService.score(items);
  }

  if (message.type === "recordFilters") {
    if (!pageTab?.url?.startsWith("https://www.bilibili.com/")) return;
    await recordFilters(message.records);
    return { ok: true };
  }
  if (message.type === "getFilterHistory" || message.type === "clearFilterHistory") {
    if (pageTab) throw new Error("过滤历史仅在扩展设置中可访问。");
    if (message.type === "clearFilterHistory") return recordFilters([], true);
    await historyQueue;
    return (await browser.storage.local.get("filterHistory")).filterHistory || [];
  }
  if (message.type === "subtitleStatus") {
    const state = jobs.get(pageTab?.id ?? message.tabId);
    return state && (!message.url || state.videoKey === A.videoKey(message.url)) ? state : { busy: false, message: "" };
  }
  if (message.type === "extractSubtitles") {
    const tab = pageTab || await browser.tabs.get(message.tabId);
    if (!tab?.id || !tab.url?.startsWith("https://www.bilibili.com/")) throw new Error("请先打开 Bilibili 视频页。");
    if (jobs.get(tab.id)?.busy) return { started: false, message: "当前视频的提取任务正在运行。" };
    const s = await settings();
    if (!s.subtitlesEnabled) throw new Error("字幕功能已关闭，请在设置中开启。");
    const action = ["preview", "copy", "download"].includes(message.action) ? message.action : "preview";
    const key = A.videoKey(tab.url);
    if (!key) throw new Error("请打开普通视频播放页。");
    const cacheKey = JSON.stringify([key, s.subtitleLanguage, s.model, s.modelSource, s.language, s.localFallback]);
    const cached = jobs.get(tab.id);
    if (cached?.cacheKey === cacheKey && cached.cues?.length) {
      await exportSubtitles(tab.id, cached, action, s);
      return { started: false, cached: true, state: jobs.get(tab.id) };
    }
    jobs.delete(tab.id);
    setStatus(tab.id, { busy: true, message: "正在开始…", videoKey: key, cacheKey });
    // 不让 popup 生命周期影响长时间识别任务。
    void extract(tab.id, tab.url, s, action);
    return { started: true };
  }
});
browser.tabs.onRemoved.addListener(tabId => {
  BiliSpeech.cancel(tabId);
  if (preferenceSessions.delete(tabId)) void syncPreferenceRuntime().catch(() => {});
  if (jobs.get(tabId)?.busy) closedTabs.add(tabId);
  else jobs.delete(tabId);
});
