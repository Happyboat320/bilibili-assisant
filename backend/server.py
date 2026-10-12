"""实验性视频偏好的外置本机服务；字幕识别由 Firefox 插件运行。"""
from __future__ import annotations
import logging
import os
import secrets
from pathlib import Path
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from preferences import PreferenceService

ROOT = Path(__file__).resolve().parent
RUNTIME = ROOT / ".runtime"


def read_token() -> str:
    """令牌首次生成后保存，服务重启不必重新配置插件。"""
    configured = os.environ.get("BILI_ASSISTANT_TOKEN", "").strip()
    if configured:
        if len(configured) < 24:
            raise RuntimeError("BILI_ASSISTANT_TOKEN 至少需要 24 个字符。")
        return configured
    RUNTIME.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = RUNTIME / "token"
    if not path.exists():
        try:
            with path.open("x", encoding="utf-8") as handle:
                os.chmod(path, 0o600)
                handle.write(secrets.token_urlsafe(32))
        except FileExistsError:
            pass
    token = path.read_text(encoding="utf-8").strip()
    if len(token) < 24:
        raise RuntimeError(".runtime/token 无效，请重新配置令牌。")
    return token


class PreferenceItem(BaseModel):
    id: str = Field(min_length=1, max_length=512)
    title: str = Field(min_length=1, max_length=300)


class PreferenceLabel(PreferenceItem):
    rating: int = Field(ge=0, le=3, strict=True)


class PreferenceBatch(BaseModel):
    items: list[PreferenceItem] = Field(min_length=1, max_length=20)


class PreferenceRuntime(BaseModel):
    enabled: bool


def create_app(token: str, preferences=None) -> FastAPI:
    app = FastAPI(title="Bilibili 助手本地服务", docs_url=None, redoc_url=None, openapi_url=None)
    preferences = preferences or PreferenceService(RUNTIME / "preferences")

    @app.middleware("http")
    async def guard(request: Request, call_next):
        # 限制 Host 防 DNS rebinding；网页 Origin 不允许访问，即使本机浏览器可发请求。
        origin = request.headers.get("origin", "")
        host = request.headers.get("host", "")
        if host not in {"127.0.0.1:8767", "127.0.0.1", "testserver"}:
            return JSONResponse({"detail": "非法 Host"}, status_code=403)
        if origin and not origin.startswith("moz-extension://"):
            return JSONResponse({"detail": "仅 Firefox 扩展可访问"}, status_code=403)
        if request.method == "OPTIONS":
            response = JSONResponse({"ok": True})
        else:
            supplied = request.headers.get("authorization", "")
            if not secrets.compare_digest(supplied, "Bearer " + token):
                return JSONResponse({"detail": "令牌无效"}, status_code=401)
            # 在 JSON 解析前限制请求体；也覆盖没有 Content-Length 的分块请求。
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > 65536:
                    return JSONResponse({"detail": "请求体过大"}, status_code=413)
            request._body = bytes(body)
            response = await call_next(request)
        if origin:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
            response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
        return response

    @app.get("/v1/health")
    def health():
        return {"ok": True, "device": "cpu", "service": "preferences"}

    @app.get("/v1/preferences/status")
    def preference_status(active: bool = False):
        if active:
            preferences.activate_runtime()
        return preferences.status()

    @app.post("/v1/preferences/runtime")
    def preference_runtime(payload: PreferenceRuntime):
        preferences.activate_runtime(payload.enabled)
        return preferences.status()

    @app.post("/v1/preferences/labels")
    def preference_label(payload: PreferenceLabel):
        if not payload.title.strip() or not payload.id.strip():
            raise HTTPException(400, "标题及标识不能为空")
        preferences.activate_runtime()
        return preferences.label({"id": payload.id.strip(), "title": payload.title.strip(), "rating": payload.rating})

    @app.post("/v1/preferences/score")
    def preference_score(payload: PreferenceBatch):
        if any(not item.title.strip() or not item.id.strip() for item in payload.items):
            raise HTTPException(400, "标题及标识不能为空")
        preferences.activate_runtime()
        return preferences.score([{"id": item.id.strip(), "title": item.title.strip()} for item in payload.items])

    @app.get("/v1/preferences/tasks/{task_id}")
    def preference_task(task_id: str):
        result = preferences.task(task_id)
        if result is None:
            raise HTTPException(404, "偏好推理任务不存在或已过期")
        return result

    @app.delete("/v1/preferences/tasks/{task_id}")
    def remove_preference_task(task_id: str):
        preferences.remove_task(task_id)
        return {"ok": True}

    @app.delete("/v1/preferences")
    def reset_preferences():
        return preferences.reset()

    return app


if __name__ == "__main__":
    import uvicorn
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    auth_token = read_token()
    print(f"\nBilibili 助手偏好服务：http://127.0.0.1:8767\n设备：CPU\n"
          f"请将以下令牌复制到插件偏好设置：\n{auth_token}\n", flush=True)
    preference_service = PreferenceService(RUNTIME / "preferences")
    try:
        uvicorn.run(create_app(auth_token, preference_service), host="127.0.0.1", port=8767, access_log=False)
    finally:
        preference_service.close()
