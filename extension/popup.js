"use strict";
(async () => {
  const status = document.querySelector("#status");
  const button = document.querySelector("#download");
  const copyButton = document.querySelector("#copy");
  let tab;
  let s = BiliAssistant.normalizeSettings();
  function renderSettings(value) {
    s = value;
    document.querySelector("#duration").textContent = `< ${s.minDuration} 秒`;
    for (const field of document.querySelectorAll("[data-setting]")) {
      if (field.dataset.setting !== "preferenceFiltering") field.checked = s[field.dataset.setting];
    }
  }
  const settingsUI = BiliSettingsUI(value => {
    renderSettings(value);
    if (tab) void refreshStatus().catch(error => { status.textContent = error.message; });
  });
  for (const field of document.querySelectorAll("[data-setting]")) {
    field.addEventListener("change", async () => {
      try {
        if (field.dataset.setting === "preferenceFiltering") {
          const current = await browser.runtime.sendMessage({ type: "setPreferenceSession", tabId: tab?.id, enabled: field.checked });
          s.preferenceFiltering = current.enabled;
          await refreshStatus();
          return;
        }
        await settingsUI.save({ [field.dataset.setting]: field.checked });
        await refreshStatus();
      } catch (error) { field.checked = s[field.dataset.setting]; status.textContent = error.message; }
    });
  }
  function renderFiltered(value) {
    document.querySelector("#filtered-count").textContent = value.count || 0;
    const list = document.querySelector("#filtered-items");
    list.replaceChildren();
    for (const item of value.videos || []) {
      const row = document.createElement("div"); row.className = "popup-history__item";
      const url = BiliAssistant.videoKey(item.url);
      const title = document.createElement(url ? "a" : "span");
      title.textContent = item.title || "未显示标题的视频";
      if (url) { title.href = url; title.target = "_blank"; title.rel = "noopener noreferrer"; }
      const reason = document.createElement("small");
      reason.textContent = [item.reason, item.owner].filter(Boolean).join(" · ");
      row.append(title, reason); list.append(row);
    }
    if (!list.childElementCount) list.textContent = "当前页面没有被过滤的视频。";
  }
  const history = document.querySelector("#filtered-videos");
  history.addEventListener("toggle", () => {
    history.querySelector(".popup-history__toggle").textContent = history.open ? "收起" : "展开";
  });
  async function refreshStatus() {
    try {
      renderFiltered(await browser.tabs.sendMessage(tab?.id, { type: "filterCount" }));
    } catch { renderFiltered({ count: 0, videos: [] }); }
    const currentTab = tab?.id ? await browser.tabs.get(tab.id) : tab;
    const currentSession = await browser.runtime.sendMessage({ type: "getPreferenceSession", tabId: tab?.id });
    document.querySelector('[data-setting="preferenceFiltering"]').checked = s.preferenceEnabled && currentSession.enabled;
    document.querySelector('[data-setting="preferenceFiltering"]').disabled = !s.preferenceEnabled;
    const state = await browser.runtime.sendMessage({ type: "subtitleStatus", tabId: tab?.id, url: currentTab?.url });
    const onVideo = /^https:\/\/www\.bilibili\.com\/video\/(BV|av)/.test(currentTab?.url || "");
    button.disabled = !onVideo || !s.subtitlesEnabled || state.busy;
    copyButton.disabled = button.disabled;
    status.textContent = state.message || (onVideo ? "优先读取 B 站字幕；没有字幕时按设置回退。" : "请打开 www.bilibili.com 的普通视频页。");
  }
  document.querySelector("#options").addEventListener("click", () => browser.runtime.openOptionsPage());
  for (const [element, action] of [[button, "download"], [copyButton, "copy"]]) {
    element.addEventListener("click", async () => {
      try { await browser.runtime.sendMessage({ type: "extractSubtitles", tabId: tab.id, action }); await refreshStatus(); }
      catch (error) { status.textContent = error.message; }
    });
  }
  // 开关不依赖视频页或偏好会话初始化成功，后台设置始终可读写。
  await settingsUI.refresh();
  [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  await refreshStatus().catch(error => { status.textContent = error.message; });
  setInterval(() => settingsUI.refresh().then(refreshStatus).catch(error => { status.textContent = error.message; }), 1000);
  window.addEventListener("focus", () => settingsUI.refresh().catch(error => { status.textContent = error.message; }));
})();
