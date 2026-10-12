# Bilibili 助手

用于 `https://www.bilibili.com/` 的 Firefox 插件，支持视频过滤、字幕提取和本地个人偏好筛选。

## 功能

- **视频过滤**：隐藏广告、匹配关键词或短于指定时长的视频，支持查看最近 100 条过滤记录。
- **字幕工具**：优先提取 B 站字幕，支持内容预览、官方字幕时间跳转、复制正文和下载 SRT / VTT / TXT。
- **内置语音识别**：无可用字幕时在插件内运行量化 Whisper，默认多语言 `small`，可选更省资源的 `base`，无需 Python 服务。
- **实验性偏好筛选**：插件内 CPU 多语言 MiniLM + Transformer + MLP，通过“很喜欢、喜欢、不喜欢、很不喜欢”训练；超过 30 个不同视频的标注后按自选阈值隐藏，可选自动“不感兴趣”。

功能可独立开关。偏好筛选每次打开或刷新网站后需手动开启；标注与模型保存在本机，重启后可复用。

## 快速开始

需要桌面版 Firefox 142 或以上版本。

1. 克隆项目，在项目目录运行 `npm ci --ignore-scripts` 和 `npm run build`。
2. 打开 Firefox 的 `about:debugging#/runtime/this-firefox`。
3. 点击“临时载入附加组件”，选择 `extension/manifest.json`。
4. 打开或刷新 B 站，通过插件工具栏进入详细设置。

字幕识别首次使用时默认通过 HF Mirror 大陆镜像下载并缓存模型。偏好模型同样在插件内运行，无需 Python；模型下载与安装见[安装指南](docs/installation.md)。

## 文档

- [安装与模型选择](docs/installation.md)
- [使用说明、下载路径与本地数据](docs/usage.md)
- [偏好模型、数据保存与导入](docs/preferences.md)
- [开发、测试与打包](docs/development.md)

浏览器迁移验证见[验证记录](reports/browser-preference-validation.md)。

## 限制

临时加载的插件在 Firefox 退出后卸载，永久安装需经 Mozilla 签名。广告过滤依赖页面推广标记；字幕工具支持普通视频页，画面内烧录字幕通过语音识别回退。站点布局变化可能需要适配，尚未完成真实 B 站页面与音频的端到端验证。

偏好模型只分析标题。保留原 Python 版本的 [150 条合成标题历史报告](reports/preference-benchmark/REPORT.md)，结果仅用于观察学习曲线，不代表真实用户效果。更多限制见[使用说明](docs/usage.md#范围与限制)。
