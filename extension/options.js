"use strict";
(async () => {
  const form = document.querySelector("form");
  const status = document.querySelector("#status");
  const preferenceState = document.querySelector("#preference-state");
  const edits = new Map();
  let editVersion = 0;
  function fieldValue(field) { return field.type === "checkbox" ? field.checked : field.value; }
  function renderSettings(value) {
    for (const [name, setting] of Object.entries(value)) {
      const field = form.elements.namedItem(name);
      if (field && !edits.has(name)) field.type === "checkbox" ? field.checked = setting : field.value = setting;
    }
  }
  const settingsUI = BiliSettingsUI(renderSettings);
  function showPreferenceState(value) {
    preferenceState.textContent = `${value.count} 个不同视频（31 个后运行） · ${value.training ? "训练中" : value.ready ? "模型已就绪" : value.hasModel ? "已有保存模型" : "尚未训练"}。${value.message || ""}${value.pendingUpdate ? " 有待训练标注，请点击“训练模型”更新。" : ""}`;
    const log = document.querySelector("#preference-log");
    const text = (value.logs || []).map(item => `[${new Date(item.time).toLocaleTimeString("zh-CN")}] ${item.message}`).join("\n") || "尚无训练记录。";
    if (log.textContent !== text) { log.textContent = text; log.scrollTop = log.scrollHeight; }
    document.querySelector("#preference-train").disabled = !!value.training || value.count < 31 || !settingsUI.value.preferenceEnabled;
    if (value.counts) preferenceState.textContent += ` 很喜欢 ${value.counts[3]} / 喜欢 ${value.counts[2]} / 不喜欢 ${value.counts[1]} / 很不喜欢 ${value.counts[0]}。`;
  }
  async function refreshPreference() {
    const value = await browser.runtime.sendMessage({ type: "preferenceStatus" });
    if (value) showPreferenceState(value);
  }
  document.querySelector("#preference-train").addEventListener("click", async () => {
    try {
      if (!await save()) return;
      showPreferenceState(await browser.runtime.sendMessage({ type: "trainPreferences" }));
    } catch (error) { preferenceState.textContent = error.message; }
  });
  void refreshPreference().catch(error => { preferenceState.textContent = error.message; });
  setInterval(() => { void refreshPreference().catch(() => {}); }, 1000);
  document.querySelector("#preference-check").addEventListener("click", async () => {
    try {
      if (!await save()) return;
      showPreferenceState(await browser.runtime.sendMessage({ type: "preferenceStatus" }));
    } catch (error) { preferenceState.textContent = error.message; }
  });
  document.querySelector("#preference-reset").addEventListener("click", async () => {
    // 浏览器训练数据不可恢复，按钮操作时明确告知用户后才删除。
    if (!confirm("清空全部偏好标注和训练头？基础 MiniLM 权重会保留，之后需重新积累 31 条标注。")) return;
    try { showPreferenceState(await browser.runtime.sendMessage({ type: "resetPreferences" })); }
    catch (error) { preferenceState.textContent = error.message; }
  });
  function renderHistory(records) {
    const body = document.querySelector("#history-body");
    body.replaceChildren();
    document.querySelector("#history-empty").hidden = records.length > 0;
    document.querySelector("#history-table").hidden = !records.length;
    for (const item of records) {
      const row = document.createElement("tr");
      const titleCell = document.createElement("td");
      const url = BiliAssistant.videoKey(item.url);
      const title = document.createElement(url ? "a" : "span");
      title.textContent = item.title;
      if (url) { title.href = url; title.target = "_blank"; title.rel = "noopener noreferrer"; }
      const owner = document.createElement("div");
      owner.className = "row__hint";
      owner.textContent = item.owner || "未显示 UP 主";
      titleCell.append(title, owner);
      row.append(titleCell);
      for (const text of [item.reason + (!Number.isFinite(item.score) ? "" : ` (${item.score.toFixed(2)})`), item.duration == null ? "未知" : BiliAssistant.timestamp(item.duration, ".").slice(0, 8), new Date(item.filteredAt).toLocaleString("zh-CN")]) {
        const cell = document.createElement("td"); cell.textContent = text; row.append(cell);
      }
      body.append(row);
    }
  }
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.filterHistory) renderHistory(changes.filterHistory.newValue || []);
  });
  document.querySelector("#clear-history").addEventListener("click", async () => {
    try {
      renderHistory(await browser.runtime.sendMessage({ type: "clearFilterHistory" }));
      status.textContent = "过滤历史已清空。";
    } catch (error) { status.textContent = error.message; }
  });
  // 历史列表加载失败不应阻断设置表单的初始化。
  browser.runtime.sendMessage({ type: "getFilterHistory" }).then(renderHistory).catch(e => { status.textContent = e.message; });
  await settingsUI.refresh();
  form.addEventListener("input", event => { if (event.target.name) edits.set(event.target.name, ++editVersion); });
  async function save(changedField) {
    // 自动保存只验证、提交本次操作的字段，其他输入错误不阻塞开关。
    if (!(changedField || form).reportValidity()) {
      status.textContent = "输入有误，该项尚未保存。";
      return false;
    }
    const values = {};
    const submitted = new Map();
    for (const field of changedField ? [changedField] : form.elements) {
      if (field.name && (edits.has(field.name) || String(fieldValue(field)) !== String(settingsUI.value[field.name]))) {
        values[field.name] = fieldValue(field);
        submitted.set(field.name, edits.get(field.name));
      }
    }
    if (Object.keys(values).length) await settingsUI.save(values);
    for (const [name, version] of submitted) {
      if (edits.get(name) === version) edits.delete(name);
    }
    renderSettings(settingsUI.value);
    status.textContent = "设置已保存，已打开的页面会自动更新。";
    return true;
  }
  form.addEventListener("submit", async event => { event.preventDefault(); try { await save(); } catch (e) { status.textContent = e.message; } });
  form.addEventListener("change", event => {
    if (!event.target.name) return;
    edits.set(event.target.name, ++editVersion);
    void save(event.target).catch(e => { status.textContent = e.message; });
  });
  window.addEventListener("focus", () => settingsUI.refresh().catch(e => { status.textContent = e.message; }));
  document.querySelector("#preference-export").addEventListener("click", async () => {
    try {
      const data = await browser.runtime.sendMessage({ type: "exportPreferenceLabels" });
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      try { await browser.downloads.download({ url, filename: "preferences-export.json", saveAs: true }); }
      finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
      preferenceState.textContent = `已导出 ${data.labels.length} 条标注。`;
    } catch (error) { preferenceState.textContent = error.message; }
  });
  const fileInput = document.querySelector("#preference-file");
  document.querySelector("#preference-import").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    try {
      const file = fileInput.files[0];
      if (!file) return;
      if (file.size > 4 * 1024 * 1024) throw new Error("标注文件超过 4 MiB。 ");
      const data = JSON.parse(await file.text());
      showPreferenceState(await browser.runtime.sendMessage({ type: "importPreferenceLabels", data }));
    } catch (error) { preferenceState.textContent = error.message; }
    finally { fileInput.value = ""; }
  });
})();
