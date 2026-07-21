"""Avatar 多人同屏：服务端权威房间与固定 tick。

单 Uvicorn worker、进程内状态。客户端只发送输入，服务端推进物理并广播快照。
"""

from __future__ import annotations

import asyncio
import logging
import random
import string
import time
import uuid
from typing import Any, Dict, List, Optional, Set

from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect, WebSocketState

from app.games.avatar_lobby import skins
from app.games.common.room_registry import evict_from_other_games, register_game

logger = logging.getLogger(__name__)

GAME_ID = "avatar_lobby"
PROTOCOL_VERSION = 5
PUBLIC_ROOM_ID = "public"
MAX_PLAYERS_PER_ROOM = 10
DISCONNECT_GRACE_SECONDS = 30
PHYSICS_HZ = 30
SNAPSHOT_HZ = 15
# 超过该时间没有输入帧（切后台、半开连接）时清零持续输入，防止角色沿旧方向跑飞。
INPUT_IDLE_SECONDS = 0.6
MOVE_SPEED = 260.0
JUMP_SPEED = 520.0
GRAVITY = 1400.0
AVATAR_SIZE = 72.0
AVATAR_DRAW_SCALE = 1.35
# 水平碰撞宽（未乘 draw scale）：贴近躯干+垂臂，不含整身头发画布。
AVATAR_COLLISION_WIDTH = 40.0
# 归一化横坐标：0 = 左缘，1 = 右缘（已扣除角色半宽边距）。
DEFAULT_NX = 0.5
MAX_MESSAGE_BYTES = 4096
MAX_INPUT_HZ = 30
ROOM_CODE_ALPHABET = string.ascii_uppercase + string.digits
ROOM_CODE_LENGTH = 6

CLOSE_REPLACED = 4002
CLOSE_ROOM_FULL = 4005
CLOSE_BAD_PROTOCOL = 4006


def _now() -> float:
    return time.monotonic()


def _edge_margin_ratio() -> float:
    """角色半宽相对舞台宽度的归一化边距，客户端按 viewW 还原。"""
    # 服务端不持有真实像素宽，用固定参考宽 1280 估算边距比例。
    reference_width = 1280.0
    margin = (AVATAR_COLLISION_WIDTH * AVATAR_DRAW_SCALE) / 2.0
    return margin / reference_width


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _default_appearance(user_id: str) -> Dict[str, Any]:
    """读取用户当前穿戴外观；无穿戴时返回空皮套占位。"""
    appearance = skins.get_appearance_for_user(user_id)
    if appearance is not None:
        return appearance
    return {
        "skinId": None,
        "kind": "plain",
        "heightScale": skins.DEFAULT_HEIGHT_SCALE,
        "contentHash": "",
    }


class PlayerConnection:
    """单个 WebSocket 连接及其发送队列。"""

    def __init__(self, websocket: WebSocket, user_id: str, nickname: str):
        self.websocket = websocket
        self.user_id = user_id
        self.nickname = nickname
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=64)
        self.sender_task: Optional[asyncio.Task] = None
        self.alive = True
        self.last_input_at = 0.0
        self.input_count_window = 0
        self.input_window_start = _now()

    async def start(self) -> None:
        """启动发送协程；同一连接重复 join 时保持幂等。"""
        if self.sender_task is not None and not self.sender_task.done():
            return
        self.alive = True
        self.sender_task = asyncio.create_task(self._sender_loop())

    async def enqueue(self, message: Dict[str, Any]) -> None:
        if not self.alive:
            return
        try:
            self.queue.put_nowait(message)
        except asyncio.QueueFull:
            # 丢弃最旧消息，优先保留最新快照。
            try:
                self.queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                self.queue.put_nowait(message)
            except asyncio.QueueFull:
                pass

    async def _sender_loop(self) -> None:
        try:
            while self.alive:
                message = await self.queue.get()
                if self.websocket.client_state != WebSocketState.CONNECTED:
                    break
                await self.websocket.send_json(message)
        except Exception:
            logger.debug("send loop ended for %s", self.user_id, exc_info=True)
        finally:
            self.alive = False

    async def close(self, code: int = 1000) -> None:
        self.alive = False
        if self.sender_task is not None:
            self.sender_task.cancel()
            try:
                await self.sender_task
            except asyncio.CancelledError:
                pass
            self.sender_task = None
        if self.websocket.client_state == WebSocketState.CONNECTED:
            try:
                await self.websocket.close(code=code)
            except Exception:
                pass

    def accept_input_rate(self) -> bool:
        """简单滑动窗口限流，防止异常刷输入。"""
        now = _now()
        if now - self.input_window_start >= 1.0:
            self.input_window_start = now
            self.input_count_window = 0
        self.input_count_window += 1
        self.last_input_at = now
        return self.input_count_window <= MAX_INPUT_HZ


