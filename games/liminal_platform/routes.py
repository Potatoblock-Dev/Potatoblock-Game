"""阈限月台 HTTP 路由。

游戏资源位于本目录；由 app.games.liminal_platform 包注册到 FastAPI。
"""

from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from app.routers.auth import get_optional_identity

GAME_ROOT = Path(__file__).resolve().parent
GAME_ID = "liminal_platform"
STATIC_URL = "/static/games/liminal-platform"

templates = Jinja2Templates(directory=str(GAME_ROOT / "templates"))
router = APIRouter()

game_info = {
    "id": GAME_ID,
    "name": "阈限月台",
    "logo": "/static/img/logo.svg",
    "url": "/liminal-platform",
    "router": router,
    "static_dir": GAME_ROOT / "static",
    "static_url": STATIC_URL,
}


@router.get("/liminal-platform", response_class=HTMLResponse)
async def liminal_platform_page(request: Request, identity=Depends(get_optional_identity)):
    """渲染阈限月台占位页（后续替换为完整游戏）。"""
    if identity is None:
        return RedirectResponse(url="/login?next=/liminal-platform", status_code=302)
    user_id, nickname = identity
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "game": game_info,
            "user_id": user_id,
            "nickname": nickname,
        },
    )
