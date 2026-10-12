
(async () => {
  const checks = [];
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function waitFor(predicate, name) {
    for (let i = 0; i < 100; i++) {
      if (await predicate()) { checks.push(name); return; }
      await sleep(50);
    }
    throw new Error(name);
  }
  try {
    await waitFor(() => [...document.querySelectorAll('iframe')].every(frame => frame.contentDocument?.readyState === 'complete' && frame.contentDocument.querySelector('main')), '页面加载');
    const options = document.querySelector('#options').contentWindow;
    const popup = document.querySelector('#popup').contentWindow;
    const form = options.document.querySelector('form');
    const p = name => popup.document.querySelector(`[data-setting="${name}"]`);
    const stored = async () => browser.runtime.sendMessage({type:'getSettings'});
    await waitFor(() => form.elements.minDuration.value === '60', '初始设置');
    function change(win, field, value) {
      field.type === 'checkbox' ? field.checked = value : field.value = value;
      field.dispatchEvent(new win.Event('input', {bubbles:true}));
      field.dispatchEvent(new win.Event('change', {bubbles:true}));
    }
    for (const name of ['filterAds','filterKeywords','filterDuration','subtitlesEnabled','localFallback']) {
      for (const enabled of [true, false]) {
        change(popup, p(name), enabled);
        await waitFor(async () => (await stored())[name] === enabled && form.elements[name].checked === enabled, `${name}: 弹窗→详细 ${enabled}`);
        change(options, form.elements[name], !enabled);
        await waitFor(async () => (await stored())[name] === !enabled && p(name).checked === !enabled, `${name}: 详细→弹窗 ${!enabled}`);
      }
    }
    change(options, form.elements.minDuration, '180');
    await waitFor(() => popup.document.querySelector('#duration').textContent === '< 180 秒', '时长同步');
    change(options, form.elements.minDuration, '-1');
    change(options, form.elements.filterAds, false);
    await waitFor(async () => !(await stored()).filterAds && !p('filterAds').checked, '其他输入无效仍可保存开关');
    change(popup, p('filterAds'), true);
    await waitFor(() => form.elements.filterAds.checked, '无效输入不阻断弹窗同步');
    change(options, form.elements.minDuration, '180');
    await waitFor(async () => (await stored()).minDuration === 180 && form.elements.minDuration.value === '180', '修正输入');
    const second = document.createElement('iframe'); second.src = 'options.html'; document.body.append(second);
    await waitFor(() => second.contentDocument?.querySelector('[name="minDuration"]')?.value === '180', '新设置页读取保存状态');
    for (let i = 0; i < 12; i++) {
      const enabled = i % 2 === 0;
      change(options, form.elements.localFallback, enabled);
      change(popup, p('filterDuration'), enabled);
      await waitFor(async () => {
        const s = await stored();
        return s.localFallback === enabled && s.filterDuration === enabled && p('localFallback').checked === enabled && form.elements.filterDuration.checked === enabled && second.contentDocument.querySelector('[name="localFallback"]').checked === enabled;
      }, `并发写入与多窗口同步 ${i}`);
    }
    document.querySelector('#result').textContent = JSON.stringify({passed:checks.length, checks});
  } catch (error) { document.querySelector('#result').textContent = JSON.stringify({error:error.message, checks, optionsStatus:document.querySelector('#options').contentDocument?.querySelector('#status')?.textContent, minDuration:document.querySelector('#options').contentDocument?.querySelector('[name="minDuration"]')?.value}); }
})();
