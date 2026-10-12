# 开发与测试

## 文件结构

- `extension/`：Firefox 插件，后台字幕处理、设置同步、偏好标注和会话控制。
- `extension/preference-service.js`：标注持久化、训练调度、评分版本和 Worker 生命周期。
- `extension/preference-store.js`：IndexedDB 训练头保存。
- `src/preference-worker.js`：MiniLM ONNX token 编码、训练与推理队列。
- `src/preference-head.mjs`：TensorFlow.js CPU Transformer + MLP 与 AdamW 训练。
- `src/speech-worker.js`：Whisper CPU WASM 识别。
- `scripts/build-speech.mjs`：打包两个 Worker、WASM 与第三方许可证。
- `scripts/package.mjs`：仅打包 `extension/` 到 XPI。
- `scripts/check-firefox.mjs`、`scripts/firefox/`：独立配置中的真实浏览器检查。
- `tests/`：后台流程、动态 DOM、训练数学与服务生命周期测试。
- `reports/preference-benchmark/`：旧 Python 模型的历史基准报告。

## 检查与打包

需要 Node.js 20 以上和桌面 Firefox 142 以上，无需 Python。

```bash
npm ci --ignore-scripts
npm run build
npm test
npm run lint
npm run test:firefox
npm run cache:preference
npm run test:preference:firefox
npm run package
```

`npm run lint` 需要已安装 `web-ext`。Firefox 检查使用独立临时配置，临时载入测试扩展，不使用日常浏览器数据；可用 `FIREFOX_BIN` 指定 Firefox 路径。设置检查覆盖所有共有开关的双向同步、时长、输入错误隔离与并发保存。

真实偏好检查先用 `cache:preference` 把公开 ONNX 与分词器下载到忽略的 `artifacts/minilm/`。可用 `HF_ENDPOINT` 指定源。检查把这些真实权重预置到独立 Firefox 的 Cache Storage，验证编码、45 轮训练、保存和重启恢复；测试缓存不进入发布 XPI。合成数据仅用于功能验证，不是泛化准确率基准。

训练头数学测试使用迁移前 PyTorch 1.4.2 的固定输出、BCE 损失和参数梯度作为参考，运行测试无需 PyTorch。真实训练测试检查损失下降、掩码隔离、权重重载一致和张量释放。后台与 DOM 测试模拟网络和模型结果；真实 Firefox 检查补充实际 ONNX/WASM 和训练运行。

构建只使用本地安装的 JavaScript 依赖；运行时可执行代码与 WASM 都随插件打包。模型数据首次使用时下载。生成的 `extension/*-worker.js`、`extension/vendor/` 和 `artifacts/` 均由 `.gitignore` 排除。
