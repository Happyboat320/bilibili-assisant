/* 实验性偏好控制器：标题留在本机处理，模型未就绪时绝不隐藏视频。 */
"use strict";
(() => {
  const A = BiliAssistant;
  const nativeTriggerSelector = ".bili-video-card__info--more, .bili-video-card__info--more-btn, .bili-video-card__info--more-icon, .more-btn, [aria-label='更多']";
  const nativeMenuSelector = ".bili-video-card__info--more-panel, .bili-video-card__info--more-popup, .bili-video-card__info--more-menu, .bili-video-card__info--dislike-panel, .bili-video-card__info--dislike-popup, .v-popover-content, .bili-popover, [role='menu']";
  const ratings = [["很喜欢", 3], ["喜欢", 2], ["不喜欢", 1], ["很不喜欢", 0]];
  let settings = A.normalizeSettings();
  let state = { count: 0, ready: false, message: "" };
  let generation = 0;
  let pumping = false;
  let pumpTimer;
  let feedbackTimer;
  let feedbackBusy = false;
  let feedbackMessage = "";
  let pageId = crypto.randomUUID();
  let sessionActive = false;
  let initialized = false;
  const scores = new Map();
  const cards = new Map();
  const boundTriggers = new WeakSet();
  const feedback = new Map();
  const attempted = new Set();
  const menu = document.createElement("div");
  menu.id = "bili-assistant-preference-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "标注视频偏好");
  menu.hidden = true;
  document.body.append(menu);

  function notify() { document.dispatchEvent(new CustomEvent("bili-preference-updated")); }
  function titleData(data) {
    const title = String(data.title || "").replace(/\s+/g, " ").trim().slice(0, 300);
    return { id: A.videoKey(data.url).split("?")[0] || `title:${title}`, title };
  }
  function visible(el) {
    if (el.closest("[hidden]")) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  }
  function nativeMenus(card) {
    return [...document.querySelectorAll(nativeMenuSelector)].filter(el =>
      el !== menu && !menu.contains(el) && visible(el) && (card.contains(el) || el.textContent.includes("不感兴趣")));
  }
  function hideMenu() { menu.hidden = true; }
  function openMenu(card, trigger, readCard, native = false) {
    if (!settings.preferenceEnabled || !card.isConnected) return;
    const data = titleData(readCard(card));
    if (!data.title) return;
    menu.replaceChildren();
    const heading = document.createElement("strong");
    heading.textContent = "标注我的偏好";
    menu.append(heading);
    const note = document.createElement("span");
    note.className = "bili-preference-note";
    note.setAttribute("role", "status");
    for (const [label, rating] of ratings) {
      const option = document.createElement("button");
      option.type = "button";
      option.setAttribute("role", "menuitem");
      option.textContent = label;
      option.dataset.rating = rating;
      option.addEventListener("click", async event => {
        event.preventDefault(); event.stopPropagation();
        if (!settings.preferenceEnabled) return;
        const latest = titleData(readCard(card));
        if (latest.id !== data.id || latest.title !== data.title) {
          note.textContent = "视频卡片已更新，请重新打开菜单再标注。";
          return;
        }
        for (const button of menu.querySelectorAll("button")) button.disabled = true;
        note.textContent = "正在保存本地标注…";
        try {
          state = await browser.runtime.sendMessage({ type: "preferenceLabel", pageId, ...data, rating });
          note.textContent = `已标注“${label}”；${state.count} 个不同视频${state.count < 31 ? "，31 个后可手动训练" : "，请在详细设置手动训练更新"}。`;
          notify(); schedulePump(500);
        } catch (error) { note.textContent = error.message; }
        finally { for (const button of menu.querySelectorAll("button")) button.disabled = false; }
      });
      menu.append(option);
    }
    menu.append(note);
    // 已知原生菜单打开时把四个选项加入其中；未识别布局时在三点旁显示独立菜单。
    const container = native ? nativeMenus(card).find(el => el.contains(trigger) === false) : null;
    if (container && !["UL", "OL"].includes(container.tagName)) {
      container.append(menu);
      menu.className = "bili-preference-embedded";
      menu.style.left = ""; menu.style.top = "";
    } else {
      document.body.append(menu);
      menu.className = "";
      const rect = trigger.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(rect.right - 180, innerWidth - 200))}px`;
      menu.style.top = `${Math.max(8, Math.min(rect.bottom + 6, innerHeight - 270))}px`;
    }
    menu.hidden = false;
  }
  function attachMenu(card, readCard) {
    let trigger = card.querySelector(nativeTriggerSelector);
    const native = !!trigger;
    if (!trigger) {
      trigger = card.querySelector(".bili-assistant-preference-trigger");
      if (!trigger) {
        const title = card.querySelector(".bili-video-card__info--tit, .title, .video-name, a[title][href*='/video/']");
        if (!title?.parentElement) return;
        trigger = document.createElement("button");
        trigger.type = "button";
        trigger.className = "bili-assistant-preference-trigger";
        trigger.textContent = "⋮";
        trigger.title = "标注视频偏好";
        trigger.setAttribute("aria-label", "更多：标注视频偏好");
        trigger.setAttribute("aria-haspopup", "menu");
        // 按钮放在标题链接外面，标注时不会跳转视频。
        title.parentElement.append(trigger);
      }
    }
    if (!native) trigger.hidden = !settings.preferenceEnabled;
    if (boundTriggers.has(trigger)) return;
    boundTriggers.add(trigger);
    trigger.addEventListener("click", event => {
      if (!settings.preferenceEnabled || feedbackBusy) return;
      if (!native) { event.preventDefault(); event.stopPropagation(); openMenu(card, trigger, readCard); }
      else setTimeout(() => openMenu(card, trigger, readCard, true), 120);
    });
  }
  document.addEventListener("click", event => {
    if (!menu.contains(event.target)) hideMenu();
  }, true);
  document.addEventListener("keydown", event => { if (event.key === "Escape") hideMenu(); });

  function schedulePump(delay = 300) {
    clearTimeout(pumpTimer);
    if (settings.preferenceFiltering) pumpTimer = setTimeout(pump, delay);
  }
  async function pump() {
    if (!settings.preferenceFiltering || pumping) { schedulePump(1000); return; }
    pumping = true;
    const current = generation;
    try {
      const status = await browser.runtime.sendMessage({ type: "preferenceStatus", pageId });
      if (current !== generation || !settings.preferenceFiltering) return;
      if (state.modelVersion !== status.modelVersion || !status.ready) scores.clear();
      state = status;
      notify();
      if (state.runtimeActive === false) return;
      // 样本 <=30 时只读取计数，不请求编码或推理，不加载嵌入模型。
      if (!state.ready) return;
      const items = [...cards.values()].filter(item => item.card.isConnected && (!scores.has(item.id) || scores.get(item.id).title !== item.title)).slice(0, 20);
      if (!items.length) return;
      const result = await browser.runtime.sendMessage({ type: "preferenceScore", pageId, items: items.map(({ id, title }) => ({ id, title })) });
      if (current !== generation || !settings.preferenceFiltering) return;
      state = { ...state, ...result };
      if (result.ready && state.count > 30) {
        for (const item of result.scores || []) {
          if (!Number.isFinite(item.score) || item.score < 0 || item.score > 1) continue;
          scores.set(item.id, { title: item.title, score: item.score, version: result.modelVersion });
          const source = cards.get(item.id);
          if (settings.preferenceFeedbackEnabled && item.score < settings.preferenceFeedbackThreshold && source && !attempted.has(item.id)) {
            feedback.set(item.id, { kind: "preference", ...item, card: source.card, readCard: source.readCard });
          }
        }
        if (feedback.size) scheduleFeedback(0);
      } else scores.clear();
      notify();
    } catch (error) {
      if (current === generation) {
        scores.clear(); state = { ...state, ready: false, message: `${error.message}；偏好筛选暂停，视频保持可见。` }; notify();
      }
    } finally {
      pumping = false;
      const pending = [...cards.values()].some(item => item.card.isConnected && !scores.has(item.id));
      schedulePump(state.ready && pending ? 500 : 10000);
    }
  }
  function scheduleFeedback(delay) {
    clearTimeout(feedbackTimer);
    const wanted = (settings.preferenceFiltering && settings.preferenceFeedbackEnabled) || settings.keywordFeedbackEnabled;
    if (wanted) feedbackTimer = setTimeout(flushFeedback, delay);
  }
  function queueKeywordFeedback(card, readCard, data) {
    // 关键词命中的卡片在隐藏后排队，是否执行仍由后台领取锁和前台条件决定。
    if (!settings.keywordFeedbackEnabled || !settings.filterKeywords || document.visibilityState !== "visible") return;
    const item = titleData(data);
    if (!item.title || attempted.has(item.id)) return;
    feedback.set(item.id, { kind: "keyword", ...item, card, readCard });
    scheduleFeedback(0);
  }
  function validFeedbackEntry(entry) {
    if (!entry.card?.isConnected) return false;
    if (entry.kind === "keyword") {
      if (!settings.keywordFeedbackEnabled || !settings.filterKeywords) return false;
    } else {
      if (!settings.preferenceFiltering || !settings.preferenceFeedbackEnabled || !state.ready) return false;
      if (!(entry.score < settings.preferenceFeedbackThreshold)) return false;
    }
    const latest = titleData(entry.readCard(entry.card));
    return latest.id === entry.id && latest.title === entry.title;
  }
  async function flushFeedback() {
    if (feedbackBusy) return;
    if (document.visibilityState !== "visible" || !menu.hidden) { scheduleFeedback(10000); return; }
    const entry = [...feedback.values()].find(validFeedbackEntry);
    if (!entry) { feedback.clear(); return; }
    const trigger = entry.card.querySelector(nativeTriggerSelector);
    if (!trigger) {
      attempted.add(entry.id); feedback.delete(entry.id);
      feedbackMessage = entry.kind === "keyword" ? "关键词命中的视频没有可识别的原生反馈菜单，已跳过不感兴趣。" : "部分低分视频没有可识别的原生反馈菜单，已跳过不感兴趣。";
      notify(); scheduleFeedback(10000); return;
    }
    feedbackBusy = true;
    const current = generation;
    try {
      const claim = entry.kind === "keyword"
        ? await browser.runtime.sendMessage({ type: "claimKeywordFeedback", pageId, id: entry.id })
        : await browser.runtime.sendMessage({ type: "claimPreferenceFeedback", pageId, id: entry.id, score: entry.score });
      if (!claim.allowed) {
        // 仅被全局限速时保留关键词条目，10 秒后再试；其余拒绝都视为放弃。
        if (entry.kind !== "keyword" || !claim.throttled) {
          if (entry.kind === "keyword") attempted.add(entry.id);
          feedback.delete(entry.id);
        }
        return;
      }
      if (current !== generation || !validFeedbackEntry(entry) || document.visibilityState !== "visible") return;
      attempted.add(entry.id); feedback.delete(entry.id);
      const before = new Set(nativeMenus(entry.card));
      trigger.click();
      await new Promise(resolve => setTimeout(resolve, 160));
      if (current !== generation || !validFeedbackEntry(entry) || document.visibilityState !== "visible") return;
      // 只在当前卡片菜单 / 本次新弹出的菜单内匹配完全一致的文字，绝不猜测按钮位置。
      const candidates = nativeMenus(entry.card).filter(el => entry.card.contains(el) || !before.has(el));
      const options = candidates.flatMap(el => [...el.querySelectorAll("button, [role='menuitem'], li, span, div")]);
      const option = options.find(el => el.textContent.trim() === "不感兴趣" && visible(el));
      if (option) {
        option.click();
        feedbackMessage = entry.kind === "keyword" ? "已点击关键词视频的“不感兴趣”选项（最终反馈结果以 B 站为准）。" : "已点击页面的不感兴趣选项（最终反馈结果以 B 站为准）。";
      } else {
        feedbackMessage = "没有找到明确的不感兴趣选项，已跳过自动反馈。";
        // 关闭刚打开的菜单，不点击其他反馈选项或额外确认。
        trigger.click();
      }
      notify();
    } catch { feedbackMessage = entry.kind === "keyword" ? "自动反馈未执行，视频仍按关键词隐藏。" : "自动反馈未执行，视频仍按本地偏好分数筛选。"; notify(); }
    finally { feedbackBusy = false; if (feedback.size) scheduleFeedback(10000); }
  }
  function configure(value) {
    const next = A.normalizeSettings(value);
    next.preferenceFiltering = next.preferenceEnabled && initialized && sessionActive;
    const changed = next.preferenceEnabled !== settings.preferenceEnabled || next.preferenceFiltering !== settings.preferenceFiltering;
    const feedbackChanged = next.preferenceFeedbackEnabled !== settings.preferenceFeedbackEnabled;
    const feedbackThresholdChanged = next.preferenceFeedbackThreshold !== settings.preferenceFeedbackThreshold;
    const keywordChanged = next.keywordFeedbackEnabled !== settings.keywordFeedbackEnabled || next.filterKeywords !== settings.filterKeywords;
    settings = next;
    if (changed) {
      generation++; scores.clear(); feedback.clear(); hideMenu();
      state = { count: 0, ready: false, message: settings.preferenceEnabled ? "正在读取本地偏好模型状态…" : "" };
      for (const trigger of document.querySelectorAll(".bili-assistant-preference-trigger")) trigger.hidden = !settings.preferenceEnabled;
      clearTimeout(pumpTimer); clearTimeout(feedbackTimer);
      if (settings.preferenceFiltering) schedulePump();
      notify();
    }
    if (feedbackChanged || feedbackThresholdChanged) {
      generation++; feedback.clear(); clearTimeout(feedbackTimer);
      if (settings.preferenceFiltering && settings.preferenceFeedbackEnabled && state.ready) {
        for (const [id, prediction] of scores) {
          const item = cards.get(id);
          if (item && prediction.score < settings.preferenceFeedbackThreshold && !attempted.has(id)) {
            feedback.set(id, { kind: "preference", id, ...prediction, card: item.card, readCard: item.readCard });
          }
        }
        if (feedback.size) scheduleFeedback(0);
      }
    }
    if (keywordChanged) {
      // 关键词开关变化只撤销排队中的关键词条目，不打断偏好模型推理。
      for (const [id, entry] of feedback) if (entry.kind === "keyword") feedback.delete(id);
      clearTimeout(feedbackTimer);
      if (feedback.size) scheduleFeedback(0);
    }
  }
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.preferenceRevision) {
      notify();
    }
  });
  browser.runtime.onMessage.addListener(message => {
    if (message.type === "preferenceSession" && message.pageId === pageId) {
      sessionActive = message.enabled === true;
      configure(settings);
    }
  });
  const ready = browser.runtime.sendMessage({ type: "preferencePageReady", pageId }).then(value => {
    initialized = true;
    configure(value || {});
    return value || {};
  });
  // 文档离开和从 BFCache 返回都重置开关；标注与 checkpoint 完全不受影响。
  addEventListener("pagehide", () => {
    sessionActive = false; configure(settings);
    browser.runtime.sendMessage({ type: "preferencePageClosed", pageId }).catch(() => {});
  });
  addEventListener("pageshow", event => {
    if (!event.persisted) return;
    sessionActive = false; configure(settings);
    pageId = crypto.randomUUID();
    browser.runtime.sendMessage({ type: "preferencePageReady", pageId }).catch(() => {});
  });
  globalThis.BiliPreferences = {
    configure, ready, isEnabled: () => settings.preferenceEnabled, isFiltering: () => settings.preferenceFiltering,
    queueKeywordFeedback,
    scan(elements, readCard) {
      if (!settings.preferenceEnabled) return;
      cards.clear();
      for (const card of elements) {
        const data = titleData(readCard(card));
        if (!data.title) continue;
        attachMenu(card, readCard);
        cards.set(data.id, { ...data, card, readCard });
      }
      // 只释放已经离开 DOM 的标题；长页面的现有卡片保留评分，避免因缓存淘汰重新出现。
      for (const id of scores.keys()) if (!cards.has(id)) scores.delete(id);
      if (!pumping && !pumpTimer) schedulePump();
    },
    scoreFor(data) {
      const item = titleData(data);
      const prediction = scores.get(item.id);
      return settings.preferenceFiltering && state.ready && state.count > 30 && prediction?.title === item.title && prediction.version === state.modelVersion ? prediction.score : null;
    },
    statusText() {
      if (!settings.preferenceEnabled) return "";
      if (!settings.preferenceFiltering) return "实验偏好：可持续标注 · 详细设置中手动训练模型";
      return `实验偏好：${state.count || 0}/31 条起用 · ${state.message || (state.ready ? "模型已就绪" : "模型未就绪")}${state.pendingUpdate ? " · 新标注待手动训练" : ""}${feedbackMessage ? "\n" + feedbackMessage : ""}`;
    },
    feedbackText() { return feedbackMessage; }
  };
})();
