"""阈限月台 HTTP 与 WebSocket 路由。

页面走 HTTP；多人同屏走 /liminal-platform/ws。
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

from fastapi import APIRouter, Depends, Request, WebSocket
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from starlette.websockets import WebSocketDisconnect

from app.games.liminal_platform.multiplayer import (
    CLOSE_BAD_PROTOCOL,
    CLOSE_ROOM_FULL,
    MAX_MESSAGE_BYTES,
    PlayerConnection,
    lobby_manager,
)
from app.games.liminal_platform.protocol import PROTOCOL_VERSION
from app.routers.auth import (
    get_current_identity_ws,
    get_optional_identity,
    get_passport_nickname,
)

_LOCAL_DEBUG_HOSTS = frozenset({"localhost", "127.0.0.1", "::1", "[::1]"})

GAME_ROOT = Path(__file__).resolve().parent
GAME_ID = "liminal_platform"
STATIC_URL = "/static/games/liminal-platform"

templates = Jinja2Templates(directory=str(GAME_ROOT / "templates"))
router = APIRouter()
logger = logging.getLogger(__name__)

game_info = {
    "id": GAME_ID,
    "name": "阈限月台",
    "logo": "/static/img/logo.svg",
    "url": "/liminal-platform",
    "menu_order": 40,
    "badge": "测试版",
    "router": router,
    "static_dir": GAME_ROOT / "static",
    "static_url": STATIC_URL,
}


async def _resolve_nickname(user_id: str, nickname: str | None) -> str:
    """解析通行证昵称，缺省为旅人。"""
    passport = await get_passport_nickname(user_id)
    return passport or nickname or "旅人"


def _is_local_debug_request(request: Request) -> bool:
    """是否注入本地调试脚本：LP_LOCAL_DEBUG=1，或 Host/URL/对端为本机环回。"""
    flag = os.environ.get("LP_LOCAL_DEBUG", "").strip().lower()
    if flag in ("1", "true", "yes", "on"):
        return True
    if flag in ("0", "false", "no", "off"):
        return False
    host_header = str(request.headers.get("host") or "").split(":", 1)[0].lower()
    url_host = str(request.url.hostname or "").lower()
    peer = str(request.client.host if request.client else "").lower()
    return host_header in _LOCAL_DEBUG_HOSTS or url_host in _LOCAL_DEBUG_HOSTS or peer in _LOCAL_DEBUG_HOSTS


@router.get("/liminal-platform", response_class=HTMLResponse)
async def liminal_platform_page(request: Request, identity=Depends(get_optional_identity)):
    """渲染阈限月台游戏页。"""
    if identity is None:
        return RedirectResponse(url="/login?next=/liminal-platform", status_code=302)
    user_id, nickname = identity
    nickname = await _resolve_nickname(str(user_id), nickname)
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "game": game_info,
            "user_id": user_id,
            "nickname": nickname,
            "lp_local_debug": _is_local_debug_request(request),
        },
    )


@router.websocket("/liminal-platform/ws")
async def liminal_platform_ws(websocket: WebSocket):
    """多人同屏 WebSocket：join/create/pose/train/fuel/fire/inv/chat/appearance。"""
    identity = await get_current_identity_ws(websocket)
    if identity is None:
        await websocket.close(code=4401)
        return
    user_id, nickname = identity
    nickname = await _resolve_nickname(str(user_id), nickname)
    await websocket.accept()
    await lobby_manager.ensure_started()
    connection = PlayerConnection(websocket, str(user_id), str(nickname or "旅人"))
    joined_room = None
    try:
        while True:
            raw = await websocket.receive_text()
            if len(raw.encode("utf-8")) > MAX_MESSAGE_BYTES:
                await websocket.close(code=CLOSE_BAD_PROTOCOL)
                return
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(payload, dict):
                continue
            message_type = payload.get("type")
            if message_type == "ping":
                await connection.enqueue({"type": "pong", "t": payload.get("t")})
                continue
            if message_type in ("join", "create"):
                try:
                    joined_room = await lobby_manager.join(
                        connection,
                        room_id=payload.get("roomId"),
                        create=message_type == "create",
                    )
                except ValueError as exc:
                    code = CLOSE_ROOM_FULL if "满" in str(exc) else CLOSE_BAD_PROTOCOL
                    await connection.enqueue(
                        {
                            "type": "room_error",
                            "protocolVersion": PROTOCOL_VERSION,
                            "message": str(exc),
                        }
                    )
                    if joined_room is None:
                        await websocket.close(code=code)
                        return
                continue
            if message_type == "pose":
                await lobby_manager.handle_pose(connection.user_id, payload)
                continue
            if message_type == "train":
                await lobby_manager.handle_train(connection.user_id, payload)
                continue
            if message_type == "fuel_add":
                await lobby_manager.handle_fuel_add(connection.user_id, payload)
                continue
            if message_type == "fire":
                await lobby_manager.handle_fire(connection.user_id, payload)
                continue
            if message_type == "heal":
                await lobby_manager.handle_heal(connection.user_id, payload)
                continue
            if message_type == "revive":
                await lobby_manager.handle_revive(connection.user_id, payload)
                continue
            if message_type == "inv":
                await lobby_manager.handle_inv(connection.user_id, payload)
                continue
            if message_type == "appearance":
                await lobby_manager.handle_appearance(connection.user_id, payload)
                continue
            if message_type == "chat":
                await lobby_manager.handle_chat(connection.user_id, payload)
                continue
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("liminal websocket error for %s", user_id)
    finally:
        await lobby_manager.handle_disconnect(connection)