class AvatarPlayer:
    """房间内一名玩家的权威状态。"""

    def __init__(self, user_id: str, nickname: str, connection: PlayerConnection):
        self.user_id = user_id
        self.nickname = nickname
        self.connection = connection
        self.connected = True
        self.disconnect_token: Optional[str] = None
        self.nx = DEFAULT_NX
        self.y = 0.0
        self.vx = 0.0
        self.vy = 0.0
        self.facing = 1
        self.on_ground = True
        self.kneel = 0.0
        self.ack_sequence = 0
        self.direction = 0
        self.jump_held = False
        self.kneel_held = False
        self.appearance = _default_appearance(user_id)

    def snapshot(self) -> Dict[str, Any]:
        """广播用玩家状态；不含 ack（仅服务端输入排序用）。"""
        return {
            "id": self.user_id,
            "nickname": self.nickname,
            "nx": round(self.nx, 5),
            "y": round(self.y, 3),
            "vx": round(self.vx, 3),
            "vy": round(self.vy, 3),
            "facing": self.facing,
            "onGround": self.on_ground,
            "kneel": round(self.kneel, 3),
            "appearance": dict(self.appearance),
            "connected": self.connected,
        }


class AvatarRoom:
    """单个大厅/临时房间。"""

    def __init__(self, room_id: str, is_public: bool = False):
        self.room_id = room_id
        self.is_public = is_public
        self.players: Dict[str, AvatarPlayer] = {}
        self.server_tick = 0
        self.created_at = _now()
        self.tick_task: Optional[asyncio.Task] = None
        self.running = False

    def connected_count(self) -> int:
        return sum(1 for player in self.players.values() if player.connected)

    def is_empty(self) -> bool:
        return len(self.players) == 0

    async def start(self) -> None:
        if self.running:
            return
        self.running = True
        self.tick_task = asyncio.create_task(self._tick_loop())

    async def stop(self) -> None:
        self.running = False
        if self.tick_task is not None:
            self.tick_task.cancel()
            try:
                await self.tick_task
            except asyncio.CancelledError:
                pass
            self.tick_task = None

    async def broadcast(self, message: Dict[str, Any], exclude_id: Optional[str] = None) -> None:
        for player_id, player in list(self.players.items()):
            if exclude_id is not None and player_id == exclude_id:
                continue
            if not player.connected:
                continue
            await player.connection.enqueue(message)

    def world_snapshot(self) -> Dict[str, Any]:
        """房间共享快照：所有连接收到同一份，避免每人序列化一次。"""
        return {
            "type": "world_snapshot",
            "protocolVersion": PROTOCOL_VERSION,
            "serverTick": self.server_tick,
            "roomId": self.room_id,
            "isPublic": self.is_public,
            "playerCount": self.connected_count(),
            "maxPlayers": MAX_PLAYERS_PER_ROOM,
            "players": [player.snapshot() for player in self.players.values()],
        }

    async def broadcast_snapshot(self) -> None:
        """向房内全部在线连接广播同一份世界快照。"""
        await self.broadcast(self.world_snapshot())

    def step_physics(self, dt: float) -> None:
        margin = _edge_margin_ratio()
        now = _now()
        for player in self.players.values():
            if not player.connected:
                continue
            if now - player.connection.last_input_at > INPUT_IDLE_SECONDS:
                player.direction = 0
                player.jump_held = False
                player.kneel_held = False
            direction = 0 if player.kneel_held else player.direction
            if player.direction != 0:
                player.facing = player.direction
            kneel_target = 1.0 if player.kneel_held and player.on_ground else 0.0
            player.kneel += (kneel_target - player.kneel) * min(1.0, dt * 10.0)
            target_vx = 0.0 if player.kneel_held else direction * MOVE_SPEED
            accel = 2600.0 if player.kneel_held else (1100.0 if direction == 0 else 1500.0)
            if player.vx < target_vx:
                player.vx = min(player.vx + accel * dt, target_vx)
            else:
                player.vx = max(player.vx - accel * dt, target_vx)

            # 把像素速度换算到归一化横坐标（参考宽 1280）。
            reference_width = 1280.0
            usable = max(1.0, reference_width * (1.0 - 2.0 * margin))
            player.nx += (player.vx * dt) / usable
            player.nx = _clamp(player.nx, 0.0, 1.0)

            if (
                player.jump_held
                and player.on_ground
                and not player.kneel_held
                and player.kneel < 0.2
            ):
                player.vy = -JUMP_SPEED
                player.on_ground = False
                player.jump_held = False

            player.vy += GRAVITY * dt
            player.y += player.vy * dt
            if player.y >= 0.0:
                player.y = 0.0
                player.vy = 0.0
                player.on_ground = True

    async def _tick_loop(self) -> None:
        physics_step = 1.0 / PHYSICS_HZ
        snapshot_every = max(1, PHYSICS_HZ // SNAPSHOT_HZ)
        try:
            while self.running:
                started = _now()
                self.server_tick += 1
                self.step_physics(physics_step)
                if self.server_tick % snapshot_every == 0:
                    await self.broadcast_snapshot()
                elapsed = _now() - started
                await asyncio.sleep(max(0.0, physics_step - elapsed))
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("room tick failed: %s", self.room_id)


class AvatarLobbyManager:
    """管理公共大厅与临时房间。"""

    def __init__(self) -> None:
        self.rooms: Dict[str, AvatarRoom] = {}
        self.player_rooms: Dict[str, str] = {}
        self._public = AvatarRoom(PUBLIC_ROOM_ID, is_public=True)
        self.rooms[PUBLIC_ROOM_ID] = self._public

    async def ensure_started(self) -> None:
        await self._public.start()

    def _generate_room_id(self) -> str:
        for _ in range(40):
            code = "".join(random.choices(ROOM_CODE_ALPHABET, k=ROOM_CODE_LENGTH))
            if code.lower() == PUBLIC_ROOM_ID:
                continue
            if code not in self.rooms:
                return code
        return uuid.uuid4().hex[:ROOM_CODE_LENGTH].upper()

    def _normalize_room_id(self, room_id: Optional[str]) -> str:
        if not room_id:
            return PUBLIC_ROOM_ID
        cleaned = "".join(ch for ch in str(room_id).strip().upper() if ch.isalnum())
        if not cleaned or cleaned.lower() == PUBLIC_ROOM_ID:
            return PUBLIC_ROOM_ID
        return cleaned[:16]

    async def create_private_room(self) -> AvatarRoom:
        room_id = self._generate_room_id()
        room = AvatarRoom(room_id, is_public=False)
        self.rooms[room_id] = room
        await room.start()
        return room

    async def get_or_create_room(self, room_id: Optional[str], create: bool = False) -> AvatarRoom:
        if create:
            return await self.create_private_room()
        normalized = self._normalize_room_id(room_id)
        if normalized == PUBLIC_ROOM_ID:
            await self.ensure_started()
            return self._public
        room = self.rooms.get(normalized)
        if room is None:
            raise ValueError("房间不存在")
        return room

    async def join(
        self,
        connection: PlayerConnection,
        room_id: Optional[str] = None,
        create: bool = False,
    ) -> AvatarRoom:
        await self.ensure_started()
        room = await self.get_or_create_room(room_id, create=create)
        if (
            connection.user_id not in room.players
            and room.connected_count() >= MAX_PLAYERS_PER_ROOM
        ):
            raise ValueError("房间已满")

        # 全站一人一房：确定目标房间可加入后，再退出其他游戏的旧房间。
        await evict_from_other_games(GAME_ID, connection.user_id)

        # 同 UID 先离开旧房间（含本房间旧连接替换）。
        previous_room_id = self.player_rooms.get(connection.user_id)
        if previous_room_id and previous_room_id in self.rooms:
            previous = self.rooms[previous_room_id]
            existing = previous.players.get(connection.user_id)
            if existing is not None:
                old_connection = existing.connection
                if old_connection.websocket is not connection.websocket:
                    await old_connection.close(code=CLOSE_REPLACED)
                if previous_room_id != room.room_id:
                    await self._remove_player(previous, connection.user_id, announce=True)

        existing = room.players.get(connection.user_id)
        if existing is not None:
            existing.connection = connection
            existing.nickname = connection.nickname
            existing.connected = True
            existing.disconnect_token = None
            player = existing
        else:
            player = AvatarPlayer(connection.user_id, connection.nickname, connection)
            room.players[connection.user_id] = player

        self.player_rooms[connection.user_id] = room.room_id
        await connection.start()
        await connection.enqueue(
            {
                "type": "room_joined",
                "protocolVersion": PROTOCOL_VERSION,
                "roomId": room.room_id,
                "isPublic": room.is_public,
                "playerCount": room.connected_count(),
                "maxPlayers": MAX_PLAYERS_PER_ROOM,
                "you": connection.user_id,
            }
        )
        await connection.enqueue(room.world_snapshot())
        await room.broadcast(
            {
                "type": "player_join",
                "protocolVersion": PROTOCOL_VERSION,
                "roomId": room.room_id,
                "playerId": connection.user_id,
                "playerCount": room.connected_count(),
            },
            exclude_id=connection.user_id,
        )
        return room

    async def handle_input(self, user_id: str, payload: Dict[str, Any]) -> None:
        room_id = self.player_rooms.get(user_id)
        if room_id is None:
            return
        room = self.rooms.get(room_id)
        if room is None:
            return
        player = room.players.get(user_id)
        if player is None or not player.connected:
            return
        if not player.connection.accept_input_rate():
            return
        if int(payload.get("protocolVersion") or 0) != PROTOCOL_VERSION:
            return
        sequence = int(payload.get("sequence") or 0)
        if sequence < player.ack_sequence:
            return
        direction = int(payload.get("direction") or 0)
        if direction not in (-1, 0, 1):
            direction = 0
        player.direction = direction
        player.jump_held = bool(payload.get("jump"))
        player.kneel_held = bool(payload.get("kneel"))
        player.ack_sequence = sequence

    async def handle_appearance(self, user_id: str, payload: Dict[str, Any]) -> None:
        room_id = self.player_rooms.get(user_id)
        if room_id is None:
            return
        room = self.rooms.get(room_id)
        if room is None:
            return
        player = room.players.get(user_id)
        if player is None or not player.connected:
            return
        skin_id = payload.get("skinId")
        appearance = skins.get_appearance_for_broadcast(user_id, skin_id)
        if appearance is None:
            return
        player.appearance = appearance
        await room.broadcast(
            {
                "type": "appearance",
                "protocolVersion": PROTOCOL_VERSION,
                "roomId": room.room_id,
                "playerId": user_id,
                "appearance": appearance,
            }
        )

    async def handle_disconnect(self, connection: PlayerConnection) -> None:
        room_id = self.player_rooms.get(connection.user_id)
        if room_id is None:
            await connection.close()
            return
        room = self.rooms.get(room_id)
        if room is None:
            await connection.close()
            return
        player = room.players.get(connection.user_id)
        if player is None:
            await connection.close()
            return
        # 已被新连接替换时，旧连接不触发离线。
        if player.connection.websocket is not connection.websocket:
            return
        player.connected = False
        token = uuid.uuid4().hex
        player.disconnect_token = token
        await room.broadcast(
            {
                "type": "player_leave",
                "protocolVersion": PROTOCOL_VERSION,
                "roomId": room.room_id,
                "playerId": connection.user_id,
                "temporary": True,
                "playerCount": room.connected_count(),
            }
        )
        asyncio.create_task(
            self._remove_after_grace(room.room_id, connection.user_id, token)
        )

    async def _remove_after_grace(self, room_id: str, user_id: str, token: str) -> None:
        await asyncio.sleep(DISCONNECT_GRACE_SECONDS)
        room = self.rooms.get(room_id)
        if room is None:
            return
        player = room.players.get(user_id)
        if player is None:
            return
        if player.connected or player.disconnect_token != token:
            return
        await self._remove_player(room, user_id, announce=True)

    async def evict_player_for_other_game(self, user_id: str) -> None:
        """玩家进入其他游戏时，通知并移出 Avatar 房间。"""
        room_id = self.player_rooms.get(user_id)
        room = self.rooms.get(room_id) if room_id else None
        player = room.players.get(user_id) if room is not None else None
        if room is None or player is None:
            self.player_rooms.pop(user_id, None)
            return
        if player.connected:
            try:
                await player.connection.websocket.send_json(
                    {
                        "type": "room_removed",
                        "message": "你已加入其他游戏的房间",
                    }
                )
            except Exception:
                pass
        await self._remove_player(room, user_id, announce=True, close_code=4004)

    async def _remove_player(
        self,
        room: AvatarRoom,
        user_id: str,
        announce: bool,
        close_code: int = 1000,
    ) -> None:
        """移出玩家并在需要时回收空的私人房间。"""
        player = room.players.pop(user_id, None)
        if player is not None:
            await player.connection.close(code=close_code)
        if self.player_rooms.get(user_id) == room.room_id:
            self.player_rooms.pop(user_id, None)
        if announce:
            await room.broadcast(
                {
                    "type": "player_leave",
                    "protocolVersion": PROTOCOL_VERSION,
                    "roomId": room.room_id,
                    "playerId": user_id,
                    "temporary": False,
                    "playerCount": room.connected_count(),
                }
            )
        if not room.is_public and room.is_empty():
            await room.stop()
            self.rooms.pop(room.room_id, None)


lobby_manager = AvatarLobbyManager()
register_game(
    GAME_ID,
    get_player_room=lobby_manager.player_rooms.get,
    evict_player=lobby_manager.evict_player_for_other_game,
)
