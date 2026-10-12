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
      if (field.dataset.setting !== "preferenceEnabled") field.checked = s[field.dataset.setting];
    }
  }
  const settingsUI = BiliSettingsUI(value => {
    renderSettings(value);
    if (tab) void refreshStatus().catch(error => { status.textContent = error.message; });
  });
  for (const field of document.querySelectorAll("[data-setting]")) {
    field.addEventListener("change", async () => {
      try {
        if (field.dataset.setting === "preferenceEnabled") {
          const current = await browser.runtime.sendMessage({ type: "setPreferenceSession", tabId: tab?.id, enabled: field.checked });
          s.preferenceEnabled = current.enabled;
          return;
        }
        await settingsUI.save({ [field.dataset.setting]: field.checked });
        await refreshStatus();
      } catch (error) { field.checked = s[field.dataset.setting]; status.textContent = error.message; }
    });
  }
  async function refreshStatus() {
    const currentTab = tab?.id ? await browser.tabs.get(tab.id) : tab;
    const currentSession = await browser.runtime.sendMessage({ type: "getPreferenceSession", tabId: tab?.id });
    document.querySelector('[data-setting="preferenceEnabled"]').checked = currentSession.enabled;
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
