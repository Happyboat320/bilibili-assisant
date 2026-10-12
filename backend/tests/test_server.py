"""外置服务只处理偏好数据，保留 HTTP 认证边界。"""
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from server import create_app
from preferences import PreferenceService


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.service = PreferenceService(Path(self.temp.name))
        self.client = TestClient(create_app("a" * 32, self.service))
        self.headers = {"Authorization": "Bearer " + "a" * 32, "Origin": "moz-extension://test"}

    def tearDown(self):
        self.service.close()
        self.temp.cleanup()

    def test_auth_origin_and_host(self):
        self.assertEqual(self.client.get("/v1/health").status_code, 401)
        for extra in [{"Origin": "https://www.bilibili.com"}, {"Host": "evil.example"}]:
            self.assertEqual(self.client.get("/v1/health", headers={**self.headers, **extra}).status_code, 403)
        response = self.client.get("/v1/health", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["service"], "preferences")
        self.assertEqual(response.headers["access-control-allow-origin"], "moz-extension://test")

    def test_preflight_and_request_size(self):
        response = self.client.options("/v1/preferences/labels", headers={"Origin": "moz-extension://test"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["access-control-allow-headers"], "Authorization, Content-Type")
        self.assertEqual(self.client.post("/v1/preferences/labels", content="x" * 65537, headers=self.headers).status_code, 413)

    def test_speech_api_removed(self):
        self.assertEqual(self.client.post("/v1/jobs", json={}, headers=self.headers).status_code, 404)
