# 内置偏好模型迁移计划

## 目标

运行时完全移除 Python 服务，保留多语言 MiniLM 的 384 维 token 特征、48 token 截断、可训练投影、CLS 与位置参数、单层 64 维四头 Transformer（前置 LayerNorm、128 维 ReLU 前馈）和 LayerNorm → 32 维 GELU → 单输出 MLP。保留四级标注、31 条启动门槛、45 epochs、AdamW、梯度裁剪及页面会话控制。

## 实施顺序（已实现）

1. 迁移训练头到 TensorFlow.js CPU，在 Worker 内完成反向传播；使用 ONNX/WASM 加载量化 MiniLM，输出 token 特征而不是句向量。验证掩码、梯度、损失下降和保存重载。
2. 实现插件内偏好服务。标注保存在 browser.storage.local，训练头保存在 IndexedDB，基础模型由 Cache Storage 缓存。训练和推理串行，更新标注废弃旧评分，所有页面关闭后终止 Worker。支持原 Python labels.json 导入和标注导出。
3. 替换后台 HTTP 请求和设置中的服务令牌，移除 localhost 权限。验证默认关闭、30/31 门槛、多页面会话、错误恢复、真实编码器推理和真实 Firefox 中的训练及重载。
4. 更新使用、安装、开发文档；移除 Python 服务与不再适用的脚本，构建、打包和浏览器验证统一使用 Node.js。旧基准报告明确标为 Python 版本历史结果。打包并提交最终版本。

## 验收

- 不启动 Python，不请求 localhost，即可标注、训练、评分和筛选。
- 不把基础模型替换成随机或词袋特征，不简化为句向量或逻辑回归。
- Worker 内真实训练，关闭会话停止计算；浏览器重启后标注与已完成权重保留。
- 自动测试与独立 Firefox 实测覆盖数据保存、恢复、训练、推理和关闭。
