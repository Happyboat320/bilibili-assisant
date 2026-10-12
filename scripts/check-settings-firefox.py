"""在独立 Firefox 配置中验证真实后台与两处设置页面的双向同步。"""
import html
import json
import re
import shutil
import socket
import subprocess
import tempfile
import time
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
# Snap 包装器无法访问系统临时目录，独立测试直接使用包内二进制。
snap_binary = Path("/snap/firefox/current/usr/lib/firefox/firefox")
firefox_binary = str(snap_binary) if snap_binary.exists() else shutil.which("firefox")
if not firefox_binary:
    raise SystemExit("请先安装 Firefox。")
with tempfile.TemporaryDirectory(prefix="settings-check-") as temp:
    temp = Path(temp)
    extension = temp / "extension"
    shutil.copytree(root / "extension", extension)
    options_source = (extension / "options.js").read_text()
    options_source = 'window.addEventListener("unhandledrejection", event => { document.querySelector("#status").textContent = event.reason?.message || String(event.reason); });\n' + options_source
    (extension / "options.js").write_text(options_source)
    manifest = json.loads((extension / "manifest.json").read_text())
    manifest["background"]["scripts"].append("settings-check-bootstrap.js")
    (extension / "manifest.json").write_text(json.dumps(manifest))
    (extension / "settings-check-bootstrap.js").write_text("browser.tabs.create({url:browser.runtime.getURL('settings-check.html')});")
    (extension / "settings-check.html").write_text('<!doctype html><meta charset="utf-8"><pre id="result">running</pre><iframe id="options" src="options.html"></iframe><iframe id="popup" src="popup.html"></iframe><script src="settings-check.js"></script>')
    (extension / "settings-check.js").write_text(r'''
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
''')
    archive = temp / "settings-check.xpi"
    with ZipFile(archive, "w", ZIP_DEFLATED) as z:
        for file in extension.rglob("*"):
            if file.is_file():
                z.write(file, file.relative_to(extension))
    profile = temp / "profile"
    profile.mkdir()
    port = 2831
    (profile / "user.js").write_text(f'user_pref("marionette.port", {port});\nuser_pref("remote.prefs.recommended", true);\n')
    with (temp / "firefox.log").open("w") as log:
        process = subprocess.Popen([firefox_binary, "--headless", "--no-remote", "--profile", str(profile), "--marionette", "about:blank"], stdout=log, stderr=log)
        sock = None
        try:
            for _ in range(100):
                try:
                    sock = socket.create_connection(("127.0.0.1", port), timeout=5)
                    break
                except OSError:
                    if process.poll() is not None:
                        raise RuntimeError((temp / "firefox.log").read_text())
                    time.sleep(0.1)
            if not sock:
                raise RuntimeError("Firefox Marionette 未启动")
            def read():
                length = b""
                while True:
                    c = sock.recv(1)
                    if not c:
                        raise RuntimeError("Firefox disconnected")
                    if c == b":":
                        break
                    length += c
                body = b""
                while len(body) < int(length):
                    body += sock.recv(int(length) - len(body))
                return json.loads(body)
            counter = 0
            def call(name, args=None):
                global counter
                counter += 1
                data = json.dumps([0, counter, name, args or {}]).encode()
                sock.sendall(str(len(data)).encode() + b":" + data)
                result = read()
                if result[2]:
                    raise RuntimeError(result[2])
                return result[3]
            read()
            session = call("WebDriver:NewSession", {"capabilities": {}})
            print("Firefox", session["capabilities"]["browserVersion"], flush=True)
            call("Addon:Install", {"path": str(archive), "temporary": True})
            result = None
            for _ in range(200):
                handles = call("WebDriver:GetWindowHandles")
                if isinstance(handles, dict):
                    handles = handles["value"]
                for handle in handles:
                    call("WebDriver:SwitchToWindow", {"handle": handle})
                    if not call("WebDriver:GetCurrentURL")["value"].endswith("/settings-check.html"):
                        continue
                    source = call("WebDriver:GetPageSource")["value"]
                    match = re.search(r'<pre id="result">(.*?)</pre>', source, re.S)
                    if match and match.group(1) != "running":
                        result = json.loads(html.unescape(match.group(1)))
                        break
                if result:
                    break
                time.sleep(0.1)
            if not result:
                raise RuntimeError("设置检查超时")
            print(json.dumps(result, ensure_ascii=False, indent=2))
            if "error" in result: print((temp / "firefox.log").read_text()[-12000:])
            if "error" in result:
                raise SystemExit(1)
        finally:
            if sock:
                try:
                    call("Marionette:Quit", {"flags": ["eForceQuit"]})
                except (OSError, RuntimeError):
                    pass
                sock.close()
            try:
                process.terminate()
            except PermissionError:
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    process.kill()
                    process.wait(timeout=5)
                except (PermissionError, subprocess.TimeoutExpired):
                    pass
