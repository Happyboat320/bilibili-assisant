# 开发与测试

## 文件结构

```text
bilibili-assistant/
  extension/              Firefox 扩展（中文 UI 与注释）
    manifest.json         权限、页面匹配和后台声明
    shared.js             过滤逻辑、字幕格式化
    wbi.js                B 站 WBI 参数签名
    background.js         官方字幕、内置识别调度、文件下载
    speech.js             音轨下载、解码、识别队列
    speech-worker.js      构建生成的模型 Worker
    vendor/               构建生成的 WASM 与第三方许可证
    content.js            视频卡片识别与页面字幕按钮
    preference.js         卡片标注菜单、批量标题评分与可选反馈
    options.* / popup.*   设置页与工具栏弹窗
  backend/
    server.py             外置偏好 API 与令牌认证
    requirements.txt      基础运行依赖
    requirements-preference.txt  可选偏好依赖
    preferences.py        个人数据、异步训练及推理任务
    preference_model.py   CPU Transformer + MLP
    runtime.py            页面会话暂停信号
    tests/                本地接口与安全边界测试
  tests/                  扩展流程及动态 DOM 测试
  src/speech-worker.js    内置 Whisper Worker 源码
  scripts/build-speech.mjs  浏览器 CPU WASM 构建
  scripts/package.py      仅打包 extension/ 的 XPI 工具
  scripts/benchmark_preferences.py  20–120 样本学习曲线
  tests/fixtures/         150 条模拟标题
  reports/preference-benchmark/     实测报告、分数与 CSV
  docs/                   安装、使用与开发文档
  artifacts/              生成的插件包
```

## 检查与打包

在项目目录运行：

```bash
npm ci --ignore-scripts
npm run build
npm test
python3 scripts/check-settings-firefox.py
npm install -g web-ext
npm run lint
npm run package
```

Firefox 设置检查使用独立临时配置，临时载入测试插件，验证五个共有开关的双向同步、时长更新、无效输入隔离和多窗口同时保存；不会使用日常浏览器配置。

后端接口测试不需下载基础模型；安装 CPU torch 后还会运行真实训练头测试（未安装时明确跳过相应测试）：

```bash
python3 -m venv .test-venv
.test-venv/bin/python -m pip install -r backend/requirements.txt 'httpx>=0.27,<1'
.test-venv/bin/python -m pip install --index-url https://download.pytorch.org/whl/cpu 'torch>=2.6,<3'
.test-venv/bin/python -m unittest discover -s backend/tests -v
```

测试覆盖过滤边界、动态卡片与关闭恢复、字幕预览和播放跳转、跨分 P 隔离、剪贴板导出、下载路径、历史去重与 100 条上限、历史安全渲染和清空、字幕格式、WBI、官方字幕优先与内置回退、认证、音轨 URL 校验、16 kHz 单声道解码、识别排队与页面关闭取消；新增偏好功能默认关闭、30/31 条门槛、标注更新、CPU 训练 / 重载 / 推理、低分隐藏与关闭恢复、原生菜单及限速反馈、会话关闭 / 重开以及模型持久化。单元测试中的网络、字幕识别结果及 MiniLM token 特征使用模拟数据；Transformer + MLP 的训练、保存、重载和评分使用真实 CPU PyTorch。另外的 150 标题学习曲线使用真实预训练 MiniLM 和训练头。仍未完成真实 B 站登录页面与实际音频的端到端验证。

构建只打包浏览器 CPU WASM 运行时；字幕模型数据首次使用时下载。`src/` 保留可审阅源代码，`extension/speech-worker.js` 和 `extension/vendor/` 是生成文件，已加入 `.gitignore`。更新依赖后重新运行构建。

Firefox 155 的独立配置实测已验证：生成的模型 Worker 启动、HTTP 模型数据的 Cache Storage 读写、CPU WASM 的 ONNX 推理，以及 16 kHz 音频解码。完整 Whisper 识别和真实 B 站音轨仍需端到端验证。
