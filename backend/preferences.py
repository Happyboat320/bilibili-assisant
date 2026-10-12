"""偏好数据持久化、异步训练和标题推理；关闭实验功能时不加载 torch 或模型。"""
from __future__ import annotations

import json
import logging
import os
import secrets
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from runtime import PreferencePaused

MIN_SAMPLES = 31
MAX_LABELS = 2000
EMBEDDING_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
LOGGER = logging.getLogger("bilibili-assistant")


class PreferenceService:
    def __init__(self, directory: Path):
        self.directory = directory
        self.lock = threading.RLock()
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="bili-preference")
        self.labels = OrderedDict()
        self.revision = 0
        self.trained_revision = -1
        self.training = False
        self.message = "标注超过 30 个不同视频后才启动模型。"
        self.encoder = None
        self.head = None
        self.feature_cache = OrderedDict()
        self.tasks = {}
        self.last_failure = 0.0
        self.runtime_until = 0.0
        dataset = directory / "labels.json"
        if dataset.exists():
            data = json.loads(dataset.read_text(encoding="utf-8"))
            self.revision = int(data.get("revision", 0))
            for item in data.get("labels", [])[-MAX_LABELS:]:
                if item.get("rating") in (0, 1, 2, 3) and item.get("title") and item.get("id"):
                    self.labels[item["id"]] = item

    def _save(self):
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        temporary = self.directory / "labels.tmp"
        temporary.write_text(json.dumps({"revision": self.revision, "labels": list(self.labels.values())}, ensure_ascii=False), encoding="utf-8")
        os.chmod(temporary, 0o600)
        temporary.replace(self.directory / "labels.json")

    def status(self):
        with self.lock:
            active = time.monotonic() < self.runtime_until
            counts = [sum(v["rating"] == rating for v in self.labels.values()) for rating in range(4)]
            return {"count": len(self.labels), "minimum": MIN_SAMPLES, "revision": self.revision,
                    "modelVersion": self.trained_revision, "training": self.training,
                    "ready": active and len(self.labels) >= MIN_SAMPLES and self.head is not None and not self.training and self.trained_revision == self.revision,
                    "counts": counts, "message": "本页尚未手动开启或会话已结束；模型和标注保留。" if not active else self.message,
                    "runtimeActive": active, "embeddingModel": EMBEDDING_MODEL, "device": "cpu"}

    def activate_runtime(self, enabled=True, ttl=45):
        # 页面每 10 秒续约。关闭浏览器 / 掉线后，最多 45 秒在下一计算批次暂停。
        self.runtime_until = time.monotonic() + ttl if enabled else 0.0

    def _can_compute(self):
        return time.monotonic() < self.runtime_until

    def _check_runtime(self):
        if not self._can_compute():
            raise PreferencePaused("偏好计算暂停（页面会话结束）")

    def label(self, item: dict):
        with self.lock:
            key = item["id"]
            old = self.labels.get(key)
            # 重复点击同一评级不计新样本，也不触发重复训练。
            if not old or old["rating"] != item["rating"] or old["title"] != item["title"]:
                self.labels.pop(key, None)
                self.labels[key] = {**item, "updated": time.time()}
                while len(self.labels) > MAX_LABELS:
                    self.labels.popitem(last=False)
                self.revision += 1
                self._save()
            self.ensure_training()
            return self.status()

    def ensure_training(self):
        with self.lock:
            cooling_down = self.last_failure and time.monotonic() - self.last_failure < 60
            if not self._can_compute() or len(self.labels) < MIN_SAMPLES or self.training or self.trained_revision == self.revision or cooling_down:
                return
            self.training = True
            self.message = "准备 CPU 偏好模型，首次使用需下载 MiniLM 权重…"
            self.executor.submit(self._train_loop)

    def _load_encoder(self):
        self._check_runtime()
        if self.encoder is not None:
            return
        import torch
        from sentence_transformers import SentenceTransformer
        # 限制 CPU 线程数，避免浏览器和本地字幕服务被训练任务占满。
        torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
        self.encoder = SentenceTransformer(EMBEDDING_MODEL, device="cpu", cache_folder=str(self.directory / "embedding"), trust_remote_code=False)
        self._check_runtime()
        self.encoder.max_seq_length = 48
        self.encoder.eval()
        for parameter in self.encoder.parameters():
            parameter.requires_grad_(False)

    def _features(self, titles):
        import torch
        self._load_encoder()
        missing = list(dict.fromkeys(title for title in titles if title not in self.feature_cache))
        computed = {}
        for offset in range(0, len(missing), 16):
            self._check_runtime()
            batch = missing[offset:offset + 16]
            tokens = self.encoder.tokenize(batch)
            # 读取 token 级嵌入，使新增 Transformer 有真正的多 token 序列输入。
            with torch.inference_mode():
                output = self.encoder[0](tokens)
                for index, title in enumerate(batch):
                    length = int(output["attention_mask"][index].sum())
                    # inference_mode 的张量复制成普通张量后，才能用于可训练 Linear 的反传。
                    computed[title] = output["token_embeddings"][index, :length].detach().cpu()
        result = []
        for title in titles:
            if title in computed:
                tensor = computed[title].clone()
                self.feature_cache[title] = tensor
            else:
                tensor = self.feature_cache[title]
                self.feature_cache.move_to_end(title)
            result.append(tensor)
        # 训练时保留局部 result，常驻缓存只保存最近 256 个标题。
        while len(self.feature_cache) > 256:
            self.feature_cache.popitem(last=False)
        return result

    def _train_loop(self):
        try:
            import torch
            from preference_model import PreferenceHead, fit_head
            while True:
                with self.lock:
                    if len(self.labels) < MIN_SAMPLES:
                        break
                    revision = self.revision
                    snapshot = list(self.labels.values())
                    self.message = f"正在训练 CPU Transformer + MLP：{len(snapshot)} 条标注…"
                self._load_encoder()
                checkpoint = self.directory / "head.pt"
                saved = torch.load(checkpoint, map_location="cpu", weights_only=True) if checkpoint.exists() else None
                if saved and saved.get("revision") == revision and saved.get("embeddingModel") == EMBEDDING_MODEL:
                    head = PreferenceHead(saved["dimension"])
                    head.load_state_dict(saved["state_dict"])
                    head.eval()
                else:
                    features = self._features([item["title"] for item in snapshot])
                    head = fit_head(features, [item["rating"] for item in snapshot], should_continue=self._can_compute)
                with self.lock:
                    self._check_runtime()
                    # 训练过程中修改了标注，就重新训练最新快照，绝不发布旧版本。
                    if self.revision != revision:
                        continue
                    temporary = self.directory / "head.tmp"
                    torch.save({"revision": revision, "embeddingModel": EMBEDDING_MODEL,
                                "dimension": head.project.in_features, "state_dict": head.state_dict()}, temporary)
                    os.chmod(temporary, 0o600)
                    temporary.replace(checkpoint)
                    self.head = head
                    self.trained_revision = revision
                    self.message = "CPU 偏好模型已就绪。分数是偏好估计，不是校准后的概率。"
                    break
        except PreferencePaused:
            with self.lock:
                self.message = "页面会话结束，偏好计算已暂停；标注和已保存的模型保留。"
        except Exception as error:
            LOGGER.error("偏好训练失败：%s", type(error).__name__)
            with self.lock:
                self.last_failure = time.monotonic()
                self.message = "偏好模型加载或训练失败，请安装可选 CPU 依赖并检查 Hugging Face 下载网络。视频不会因错误被隐藏。"
        finally:
            with self.lock:
                self.training = False

    def score(self, items):
        self.ensure_training()
        with self.lock:
            state = self.status()
            if not state["ready"]:
                return {**state, "scores": []}
            now = time.time()
            for key in list(self.tasks):
                if self.tasks[key]["status"] in {"done", "failed"} and now - self.tasks[key]["updated"] > 600:
                    del self.tasks[key]
            if sum(t["status"] == "queued" for t in self.tasks.values()) >= 2:
                return {**state, "ready": False, "message": "偏好推理队列繁忙，稍后重试。", "scores": []}
            completed = [key for key, task in self.tasks.items() if task["status"] in {"done", "failed"}]
            for key in completed[:-18]:
                del self.tasks[key]
            task_id = secrets.token_urlsafe(18)
            self.tasks[task_id] = {"status": "queued", "updated": now}
            self.executor.submit(self._predict, task_id, items, self.revision)
            return {**state, "taskId": task_id}

    def _predict(self, task_id, items, revision):
        try:
            import torch
            from preference_model import pack_features
            features = self._features([item["title"] for item in items])
            self._check_runtime()
            with torch.inference_mode():
                embeddings, mask = pack_features(features)
                scores = torch.sigmoid(self.head(embeddings, mask)).tolist()
            with self.lock:
                valid = self.revision == revision and self.status()["ready"]
                self.tasks[task_id] = {"status": "done", "ready": valid, "modelVersion": revision,
                    "scores": [{"id": item["id"], "title": item["title"], "score": score} for item, score in zip(items, scores)] if valid else [],
                    "updated": time.time()}
        except PreferencePaused:
            with self.lock:
                self.tasks[task_id] = {"status": "done", "ready": False, "scores": [], "message": "页面会话结束，偏好推理已暂停。", "updated": time.time()}
        except Exception as error:
            LOGGER.error("偏好推理失败：%s", type(error).__name__)
            with self.lock:
                self.tasks[task_id] = {"status": "failed", "message": "标题偏好推理失败，视频保持可见。", "updated": time.time()}

    def task(self, task_id):
        with self.lock:
            task = self.tasks.get(task_id)
            return {k: v for k, v in task.items() if k != "updated"} if task else None

    def remove_task(self, task_id):
        with self.lock:
            if self.tasks.get(task_id, {}).get("status") in {"done", "failed"}:
                self.tasks.pop(task_id, None)

    def reset(self):
        with self.lock:
            self.labels.clear()
            self.revision += 1
            self.trained_revision = -1
            self.head = None
            self.last_failure = 0.0
            # 线程可能仍在编码，版本校验会丢弃其结果；避免并发清理它正使用的缓存。
            self._save()
            (self.directory / "head.pt").unlink(missing_ok=True)
            self.message = "偏好标注及训练头已清空；基础嵌入权重保留以便复用。"
            return self.status()

    def close(self):
        self.executor.shutdown(wait=True)
