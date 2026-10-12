/* 独立配置中运行真实 Firefox；设置测试与真实 MiniLM 训练测试共用启动器。 */
import { mkdtemp, cp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { spawn } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv[2] || 'settings';
if (!['settings', 'preference'].includes(mode)) throw new Error('用法：node scripts/check-firefox.mjs [settings|preference]');
const temporary = await mkdtemp(path.join(tmpdir(), 'bili-firefox-'));
const source = path.join(temporary, 'extension');
const profile = path.join(temporary, 'profile');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
await cp(path.join(root, 'extension'), source, { recursive: true });
await mkdir(profile);
const server = net.createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
await writeFile(path.join(profile, 'user.js'), `user_pref("marionette.port", ${port});\n`);
const page = `${mode}-check.html`;
const scripts = mode === 'settings' ? '<iframe id="options" src="options.html"></iframe><iframe id="popup" src="popup.html"></iframe>' : '<script src="preference-store.js"></script><script src="preference-service.js"></script>';
await writeFile(path.join(source, page), `<!doctype html><meta charset="utf-8"><pre id="result">running</pre><p id="progress"></p>${scripts}<script src="${mode}-check.js"></script>`);
await cp(path.join(root, 'scripts/firefox', `${mode}-check.js`), path.join(source, `${mode}-check.js`));
const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
manifest.background.scripts.push('check-bootstrap.js');
await writeFile(path.join(source, 'manifest.json'), JSON.stringify(manifest));
await writeFile(path.join(source, 'check-bootstrap.js'), `browser.tabs.create({url:browser.runtime.getURL('${page}')});`);
if (mode === 'preference') {
  const modelRoot = path.join(root, 'artifacts/minilm/Xenova/paraphrase-multilingual-MiniLM-L12-v2');
  try { await access(path.join(modelRoot, 'onnx/model_quantized.onnx')); }
  catch { throw new Error('请先运行 npm run cache:preference，下载真实测试模型。'); }
  await cp(modelRoot, path.join(source, 'test-model'), { recursive: true });
  await cp(path.join(root, 'tests/fixtures/preference_titles.json'), path.join(source, 'preference-titles.json'));
}
const snapBinary = '/snap/firefox/current/usr/lib/firefox/firefox';
let binary = process.env.FIREFOX_BIN || 'firefox';
try { await access(snapBinary); if (!process.env.FIREFOX_BIN) binary = snapBinary; } catch {}
let processHandle, socket, call, log = '';
async function connect() {
  return new Promise((resolve, reject) => {
    const client = net.connect(port, '127.0.0.1');
    client.once('connect', () => resolve(client));
    client.once('error', reject);
  });
}
async function run() {
  processHandle = spawn(binary, ['--headless', '--no-remote', '--profile', profile, '--marionette', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
  processHandle.stdout.on('data', value => { log += value; });
  processHandle.stderr.on('data', value => { log += value; });
  let spawnError;
  processHandle.on('error', error => { spawnError = error; });
  for (let i = 0; i < 100; i++) {
    if (spawnError) throw spawnError;
    try { socket = await connect(); break; } catch { await delay(100); }
  }
  if (!socket) throw new Error(`Firefox Marionette 未启动：${log}`);
  let buffer = Buffer.alloc(0), counter = 0;
  const messages = [], readers = [];
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const colon = buffer.indexOf(58);
      if (colon < 0) break;
      const length = Number(buffer.subarray(0, colon).toString());
      if (buffer.length < colon + 1 + length) break;
      const value = JSON.parse(buffer.subarray(colon + 1, colon + 1 + length).toString());
      buffer = buffer.subarray(colon + 1 + length);
      if (readers.length) readers.shift().resolve(value); else messages.push(value);
    }
  });
  socket.on('error', error => { while (readers.length) readers.shift().reject(error); });
  socket.on('close', () => { while (readers.length) readers.shift().reject(new Error('Firefox disconnected')); });
  const read = () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve, reject) => readers.push({ resolve, reject }));
  await read();
  call = async (name, args = {}) => {
    const data = Buffer.from(JSON.stringify([0, ++counter, name, args]));
    socket.write(Buffer.concat([Buffer.from(`${data.length}:`), data]));
    const result = await read();
    if (result[2]) throw new Error(JSON.stringify(result[2]));
    return result[3];
  };
  const session = await call('WebDriver:NewSession', { capabilities: {} });
  console.log(`Firefox ${session.capabilities.browserVersion}：${mode}`);
  await call('Addon:Install', { path: source, temporary: true });
  let lastProgress = '';
  const deadline = Date.now() + (mode === 'preference' ? 300000 : 30000);
  while (Date.now() < deadline) {
    const handlesResult = await call('WebDriver:GetWindowHandles');
    for (const handle of handlesResult.value || handlesResult) {
      await call('WebDriver:SwitchToWindow', { handle });
      if (!(await call('WebDriver:GetCurrentURL')).value.endsWith('/' + page)) continue;
      const pageSource = (await call('WebDriver:GetPageSource')).value;
      const decode = text => text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      const result = { value: { result: decode(pageSource.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1] || ''), progress: decode(pageSource.match(/<p id="progress">([\s\S]*?)<\/p>/)?.[1] || '') } };
      if (result.value.progress && result.value.progress !== lastProgress) { lastProgress = result.value.progress; console.log(lastProgress); }
      if (result.value.result && result.value.result !== 'running') {
        const report = JSON.parse(result.value.result);
        console.log(JSON.stringify(report, null, 2));
        if (report.error) throw new Error(report.error);
        return report;
      }
    }
    await delay(300);
  }
  throw new Error(`Firefox 检查超时：${lastProgress}`);
}
async function close() {
  if (call && socket && !socket.destroyed) { try { await call('Marionette:Quit', { flags: ['eForceQuit'] }); } catch {} }
  socket?.destroy(); socket = undefined; call = undefined;
  if (processHandle?.exitCode === null) { processHandle.kill(); await delay(300); if (processHandle.exitCode === null) processHandle.kill('SIGKILL'); }
}
try {
  const first = await run();
  await close();
  if (mode === 'preference') {
    const second = await run();
    if (!second.checks.includes('重启后保留31条标注')) throw new Error('重启持久化验证失败');
    if (first.scores.some((item, i) => Math.abs(item.score - second.scores[i].score) > 1e-6)) throw new Error('浏览器重启后评分改变');
    console.log('浏览器重启后的权重与评分保持一致。');
  }
} catch (error) { console.error(log.slice(-3000)); throw error; }
finally { await close(); await rm(temporary, { recursive: true, force: true }); }
