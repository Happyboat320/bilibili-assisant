/* 多语言 Whisper 在专用 Worker 内运行，避免阻塞 B 站和扩展界面。 */
import { env, pipeline } from '@huggingface/transformers';

env.allowLocalModels = false;
env.useBrowserCache = true;
// WASM 与 JavaScript 随插件打包，只有模型数据需要首次联网下载。
env.backends.onnx.wasm.wasmPaths = new URL('./vendor/', self.location.href).href;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;

self.onmessage = async ({ data }) => {
  try {
    env.remoteHost = data.modelSource === 'huggingface' ? 'https://huggingface.co/' : 'https://hf-mirror.com/';
    const model = data.model === 'base' ? 'Xenova/whisper-base' : 'Xenova/whisper-small';
    const recognizer = await pipeline('automatic-speech-recognition', model, {
      device: 'wasm', dtype: 'q8',
      progress_callback: progress => {
        if (progress.status === 'progress') {
          self.postMessage({ type: 'progress', message: `正在准备内置模型：${progress.file} ${Math.round(progress.progress || 0)}%` });
        }
      }
    });
    self.postMessage({ type: 'progress', message: '内置 Whisper 正在识别音频…' });
    let chunks = 0;
    const result = await recognizer(data.audio, {
      task: 'transcribe', return_timestamps: true, chunk_length_s: 30, stride_length_s: 5,
      ...(data.language === 'auto' ? {} : { language: data.language === 'zh' ? 'chinese' : 'english' }),
      chunk_callback: () => self.postMessage({ type: 'progress', message: `内置 Whisper 正在识别：已处理 ${++chunks} 个音频片段…` })
    });
    const duration = data.audio.length / 16000;
    const cues = (result.chunks || []).map((chunk, index, all) => ({
      from: Math.max(0, chunk.timestamp[0] ?? 0),
      to: Math.min(duration, chunk.timestamp[1] ?? all[index + 1]?.timestamp[0] ?? duration),
      content: chunk.text.trim()
    })).filter(cue => cue.content && cue.to > cue.from);
    if (!cues.length) throw new Error('未识别到有效语音。');
    self.postMessage({ type: 'done', cues, language: data.language === 'auto' ? 'auto' : data.language });
  } catch (error) {
    self.postMessage({ type: 'error', message: `内置识别失败：${error.message}` });
  }
};

self.postMessage({ type: 'ready' });
