"""页面会话控制：未开启时不计算，暂停后保留数据。"""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from runtime import PreferencePaused
from preferences import PreferenceService


class RuntimeTests(unittest.TestCase):
    def test_manual_session_controls_training_and_preserves_labels(self):
        with tempfile.TemporaryDirectory() as directory:
            service = PreferenceService(Path(directory))
            try:
                with patch.object(service.executor, "submit") as submit:
                    for index in range(31):
                        service.label({"id": str(index), "title": f"访谈 {index}", "rating": 3})
                    self.assertEqual(submit.call_count, 0, "未开启页面时不加载模型")
                    self.assertFalse(service.status()["runtimeActive"])
                    with self.assertRaises(PreferencePaused):
                        service._check_runtime()
                    service.activate_runtime()
                    service.ensure_training()
                    self.assertEqual(submit.call_count, 1)
                service.training = False
                service.activate_runtime(False)
                with patch.object(service.executor, "submit") as submit:
                    service.ensure_training()
                    self.assertEqual(submit.call_count, 0)
                self.assertEqual(service.status()["count"], 31)
                self.assertTrue((Path(directory) / "labels.json").exists())
                service.activate_runtime()
                self.assertTrue(service._can_compute())
            finally:
                service.close()

    def test_expired_session_blocks_computation(self):
        with tempfile.TemporaryDirectory() as directory:
            service = PreferenceService(Path(directory))
            try:
                with patch("preferences.time.monotonic", return_value=100):
                    service.activate_runtime(ttl=45)
                with patch("preferences.time.monotonic", return_value=146):
                    self.assertFalse(service.status()["runtimeActive"])
                    with self.assertRaises(PreferencePaused):
                        service._check_runtime()
            finally:
                service.close()

    def test_training_checks_session_between_batches(self):
        try:
            import torch
        except ImportError:
            self.skipTest("CPU torch 未安装")
        from preference_model import fit_head
        count = 0
        def session_active():
            nonlocal count
            count += 1
            return count < 2
        with self.assertRaises(PreferencePaused):
            fit_head([torch.zeros((3, 8)) for _ in range(40)], [3] * 40,
                     epochs=2, should_continue=session_active)
        self.assertEqual(count, 2)
