"""虚拟形象大厅的 HTTP 与 WebSocket 路由。

页面与皮套管理走 HTTP；多人同屏走 /avatar-lobby/ws。
"""

import json
import logging
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from starlette.websockets import WebSocketDisconnect

from app.games.avatar_lobby import skins
from app.games.avatar_lobby.multiplayer import (
    CLOSE_BAD_PROTOCOL,
    CLOSE_ROOM_FULL,
    MAX_MESSAGE_BYTES,
    PROTOCOL_VERSION,
    PlayerConnection,
    lobby_manager,
)
from app.routers.auth import (
    get_current_identity_ws,
    get_optional_identity,
    get_passport_nickname,
)

templates = Jinja2Templates(directory=str(Path(__file__).resolve().parent / "templates"))
router = APIRouter()
logger = logging.getLogger(__name__)


async def _resolve_nickname(user_id, nickname: str) -> str:
    """会话昵称为空时直接向通行证重查，规避早期缓存的空昵称一直显示默认名。"""
    if nickname:
        return nickname
    try:
        fresh = await get_passport_nickname(user_id)
    except Exception:
        logger.warning("avatar 通行证昵称重查失败，降级为空昵称", exc_info=True)
        return ""
    return str(fresh or "").strip()

GAME_DIR = Path(__file__).resolve().parent
GAME_ID = "avatar_lobby"
STATIC_URL = "/static/games/avatar-lobby"

game_info = {
    "id": GAME_ID,
    "name": "avatar",
    "logo": "/static/img/logo.svg",
    "url": "/avatar-lobby",
    "menu_order": 30,
    "router": router,
    "static_dir": GAME_DIR / "static",
    "static_url": STATIC_URL,
}


@router.get("/avatar-lobby", response_class=HTMLResponse)
async def avatar_lobby(request: Request, identity=Depends(get_optional_identity)):
    """渲染大厅页面。"""
    if identity is None:
        return RedirectResponse(url="/login?next=/avatar-lobby", status_code=302)
    user_id, nickname = identity
    nickname = await _resolve_nickname(user_id, nickname)
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "game": game_info,
            "user_id": user_id,
            "nickname": nickname,
        },
    )


@router.get("/avatar-lobby/skins")
async def list_skins(identity=Depends(get_optional_identity)):
    """列出当前用户可见的皮套（系统 + 自己），并返回当前穿戴的皮套 id。"""
    if identity is None:
        raise HTTPException(status_code=401, detail="请先登录")
    user_id = str(identity[0])
    return {"skins": skins.list_skins(user_id), "worn": skins.get_worn(user_id)}


@router.post("/avatar-lobby/skins")
async def upload_skin(
    request: Request,
    name: str = "",
    kind: str = "plain",
    height_scale: float = skins.DEFAULT_HEIGHT_SCALE,
    skin_id: str = "",
    identity=Depends(get_optional_identity),
):
    """接收皮套贴图（原始字节 body + 查询参数元信息），校验后落盘。"""
    if identity is None:
        raise HTTPException(status_code=401, detail="请先登录")
    data = await request.body()
    try:
        manifest = skins.save_skin(
            data,
            name,
            str(identity[0]),
            kind,
            height_scale,
            skin_id or None,
        )
    except skins.SkinValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    logger.info("skin saved: %s by %s", manifest["id"], identity[0])
    return {"skin": manifest}


@router.delete("/avatar-lobby/skins/{skin_id}")
async def delete_skin(skin_id: str, identity=Depends(get_optional_identity)):
    """删除当前用户自己的皮套。"""
    if identity is None:
        raise HTTPException(status_code=401, detail="请先登录")
    if not skins.delete_skin(skin_id, str(identity[0])):
        raise HTTPException(status_code=404, detail="皮套不存在或无权删除")
    return {"ok": True}


@router.put("/avatar-lobby/skins/worn")
async def set_worn_skin(skin_id: str = "", identity=Depends(get_optional_identity)):
    """记录当前用户穿戴的皮套；skin_id 为空表示清除。"""
    if identity is None:
        raise HTTPException(status_code=401, detail="请先登录")
    if not skins.set_worn(str(identity[0]), skin_id or None):
        raise HTTPException(status_code=400, detail="皮套不可用")
    return {"ok": True}


@router.get("/avatar-lobby/skins/{skin_id}/texture")
async def get_skin_texture(skin_id: str, identity=Depends(get_optional_identity)):
    """返回某个皮套的贴图文件。"""
    if identity is None:
        raise HTTPException(status_code=401, detail="请先登录")
    path = skins.get_texture_path(skin_id)
    if path is None:
        raise HTTPException(status_code=404, detail="皮套不存在")
    return FileResponse(
        path,
        headers={
            # URL 带 contentHash（?v=），内容不变则可长期本地缓存，减轻贴图带宽。
            "Cache-Control": "public, max-age=31536000, immutable",
        },
    )


@router.websocket("/avatar-lobby/ws")
async def avatar_lobby_ws(websocket: WebSocket):
    """多人同屏 WebSocket：鉴权后接受 join/create/input/appearance/ping。"""
    identity = await get_current_identity_ws(websocket)
    if identity is None:
        await websocket.close(code=4401)
        return
    user_id, nickname = identity
    nickname = await _resolve_nickname(user_id, nickname)
    await websocket.accept()
    connection = PlayerConnection(websocket, str(user_id), str(nickname or "玩家"))
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
            if message_type == "input":
                await lobby_manager.handle_input(connection.user_id, payload)
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
        logger.exception("avatar websocket error for %s", user_id)
    finally:
        await lobby_manager.handle_disconnect(connection)
