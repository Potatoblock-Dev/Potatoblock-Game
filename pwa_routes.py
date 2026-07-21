"""PWA 与弹窗登录路由：挂载到 FastAPI 应用根路径。

由 app.games.register_routers 调用 attach_pwa_routes，无需改服务器 main.py。
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.templating import Jinja2Templates

APP_ROOT = Path(__file__).resolve().parent
TEMPLATES = Jinja2Templates(directory=str(APP_ROOT / "templates"))
SW_PATH = APP_ROOT / "static" / "js" / "service-worker.js"


def attach_pwa_routes(app: FastAPI) -> None:
    """注册 Service Worker 与弹窗登录完成页。"""

    @app.get("/sw.js", include_in_schema=False)
    async def service_worker() -> FileResponse:
        """根路径 SW，scope 覆盖全站。"""
        return FileResponse(
            SW_PATH,
            media_type="application/javascript",
            headers={"Service-Worker-Allowed": "/", "Cache-Control": "no-cache"},
        )

    @app.get("/pwa/login-done", response_class=HTMLResponse, include_in_schema=False)
    async def pwa_login_done(request: Request) -> HTMLResponse:
        """弹窗登录成功后通知 opener 并关闭。"""
        return TEMPLATES.TemplateResponse(
            "login_popup_done.html",
            {"request": request},
        )
