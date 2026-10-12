"""偏好门槛、持久化和真实 CPU Transformer 训练测试，不下载基础模型。"""
import importlib.util
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from preferences import PreferenceService
from server import create_app
from fastapi.testclient import TestClient

HAS_TORCH = importlib.util.find_spec("torch") is not None


def wait_for(predicate, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError("异步偏好任务未在预期时间内完成")


class PreferenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.service = PreferenceService(self.directory)
        self.service.activate_runtime(ttl=3600)

    def tearDown(self):
        self.service.close()
        self.temp.cleanup()

    def label(self, index, rating=3):
        return self.service.label({"id": f"video:{index}", "title": f"视频 {index}", "rating": rating})

    def test_strict_31_gate_duplicate_update_and_persistence(self):
        with patch.object(self.service.executor, "submit") as submit:
            for index in range(30):
                self.label(index)
            self.assertEqual(submit.call_count, 0)
            self.assertIsNone(self.service.encoder)
            result = self.service.score([{"id": "test", "title": "未标注视频"}])
            self.assertFalse(result["ready"])
            self.assertEqual(result["scores"], [])
            revision = self.service.revision
            self.label(1)
            self.assertEqual(self.service.revision, revision)
            self.label(1, rating=0)
            self.assertEqual(len(self.service.labels), 30)
            self.assertEqual(submit.call_count, 0)
            self.label(30)
            self.assertEqual(submit.call_count, 1)
        reloaded = PreferenceService(self.directory)
        try:
            self.assertEqual(reloaded.status()["count"], 31)
            self.assertEqual(reloaded.labels["video:1"]["rating"], 0)
            self.assertIsNone(reloaded.encoder, "重启时不自动加载基础模型")
        finally:
            reloaded.close()

    def test_authenticated_api_validation_and_reset(self):
        client = TestClient(create_app("a" * 32, self.service))
        headers = {"Authorization": "Bearer " + "a" * 32}
        self.assertEqual(client.post("/v1/preferences/labels", json={"id": "1", "title": "视频", "rating": 3}).status_code, 401)
        self.assertEqual(client.post("/v1/preferences/labels", json={"id": "1", "title": "视频", "rating": 3}, headers=headers).status_code, 200)
        for rating in [-1, 4, True, 1.5]:
            self.assertEqual(client.post("/v1/preferences/labels", json={"id": "2", "title": "视频", "rating": rating}, headers=headers).status_code, 422)
        response = client.post("/v1/preferences/score", json={"items": [{"id": "2", "title": "标题"}]}, headers=headers)
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["ready"])
        self.assertEqual(client.post("/v1/preferences/score", json={"items": []}, headers=headers).status_code, 422)
        self.assertEqual(client.get("/v1/preferences/status", headers=headers).json()["count"], 1)
        self.assertEqual(client.delete("/v1/preferences", headers=headers).json()["count"], 0)
        self.assertFalse(client.get("/v1/preferences/status", headers=headers).json()["ready"])

    @unittest.skipUnless(HAS_TORCH, "需安装 CPU torch 才运行真实 Transformer 训练测试")
    def test_real_cpu_training_scoring_restore_and_reset(self):
        import torch
        torch.set_num_threads(2)

        def features(titles):
            # 人造嵌入只替代基础编码器，偏好头、优化器、checkpoint 和推理全是真实实现。
            return [torch.full((4, 8), 1.0 if "喜欢" in title else -1.0) for title in titles]

        with patch.object(self.service, "_load_encoder"), patch.object(self.service, "_features", side_effect=features):
            for index in range(31):
                self.service.label({"id": str(index), "title": f"{'喜欢' if index % 2 else '讨厌'} {index}", "rating": 3 if index % 2 else 0})
            wait_for(lambda: not self.service.status()["training"])
            self.assertTrue(self.service.status()["ready"], self.service.status()["message"])
            self.assertEqual(next(self.service.head.parameters()).device.type, "cpu")
            task = self.service.score([{"id": "good", "title": "喜欢测试"}, {"id": "bad", "title": "讨厌测试"}])
            wait_for(lambda: self.service.task(task["taskId"])["status"] != "queued")
            result = self.service.task(task["taskId"])
            self.assertEqual(result["status"], "done")
            self.assertGreater(result["scores"][0]["score"], 0.7)
            self.assertLess(result["scores"][1]["score"], 0.3)
            self.assertTrue((self.directory / "head.pt").exists())
        restored = PreferenceService(self.directory)
        self.assertEqual(restored.status()["count"], 31)
        self.assertFalse(restored.status()["runtimeActive"], "重启服务不得自动恢复页面开关")
        self.assertIsNone(restored.head, "重启时只读标签，不自动加载训练头")
        restored.activate_runtime(ttl=3600)
        try:
            with patch.object(restored, "_load_encoder"), patch.object(restored, "_features", side_effect=features), patch("preference_model.fit_head", side_effect=AssertionError("已保存版本不应重新训练")):
                restored.ensure_training()
                wait_for(lambda: not restored.status()["training"])
                self.assertTrue(restored.status()["ready"], restored.status()["message"])
            result = restored.reset()
            self.assertEqual(result["count"], 0)
            self.assertFalse(result["ready"])
            self.assertFalse((self.directory / "head.pt").exists())
        finally:
            restored.close()

    @unittest.skipUnless(HAS_TORCH, "需 CPU torch")
    def test_token_features_are_frozen_and_trainable_head_works(self):
        import torch
        from preference_model import fit_head
        class Encoder:
            def tokenize(self, batch):
                return {"input_ids": torch.ones((len(batch), 4), dtype=torch.long)}
            def __getitem__(self, index):
                return lambda tokens: {"attention_mask": torch.ones_like(tokens["input_ids"]),
                                      "token_embeddings": torch.randn((len(tokens["input_ids"]), 4, 8))}
        self.service.encoder = Encoder()
        result = self.service._features(["中文视频", "English title"])
        self.assertEqual(result[0].shape, (4, 8))
        self.assertFalse(result[0].requires_grad)
        self.assertFalse(result[0].is_inference(), "训练头不能接收 inference-mode 的张量")
        head = fit_head(result, [0, 3], epochs=1)
        self.assertFalse(head.training)

    def test_training_failure_keeps_videos_visible_and_cooldown(self):
        with patch.object(self.service.executor, "submit"):
            for index in range(31):
                self.label(index)
        with patch.object(self.service, "_load_encoder", side_effect=ImportError("可选依赖未安装")):
            self.service._train_loop()
        self.assertFalse(self.service.status()["ready"])
        with patch.object(self.service.executor, "submit") as submit:
            self.service.score([{"id": "test", "title": "视频"}])
            self.assertEqual(submit.call_count, 0, "失败后不得不停重试加载")


if __name__ == "__main__":
    unittest.main()
