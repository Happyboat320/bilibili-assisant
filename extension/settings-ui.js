/* 两处设置界面共用同一份后台状态；保存回执不作为界面快照。 */
(function (root) {
  "use strict";
  root.BiliSettingsUI = function (render) {
    let value = BiliAssistant.normalizeSettings();
    let readVersion = 0;
    function apply(settings) {
      value = BiliAssistant.normalizeSettings(settings);
      render(value);
    }
    // 先订阅再读取，读取期间发生的更新不能被旧快照覆盖。
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.settings) return;
      readVersion++;
      apply(changes.settings.newValue);
    });
    async function refresh() {
      const version = ++readVersion;
      const settings = await browser.runtime.sendMessage({ type: "getSettings" });
      if (version === readVersion) apply(settings);
      return value;
    }
    async function save(settings) {
      await browser.runtime.sendMessage({ type: "saveSettings", settings });
      // 回执可能晚于另一窗口的保存；重新读后台，避免把旧值显示回来。
      return refresh();
    }
    return { refresh, save, get value() { return value; } };
  };
})(globalThis);
