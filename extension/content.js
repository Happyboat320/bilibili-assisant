/* 只读取卡片文字和 DOM，不注入页面主世界、不访问登录 Cookie。 */
"use strict";
(() => {
  const A = BiliAssistant;
  const preference = globalThis.BiliPreferences;
  const cardSelector = ".bili-video-card, .video-page-card-small, .video-card-reco, .rank-item, .small-item, .video-list-item";
  const titleSelector = ".bili-video-card__info--tit, .title, .video-name, a[title][href*='/video/']";
  const durationSelector = ".bili-video-card__stats__duration, .duration, .video-duration, .length";
  const adSelector = ".bili-video-card__info--ad, .bili-video-card__info--creative-ad, .bili-video-card__info--ad-icon, .bili-video-card__info--ad-text, .ad-label, .ad-tag";
  let settings = A.normalizeSettings();
  let timer;
  let count = 0;
  let filteredVideos = [];
  let subtitleState = { busy: false, message: "" };
  let renderedCues = null;
  let renderedSource = null;
  const reported = new WeakMap();
  const panel = document.createElement("aside");
  panel.id = "bili-assistant-panel";
  const countEl = document.createElement("span");
  countEl.className = "bili-assistant-count";
  const preferenceStatus = document.createElement("span");
  preferenceStatus.className = "bili-assistant-preference-status";
  preferenceStatus.setAttribute("role", "status");
  const feedbackStatus = document.createElement("span");
  feedbackStatus.className = "bili-assistant-preference-status";
  feedbackStatus.setAttribute("role", "status");
  const actions = document.createElement("div");
  actions.className = "bili-assistant-actions";
  function actionButton(label, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.dataset.action = action;
    actions.append(button);
    button.addEventListener("click", async () => {
      if (action === "preview" && subtitleState.cues?.length && subtitleState.videoKey === A.videoKey(location.href)) {
        preview.hidden = !preview.hidden;
        button.setAttribute("aria-expanded", String(!preview.hidden));
        return;
      }
      if (action === "preview") preview.hidden = false;
      try {
        const result = await browser.runtime.sendMessage({ type: "extractSubtitles", action });
        if (result.state) { subtitleState = result.state; updatePanel(); }
        if (result.message) status.textContent = result.message;
      } catch (error) { status.textContent = error.message; }
    });
    return button;
  }
  const previewButton = actionButton("预览字幕", "preview");
  previewButton.setAttribute("aria-expanded", "false");
  previewButton.setAttribute("aria-controls", "bili-assistant-preview");
  actionButton("复制字幕", "copy");
  const downloadButton = actionButton("下载字幕", "download");
  const status = document.createElement("span");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const preview = document.createElement("section");
  preview.id = "bili-assistant-preview";
  preview.hidden = true;
  const sourceLabel = document.createElement("p");
  const cueList = document.createElement("div");
  cueList.className = "bili-assistant-cues";
  preview.append(sourceLabel, cueList);
  const filterHeader = document.createElement("div");
  filterHeader.className = "bili-assistant-filter-header";
  const expandFilters = document.createElement("button");
  expandFilters.type = "button";
  expandFilters.textContent = "展开";
  expandFilters.setAttribute("aria-expanded", "false");
  expandFilters.setAttribute("aria-controls", "bili-assistant-filtered-list");
  const filteredList = document.createElement("section");
  filteredList.id = "bili-assistant-filtered-list";
  filteredList.hidden = true;
  expandFilters.addEventListener("click", () => {
    filteredList.hidden = !filteredList.hidden;
    expandFilters.textContent = filteredList.hidden ? "展开" : "收起";
    expandFilters.setAttribute("aria-expanded", String(!filteredList.hidden));
    renderFiltered();
  });
  filterHeader.append(countEl, expandFilters);
  panel.append(filterHeader, filteredList, preferenceStatus, feedbackStatus, actions, status, preview);
  document.body.append(panel);

  function seek(seconds) {
    // 直接控制 HTML5 播放器，不注入站点脚本；暂停状态保持不变。
    const video = document.querySelector(".bpx-player-video-wrap video, .bilibili-player-video video, video");
    if (!video || A.videoKey(location.href) !== subtitleState.videoKey) {
      status.textContent = "当前播放器不可用或视频已切换，请重新读取字幕。";
      return;
    }
    try {
      video.currentTime = Math.min(seconds, Number.isFinite(video.duration) ? video.duration : seconds);
      status.textContent = `已跳转到 ${A.timestamp(seconds, ".").slice(0, 8)}`;
    } catch { status.textContent = "播放器暂不能跳转，请等待视频加载。"; }
  }
  function renderPreview() {
    if (renderedCues === subtitleState.cues && renderedSource === subtitleState.source) return;
    renderedCues = subtitleState.cues;
    renderedSource = subtitleState.source;
    cueList.replaceChildren();
    sourceLabel.textContent = subtitleState.source === "builtin" ? "B 站内置字幕 · 点击时间跳转" : "本地识别字幕";
    if (!subtitleState.cues?.length) {
      sourceLabel.textContent = "点击预览字幕，读取后在这里查看正文。";
      return;
    }
    // 用分页限制 DOM 大小，长视频仍可浏览全部字幕。
    let visible = 0;
    function appendPage() {
      const fragment = document.createDocumentFragment();
      const end = Math.min(visible + 200, subtitleState.cues.length);
      for (; visible < end; visible++) {
        const cue = subtitleState.cues[visible];
        const row = document.createElement("div");
        row.className = "bili-assistant-cue";
        const time = document.createElement(subtitleState.source === "builtin" ? "button" : "span");
        time.textContent = A.timestamp(cue.from, ".").slice(0, 8);
        if (time.tagName === "BUTTON") {
          time.type = "button";
          time.setAttribute("aria-label", `跳转到 ${time.textContent}`);
          time.addEventListener("click", () => seek(cue.from));
        }
        const text = document.createElement("span");
        text.textContent = cue.content;
        row.append(time, text);
        fragment.append(row);
      }
      cueList.append(fragment);
      if (visible < subtitleState.cues.length) {
        const more = document.createElement("button");
        more.type = "button";
        more.textContent = `显示更多（${visible}/${subtitleState.cues.length}）`;
        more.addEventListener("click", () => { more.remove(); appendPage(); });
        cueList.append(more);
      }
    }
    appendPage();
  }
  function renderFiltered() {
    if (filteredList.hidden) return;
    filteredList.replaceChildren();
    if (!filteredVideos.length) { filteredList.textContent = "当前页面没有被过滤的视频。"; return; }
    for (const item of filteredVideos) {
      const row = document.createElement("div");
      row.className = "bili-assistant-filtered-item";
      const url = A.videoKey(item.url);
      const title = document.createElement(url ? "a" : "span");
      title.textContent = item.title || "未显示标题的视频";
      if (url) { title.href = url; title.target = "_blank"; title.rel = "noopener noreferrer"; }
      const reason = document.createElement("small");
      reason.textContent = [item.reason, item.owner].filter(Boolean).join(" · ");
      row.append(title, reason);
      filteredList.append(row);
    }
  }
  function updatePanel() {
    const number = document.createElement("strong");
    number.textContent = count;
    countEl.replaceChildren("已过滤 ", number, " 个视频");
    countEl.hidden = !(settings.filterAds || settings.filterKeywords || settings.filterDuration || settings.preferenceFiltering);
    filterHeader.hidden = countEl.hidden;
    if (filterHeader.hidden) { filteredList.hidden = true; expandFilters.textContent = "展开"; expandFilters.setAttribute("aria-expanded", "false"); }
    renderFiltered();
    preferenceStatus.hidden = !settings.preferenceEnabled;
    preferenceStatus.textContent = preference?.statusText() || "";
    const feedbackText = settings.keywordFeedbackEnabled && !settings.preferenceEnabled ? preference?.feedbackText() || "" : "";
    feedbackStatus.hidden = !feedbackText;
    feedbackStatus.textContent = feedbackText;
    actions.hidden = !settings.subtitlesEnabled || !A.videoKey(location.href);
    for (const button of actions.children) button.disabled = subtitleState.busy;
    downloadButton.title = settings.askDownloadLocation ? "选择保存位置" : `保存到 Downloads${settings.downloadDirectory ? "/" + settings.downloadDirectory : ""}`;
    previewButton.setAttribute("aria-expanded", String(!preview.hidden && !actions.hidden));
    status.textContent = settings.subtitlesEnabled && !actions.hidden ? subtitleState.message : "";
    if (actions.hidden) preview.hidden = true;
    renderPreview();
    panel.hidden = countEl.hidden && actions.hidden && !status.textContent && feedbackStatus.hidden;
  }
  function readCard(card) {
    const titleNode = card.querySelector(titleSelector);
    const title = titleNode?.getAttribute("title") || titleNode?.textContent || "";
    const owner = card.querySelector(".bili-video-card__info--author, .up, .upname, .name")?.textContent || "";
    const duration = A.parseDuration(card.querySelector(durationSelector)?.textContent);
    const adLinks = [...card.querySelectorAll("a[href]")].some(a => {
      try { return /(^|\.)(cm|ad)\.bilibili\.com$/.test(new URL(a.href).hostname); } catch { return false; }
    });
    const ad = !!card.querySelector(adSelector) || adLinks || card.matches("[data-is-ad='true'], [data-is-ad='1']");
    const link = card.querySelector("a[href*='/video/']");
    const url = link ? A.videoKey(link.href) : "";
    return { title, owner, duration, ad, url };
  }
  function scan() {
    if (preference) { settings.preferenceEnabled = preference.isEnabled(); settings.preferenceFiltering = preference.isFiltering(); }
    count = 0;
    filteredVideos = [];
    // 推荐页的 feed-card 是网格单元，隐藏它才能避免留下大片空白。
    document.querySelectorAll(".bili-assistant-hidden").forEach(el => el.classList.remove("bili-assistant-hidden"));
    const cards = [...document.querySelectorAll(cardSelector)].filter(el => !el.parentElement?.closest(cardSelector));
    const hidden = new Set();
    const records = [];
    for (const card of cards) {
      const data = readCard(card);
      data.preferenceScore = preference?.scoreFor(data) ?? null;
      const reason = A.filterReason(data, settings);
      if (reason) {
        const target = card.closest(".feed-card") || card;
        target.classList.add("bili-assistant-hidden");
        if (!hidden.has(target)) filteredVideos.push({ ...data, reason });
        hidden.add(target);
        if (reason === "关键词") preference?.queueKeywordFeedback(card, readCard, data);
        const signature = JSON.stringify([data.url, data.title, data.owner, reason]);
        if (reported.get(card) !== signature) {
          records.push({ ...data, reason, score: data.preferenceScore });
          reported.set(card, signature);
        }
      } else reported.delete(card);
    }
    if (records.length) browser.runtime.sendMessage({ type: "recordFilters", records }).catch(() => {
      // 保存失败后允许下一次扫描重试，不影响过滤本身。
      for (const card of cards) reported.delete(card);
    });
    count = hidden.size;
    preference?.scan(cards, readCard);
    updatePanel();
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(scan, 180); }
  document.addEventListener("bili-preference-updated", schedule);
  const observer = new MutationObserver(records => {
    // 不监听 class，避免自己的隐藏操作触发循环；新增卡片、异步文字和 href 变化都会重扫。
    if (records.some(r => !panel.contains(r.target))) schedule();
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["href", "title", "data-is-ad"] });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) {
      const next = A.normalizeSettings(changes.settings.newValue);
      if (["subtitleLanguage", "model", "language", "localFallback"].some(key => next[key] !== settings[key])) {
        subtitleState = { busy: false, message: "字幕设置已更新，点击预览重新读取。" };
        preview.hidden = true;
      }
      settings = next;
      preference?.configure(settings);
      schedule();
    }
  });
  browser.runtime.onMessage.addListener(message => {
    if (message.type === "subtitleStatus" && message.state.videoKey === A.videoKey(location.href)) {
      subtitleState = message.state; updatePanel();
    }
    if (message.type === "filterCount") return Promise.resolve({ count, videos: filteredVideos });
  });
  (preference?.ready || browser.runtime.sendMessage({ type: "getSettings" })).then(value => {
    settings = A.normalizeSettings(value); preference?.configure(settings); scan();
  });
  browser.runtime.sendMessage({ type: "subtitleStatus", url: location.href }).then(value => {
    if (!value.videoKey || value.videoKey === A.videoKey(location.href)) { subtitleState = value; updatePanel(); }
  });
  // 单页导航可能只更新 URL；低频检测即可，不拦截站点 history API。
  let lastUrl = location.href;
  setInterval(() => {
    if (lastUrl !== location.href) {
      const changedVideo = A.videoKey(lastUrl) !== A.videoKey(location.href);
      lastUrl = location.href;
      if (changedVideo) {
        subtitleState = { busy: false, message: "" };
        preview.hidden = true;
        browser.runtime.sendMessage({ type: "subtitleStatus", url: location.href }).then(value => {
          if (!value.videoKey || value.videoKey === A.videoKey(location.href)) { subtitleState = value; updatePanel(); }
        });
      }
      schedule();
    }
  }, 1000);
})();
