# 安装与模型选择

## Firefox 插件

需要桌面版 Firefox 142 或以上、Node.js 20 或以上。以下命令在项目根目录运行：

```bash
npm ci --ignore-scripts
npm run build
```

安装时跳过未使用的 Node 原生识别依赖初始化。构建会将 Transformers.js 和 ONNX Runtime 的 JavaScript、WASM 打包到扩展目录。

1. Firefox 打开 `about:debugging#/runtime/this-firefox`。
2. 点击“临时载入附加组件”，选择 `extension/manifest.json`。
3. 打开或刷新 B 站，通过插件工具栏进入详细设置。

运行 `npm run package` 可生成 `artifacts/bilibili-assistant-1.6.0.xpi`。

## 内置字幕识别

在字幕设置中开启“官方字幕不可用时，回退到插件内置语音识别”。无需安装 Python、填写令牌或启动服务。官方字幕可用时直接提取，识别模型只在回退任务中加载。

插件在专用 Worker 中运行 **Transformers.js + ONNX Runtime CPU WASM**，使用单线程、8 位量化的多语言 Whisper。音轨由 Firefox 解码为 16 kHz 单声道，按 30 秒片段识别，片段间保留 5 秒上下文；输出带时间戳的原语言字幕。

| 模型 | 用途 | 取舍 |
| --- | --- | --- |
| `small`（默认） | 中文、英文和混合语音 | 较好的识别能力，下载、内存和计算开销更大 |
| `base` | 低内存机器或短视频 | 资源开销较低，复杂语音、口音和专业术语更容易出错 |

模型来自 [Xenova/whisper-small](https://huggingface.co/Xenova/whisper-small) 和 [Xenova/whisper-base](https://huggingface.co/Xenova/whisper-base)。首次使用默认从 HF Mirror 大陆镜像下载模型数据并缓存，后续复用；可在“模型下载源”中切换到 Hugging Face。下载源仅接收公开模型文件请求。可执行代码随插件打包。识别结束释放 Worker 和模型内存。清除扩展数据、移除扩展或浏览器清理缓存后需要重新下载。

语言可选自动、中文或英文，输出不做翻译。浏览器没有 NVIDIA CUDA 加速，CPU 识别速度取决于机器和音频。

## 内置偏好模型

无需安装 Python、填写服务令牌或启动本地进程。插件保留 MiniLM → token Transformer → MLP 结构，编码和训练均在浏览器 CPU Worker 内执行。

开启视频偏好总开关后可持续标注。标注至少 31 个不同视频后，在详细设置点击“训练模型”，开启当前页面筛选只使用已保存的模型；下载源在详细设置中选择。MiniLM 量化权重约 113 MiB、分词器约 16 MiB，训练头保存在浏览器 IndexedDB。完整下载后可离线复用。

旧版 `labels.json` 可在详细设置导入，之后在插件内重新训练。模型使用与数据备份详见[偏好说明](preferences.md)。

## 限制

- 临时插件在 Firefox 退出后卸载；生成的 XPI 未签名，永久安装需要 Mozilla 签名。
- 内置识别支持最长 3 小时、256 MiB 的单个音轨。全量下载和解码会占用内存，长音频的 CPU 识别可能耗时较长。
- Firefox 需要系统提供 AAC/MP4 解码支持；FLV、直播和分段媒体暂不支持。
- 下载模型需要访问所选下载源及其文件 CDN；只有完整缓存的模型才能离线加载。
- Whisper 在音乐、静音、口音和混合语言中可能漏字、重复或产生错误文本。本项目未做中英文准确率和吞吐量基准测试。
