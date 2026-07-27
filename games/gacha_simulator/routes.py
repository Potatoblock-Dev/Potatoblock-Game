"""抽卡模拟器 HTTP 路由（纯前端 SPA，数据存浏览器 IndexedDB）。"""

from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.responses import FileResponse, RedirectResponse
from app.routers.auth import get_optional_identity

router = APIRouter()

GAME_DIR = Path(__file__).resolve().parent
GAME_ID = "gacha_simulator"
STATIC_URL = "/static/games/gacha-simulator"

game_info = {
    "id": GAME_ID,
    "name": "抽卡模拟器",
    "logo": "/static/img/logo.svg",
    "url": "/gacha-simulator",
    "menu_order": 50,
    "router": router,
    "static_dir": GAME_DIR / "static",
    "static_url": STATIC_URL,
}


@router.get("/gacha-simulator")
async def gacha_simulator_page(request: Request, identity=Depends(get_optional_identity)):
    """登录后进入抽卡模拟器 SPA（静态资源由 static_url 挂载）。"""
    if identity is None:
        return RedirectResponse(url="/login?next=/gacha-simulator", status_code=302)
    index = GAME_DIR / "static" / "index.html"
    return FileResponse(index, media_type="text/html; charset=utf-8")
