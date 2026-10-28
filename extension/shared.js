/* 浏览器与 Node 测试共用的纯函数；不依赖页面对象。 */
(function (root) {
  "use strict";
  const DEFAULTS = Object.freeze({
    filterAds: true, filterKeywords: false, keywords: "", keywordScope: "title", keywordFeedbackEnabled: false,
    filterDuration: false, minDuration: 60, subtitlesEnabled: true,
    localFallback: false, preferenceModelSource: "mirror", model: "small", modelSource: "mirror", language: "auto",
    subtitleLanguage: "auto", format: "srt", downloadDirectory: "", askDownloadLocation: false,
    preferenceEnabled: false, preferenceFiltering: false, preferenceThreshold: 0.35,
    preferenceFeedbackEnabled: false, preferenceFeedbackThreshold: 0.08
  });
  function normalizeSettings(value = {}) {
    const s = { ...DEFAULTS, ...value };
    // 只保留当前设置项，旧版本已移除的设置不再写回。
    for (const key of Object.keys(s)) if (!(key in DEFAULTS)) delete s[key];
    for (const key of ["filterAds", "filterKeywords", "keywordFeedbackEnabled", "filterDuration", "subtitlesEnabled", "localFallback", "askDownloadLocation", "preferenceEnabled", "preferenceFiltering", "preferenceFeedbackEnabled"]) {
      s[key] = typeof s[key] === "boolean" ? s[key] : DEFAULTS[key];
    }
    s.minDuration = Math.min(86400, Math.max(0, Number(s.minDuration) || 0));
    s.keywords = String(s.keywords || "").slice(0, 10000);
    s.keywordScope = s.keywordScope === "titleAndOwner" ? "titleAndOwner" : "title";
    s.preferenceModelSource = s.preferenceModelSource === "huggingface" ? "huggingface" : "mirror";
    s.model = ["small", "base"].includes(s.model) ? s.model : DEFAULTS.model;
    s.modelSource = s.modelSource === "huggingface" ? "huggingface" : "mirror";
    s.language = ["auto", "zh", "en"].includes(s.language) ? s.language : "auto";
    s.subtitleLanguage = ["auto", "zh", "en"].includes(s.subtitleLanguage) ? s.subtitleLanguage : "auto";
    s.format = ["srt", "vtt", "txt"].includes(s.format) ? s.format : "srt";
    s.downloadDirectory = downloadDirectory(s.downloadDirectory);
    for (const key of ["preferenceThreshold", "preferenceFeedbackThreshold"]) {
      const number = Number(s[key]);
      s[key] = Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : DEFAULTS[key];
    }
    s.preferenceFeedbackThreshold = Math.min(s.preferenceFeedbackThreshold, s.preferenceThreshold);
    return s;
  }
  function downloadDirectory(raw = "") {
    const input = String(raw).trim().replace(/\\/g, "/");
    if (input.startsWith("/")) throw new Error("不能自动保存到绝对路径，请启用每次选择保存位置。");
    const value = input.replace(/\/$/, "");
    if (!value) return "";
    if (value.length > 200 || value.startsWith("/") || value.split("/").some(p => !p || p === "." || p === ".." || /[:*?"<>|\x00-\x1f]/.test(p) || /[. ]$/.test(p))) {
      throw new Error("下载目录需填写 Downloads 下的相对子目录，例如 Bilibili/字幕；其他路径请启用每次选择保存位置。");
    }
    return value;
  }
  function videoKey(rawUrl) {
    try {
      const url = new URL(rawUrl);
      const match = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]+|av\d+)\/?$/);
      if (url.origin !== "https://www.bilibili.com" || !match) return "";
      const page = Number(url.searchParams.get("p") || 1);
      if (!Number.isInteger(page) || page < 1) return "";
      return `${url.origin}/video/${match[1]}?p=${page}`;
    } catch { return ""; }
  }
  function mergeHistory(previous, records, now = Date.now()) {
    let result = Array.isArray(previous) ? previous.slice(0, 100) : [];
    for (const record of (Array.isArray(records) ? records : []).slice(0, 100)) {
      if (!["广告", "关键词", "时长", "偏好模型"].includes(record.reason)) continue;
      const url = videoKey(record.url);
      const title = String(record.title || "").trim().slice(0, 300);
      const owner = String(record.owner || "").trim().slice(0, 100);
      if (!url && !title) continue;
      const key = url || `${title}\n${owner}`;
      result = result.filter(item => item.key !== key);
      result.unshift({ key, url, title: title || "未显示标题的视频", owner,
        duration: Number.isFinite(record.duration) && record.duration >= 0 ? record.duration : null,
        reason: record.reason, score: Number.isFinite(record.score) ? Math.min(1, Math.max(0, record.score)) : null, filteredAt: now });
    }
    return result.slice(0, 100);
  }
  function parseDuration(raw) {
    const value = String(raw || "").trim();
    if (!/^\d{1,4}:\d{2}(:\d{2})?$/.test(value)) return null;
    const parts = value.split(":").map(Number);
    if (parts.slice(1).some(n => n >= 60)) return null;
    return parts.reduce((seconds, part) => seconds * 60 + part, 0);
  }
  function filterReason(card, s) {
    if (s.filterAds && card.ad) return "广告";
    const haystack = `${card.title || ""}${s.keywordScope === "titleAndOwner" ? "\n" + (card.owner || "") : ""}`.toLocaleLowerCase();
    const words = s.keywords.split(/[\n,，]+/).map(v => v.trim().toLocaleLowerCase()).filter(Boolean);
    if (s.filterKeywords && words.some(word => haystack.includes(word))) return "关键词";
    // 无时长、直播和占位卡片不参与时长判断；边界等于阈值时保留。
    if (s.filterDuration && card.duration != null && card.duration < s.minDuration) return "时长";
    if (s.preferenceEnabled && s.preferenceFiltering && Number.isFinite(card.preferenceScore) && card.preferenceScore < s.preferenceThreshold) return "偏好模型";
    return null;
  }
  function timestamp(seconds, separator = ",") {
    const ms = Math.max(0, Math.round(Number(seconds) * 1000));
    return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}${separator}${String(ms % 1000).padStart(3, "0")}`;
  }
  function cleanCues(body) {
    return (Array.isArray(body) ? body : []).map(c => ({
      from: Number(c.from ?? c.start), to: Number(c.to ?? c.end),
      content: String(c.content ?? c.text ?? "").replace(/\r/g, "").trim()
    })).filter(c => Number.isFinite(c.from) && Number.isFinite(c.to) && c.from >= 0 && c.to > c.from && c.content)
      .sort((a, b) => a.from - b.from);
  }
  function serializeSubtitles(body, format) {
    const cues = cleanCues(body);
    if (!cues.length) throw new Error("字幕内容为空，无法下载。");
    if (format === "txt") return cues.map(c => c.content).join("\n") + "\n";
    const vtt = format === "vtt";
    return (vtt ? "WEBVTT\n\n" : "") + cues.map((c, i) =>
      `${vtt ? "" : `${i + 1}\n`}${timestamp(c.from, vtt ? "." : ",")} --> ${timestamp(c.to, vtt ? "." : ",")}\n${c.content}\n`
    ).join("\n");
  }
  function filename(title) {
    return String(title || "bilibili").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").slice(0, 100) || "bilibili";
  }
  function chooseSubtitle(tracks, language) {
    const list = tracks.filter(t => t.subtitle_url);
    const manual = t => !/^ai[-_]/i.test(t.lan || "") && !t.ai_type;
    const match = t => language === "auto" || (language === "zh" ? /zh|中文|汉语/i : /en|英语|english/i).test(`${t.lan} ${t.lan_doc}`);
    // 指定语言只选该语言；缺少该语言时允许内置识别，而不是静默下载别的语言。
    return list.filter(match).sort((a, b) => Number(manual(b)) - Number(manual(a)))[0] || null;
  }
  const api = { DEFAULTS, normalizeSettings, downloadDirectory, videoKey, mergeHistory, parseDuration, filterReason, timestamp, cleanCues, serializeSubtitles, filename, chooseSubtitle };
  if (typeof module !== "undefined") module.exports = api;
  root.BiliAssistant = api;
})(globalThis);
