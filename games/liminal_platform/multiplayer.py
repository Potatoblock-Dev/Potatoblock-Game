"""阈限月台联机：姿态转发 + 共享列车/燃料。

角色物理暂由客户端权威（含瞄准朝向）；服务端钳制坐标并广播快照。
个人物品栏仍为本地；开火仅广播曳光特效。

约定（与 Avatar 大厅一致，后续接线/改权威时遵守）：
- 共享状态（房间、列车、燃料、聊天）服务端权威。
- 本地角色画面禁止每帧硬拽到 snapshot（会卡顿/闪现）；进房对齐，大误差才软校正。
- 远端用延迟插值；勿把本地预测关掉换成纯跟服。
"""

from __future__ import annotations

import asyncio
import logging
import random
import string
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

from fastapi import WebSocket
from starlette.websockets import WebSocketState

from app.games.avatar_lobby import skins
from app.games.common.room_registry import evict_from_other_games, register_game

logger = logging.getLogger(__name__)

GAME_ID = "liminal_platform"
PROTOCOL_VERSION = 1
PUBLIC_ROOM_ID = "public"
MAX_PLAYERS_PER_ROOM = 10
DISCONNECT_GRACE_SECONDS = 30
SNAPSHOT_HZ = 15
HALF_W = (40.0 * 1.35) / 2.0
FLOOR_Y = 979.0
WALK_LEFT = 456.0
WALK_RIGHT = 1793.0
COUPLER_JOIN = 1516.0
MAX_MESSAGE_BYTES = 4096
MAX_POSE_HZ = 30
ROOM_CODE_ALPHABET = string.ascii_uppercase + string.digits
ROOM_CODE_LENGTH = 6
DEFAULT_FUEL = 35.0
FUEL_MAX = 100.0
FUEL_PER_ADD = 18.0
CHAT_MAX_LEN = 40

CLOSE_REPLACED = 4002
CLOSE_ROOM_FULL = 4005
CLOSE_BAD_PROTOCOL = 4006


def _now() -> float:
    return time.monotonic()


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _default_appearance(user_id: str) -> Dict[str, Any]:
    return skins.get_appearance_for_broadcast(user_id, None) or {
        "skinId": None,
        "kind": "placeholder",
        "heightScale": 1.0,
        "contentHash": None,
    }


def _build_platforms() -> List[Dict[str, float]]:
    cars = [0.0, COUPLER_JOIN]
    platforms = [
        {"left": wx + WALK_LEFT, "right": wx + WALK_RIGHT, "y": FLOOR_Y} for wx in cars
    ]
    if platforms[1]["left"] > platforms[0]["right"]:
        platforms.insert(
            1,
            {
                "left": platforms[0]["right"],
                "right": platforms[1]["left"],
                "y": FLOOR_Y,
            },
        )
    return platforms


PLATFORMS = _build_platforms()
WORLD_LEFT = PLATFORMS[0]["left"] + HALF_W
WORLD_RIGHT = PLATFORMS[-1]["right"] - HALF_W
DEFAULT_X = (WALK_LEFT + WALK_RIGHT) / 2.0


class PlayerConnection:
    """单个 WebSocket 连接及其发送队列。"""

    def __init__(self, websocket: WebSocket, user_id: str, nickname: str):
        self.websocket = websocket
        self.user_id = user_id
        self.nickname = nickname
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=64)
        self.sender_task: Optional[asyncio.Task] = None
        self.last_pose_at = _now()
        self.pose_window_start = _now()
        self.pose_count_window = 0

    async def start(self) -> None:
        self.sender_task = asyncio.create_task(self._sender_loop())

    async def enqueue(self, message: Dict[str, Any]) -> None:
        try:
            self.queue.put_nowait(message)
        except asyncio.QueueFull:
            try:
                self.queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                self.queue.put_nowait(message)
            except asyncio.QueueFull:
                pass

    async def _sender_loop(self) -> None:
        while True:
            message = await self.queue.get()
            try:
                if self.websocket.client_state != WebSocketState.CONNECTED:
                    break
                await self.websocket.send_json(message)
            except Exception:
                break

    async def close(self, code: int = 1000) -> None:
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

    def accept_pose_rate(self) -> bool:
        now = _now()
        if now - self.pose_window_start >= 1.0:
            self.pose_window_start = now
            self.pose_count_window = 0
        self.pose_count_window += 1
        self.last_pose_at = now
        return self.pose_count_window <= MAX_POSE_HZ


class LiminalPlayer:
    """房间内一名玩家（姿态由客户端上报）。"""

    def __init__(self, user_id: str, nickname: str, connection: PlayerConnection):
        self.user_id = user_id
        self.nickname = nickname
        self.connection = connection
        self.connected = True
        self.disconnect_token: Optional[str] = None
        self.x = DEFAULT_X
        self.y = 0.0
        self.vx = 0.0
        self.vy = 0.0
        self.facing = 1
        self.on_ground = True
        self.gait = "walk"
        self.head_look = 0.0
        self.ack_sequence = 0
        self.appearance = _default_appearance(user_id)

    def snapshot(self) -> Dict[str, Any]:
        return {
            "id": self.user_id,
            "nickname": self.nickname,
            "x": round(self.x, 2),
            "y": round(self.y, 3),
            "vx": round(self.vx, 3),
            "vy": round(self.vy, 3),
            "facing": self.facing,
            "onGround": self.on_ground,
            "gait": self.gait if self.gait in ("walk", "run") else "walk",
            "headLook": round(self.head_look, 3),
            "appearance": dict(self.appearance),
            "connected": self.connected,
        }


class LiminalRoom:
    """阈限月台房间：姿态广播 + 共享列车/燃料。"""

    def __init__(self, room_id: str, is_public: bool = False):
        self.room_id = room_id
        self.is_public = is_public
        self.players: Dict[str, LiminalPlayer] = {}
        self.server_tick = 0
        self.tick_task: Optional[asyncio.Task] = None
        self.running = False
        self.train = {"throttle": 0.0, "brake": 0.0, "speed": 0.0}
        self.fuel_level = DEFAULT_FUEL
        self._fuel_add_times: Dict[str, float] = {}
        self._train_set_times: Dict[str, float] = {}

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
        return {
            "type": "world_snapshot",
            "protocolVersion": PROTOCOL_VERSION,
            "serverTick": self.server_tick,
            "serverTimeMs": int(time.time() * 1000),
            "roomId": self.room_id,
            "isPublic": self.is_public,
            "playerCount": self.connected_count(),
            "maxPlayers": MAX_PLAYERS_PER_ROOM,
            "players": [player.snapshot() for player in self.players.values()],
            "world": {
                "train": {
                    "throttle": round(self.train["throttle"], 3),
                    "brake": round(self.train["brake"], 3),
                    "speed": round(self.train["speed"], 3),
                },
                "fuel": {"level": round(self.fuel_level, 2)},
            },
        }

    async def broadcast_snapshot(self) -> None:
        await self.broadcast(self.world_snapshot())

    def step_train(self, dt: float) -> None:
        """简化列车积分（与客户端大致同量级）。"""
        throttle = self.train["throttle"]
        brake = self.train["brake"]
        speed = self.train["speed"]
        if brake >= 0.95:
            self.train["speed"] = 0.0
            return
        desired = throttle * (1.0 - brake * 0.92)
        rate = 2.4
        if abs(desired) < abs(speed) - 0.01 or (
            desired != 0 and speed != 0 and (desired > 0) != (speed > 0)
        ):
            rate = 0.55 + 6.5 * brake
        elif abs(desired) < 0.01:
            rate = 0.55 + 6.5 * brake
        if speed < desired:
            speed = min(speed + rate * dt, desired)
        else:
            speed = max(speed - rate * dt, desired)
        self.train["speed"] = _clamp(speed, -5.0, 5.0)

    async def _tick_loop(self) -> None:
        step = 1.0 / SNAPSHOT_HZ
        try:
            while self.running:
                started = _now()
                self.server_tick += 1
                self.step_train(step)
                await self.broadcast_snapshot()
                elapsed = _now() - started
                await asyncio.sleep(max(0.0, step - elapsed))
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("liminal room tick failed: %s", self.room_id)


class LiminalLobbyManager:
    """管理公共房与临时房间。"""

    def __init__(self) -> None:
        self.rooms: Dict[str, LiminalRoom] = {}
        self.player_rooms: Dict[str, str] = {}
        self._public = LiminalRoom(PUBLIC_ROOM_ID, is_public=True)
        self.rooms[PUBLIC_ROOM_ID] = self._public

    async def ensure_started(self) -> None:
        await self._public.start()

    def _generate_room_id(self) -> str:
        while True:
            code = "".join(random.choice(ROOM_CODE_ALPHABET) for _ in range(ROOM_CODE_LENGTH))
            if code not in self.rooms:
                return code

    def _normalize_room_id(self, room_id: Optional[str]) -> str:
        if not room_id:
            return PUBLIC_ROOM_ID
        cleaned = "".join(ch for ch in str(room_id).strip().upper() if ch.isalnum())
        return cleaned or PUBLIC_ROOM_ID

    async def create_private_room(self) -> LiminalRoom:
        room_id = self._generate_room_id()
        room = LiminalRoom(room_id, is_public=False)
        self.rooms[room_id] = room
        await room.start()
        return room

    async def get_or_create_room(self, room_id: Optional[str], create: bool = False) -> LiminalRoom:
        if create:
            return await self.create_private_room()
        normalized = self._normalize_room_id(room_id)
        if normalized == PUBLIC_ROOM_ID:
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
    ) -> LiminalRoom:
        await evict_from_other_games(GAME_ID, connection.user_id)
        room = await self.get_or_create_room(room_id, create=create)
        if (
            connection.user_id not in room.players
            and room.connected_count() >= MAX_PLAYERS_PER_ROOM
        ):
            raise ValueError("房间已满")

        previous_room_id = self.player_rooms.get(connection.user_id)
        if previous_room_id and previous_room_id in self.rooms:
            previous = self.rooms[previous_room_id]
            old = previous.players.get(connection.user_id)
            if old is not None and old.connection.websocket is not connection.websocket:
                await old.connection.close(code=CLOSE_REPLACED)
            if previous_room_id != room.room_id:
                await self._remove_player(previous, connection.user_id, announce=True)

        existing = room.players.get(connection.user_id)
        if existing is not None:
            existing.connection = connection
            existing.connected = True
            existing.disconnect_token = None
            existing.nickname = connection.nickname
        else:
            room.players[connection.user_id] = LiminalPlayer(
                connection.user_id, connection.nickname, connection
            )

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

    async def handle_pose(self, user_id: str, payload: Dict[str, Any]) -> None:
        room, player = self._room_player(user_id)
        if room is None or player is None or not player.connected:
            return
        if not player.connection.accept_pose_rate():
            return
        if int(payload.get("protocolVersion") or 0) != PROTOCOL_VERSION:
            return
        sequence = int(payload.get("sequence") or 0)
        if sequence < player.ack_sequence:
            return
        try:
            player.x = _clamp(float(payload.get("x") or player.x), WORLD_LEFT, WORLD_RIGHT)
            player.y = _clamp(float(payload.get("y") or 0.0), -800.0, 80.0)
            player.vx = _clamp(float(payload.get("vx") or 0.0), -800.0, 800.0)
            player.vy = _clamp(float(payload.get("vy") or 0.0), -1200.0, 1200.0)
            player.head_look = _clamp(float(payload.get("headLook") or 0.0), -0.6, 0.6)
        except (TypeError, ValueError):
            return
        facing = int(payload.get("facing") or player.facing)
        player.facing = 1 if facing >= 0 else -1
        player.on_ground = bool(payload.get("onGround"))
        gait = str(payload.get("gait") or "walk")
        player.gait = "run" if gait == "run" else "walk"
        player.ack_sequence = sequence

    async def handle_train(self, user_id: str, payload: Dict[str, Any]) -> None:
        room, player = self._room_player(user_id)
        if room is None or player is None or not player.connected:
            return
        now = _now()
        last = room._train_set_times.get(user_id, 0.0)
        if now - last < 0.04:
            return
        room._train_set_times[user_id] = now
        if "throttle" in payload:
            try:
                room.train["throttle"] = _clamp(float(payload["throttle"]), -5.0, 5.0)
            except (TypeError, ValueError):
                pass
        if "brake" in payload:
            try:
                room.train["brake"] = _clamp(float(payload["brake"]), 0.0, 1.0)
            except (TypeError, ValueError):
                pass
        if float(room.train["brake"]) >= 0.95:
            room.train["speed"] = 0.0

    async def handle_fuel_add(self, user_id: str, payload: Dict[str, Any]) -> None:
        room, player = self._room_player(user_id)
        if room is None or player is None or not player.connected:
            return
        now = _now()
        last = room._fuel_add_times.get(user_id, 0.0)
        if now - last < 0.35:
            return
        room._fuel_add_times[user_id] = now
        if room.fuel_level >= FUEL_MAX - 0.01:
            return
        amount = FUEL_PER_ADD
        try:
            if payload.get("amount") is not None:
                amount = _clamp(float(payload["amount"]), 1.0, FUEL_PER_ADD * 2)
        except (TypeError, ValueError):
            amount = FUEL_PER_ADD
        room.fuel_level = min(FUEL_MAX, room.fuel_level + amount)
        await room.broadcast(
            {
                "type": "fuel_changed",
                "protocolVersion": PROTOCOL_VERSION,
                "roomId": room.room_id,
                "level": round(room.fuel_level, 2),
                "by": user_id,
            }
        )

    async def handle_fire(self, user_id: str, payload: Dict[str, Any]) -> None:
        room, player = self._room_player(user_id)
        if room is None or player is None or not player.connected:
            return
        await room.broadcast(
            {
                "type": "weapon_fired",
                "protocolVersion": PROTOCOL_VERSION,
                "roomId": room.room_id,
                "playerId": user_id,
                "x": payload.get("x"),
                "y": payload.get("y"),
                "dirX": payload.get("dirX"),
                "dirY": payload.get("dirY"),
                "facing": payload.get("facing", player.facing),
            },
            exclude_id=user_id,
        )

    async def handle_chat(self, user_id: str, payload: Dict[str, Any]) -> None:
        room, player = self._room_player(user_id)
        if room is None or player is None or not player.connected:
            return
        text = str(payload.get("text") or "").strip()
        text = " ".join(text.split())[:CHAT_MAX_LEN]
        if not text:
            return
        await room.broadcast(
            {
                "type": "chat",
                "protocolVersion": PROTOCOL_VERSION,
                "roomId": room.room_id,
                "playerId": user_id,
                "nickname": player.nickname,
                "text": text,
            }
        )

    async def handle_appearance(self, user_id: str, payload: Dict[str, Any]) -> None:
        room, player = self._room_player(user_id)
        if room is None or player is None or not player.connected:
            return
        appearance = skins.get_appearance_for_broadcast(user_id, payload.get("skinId"))
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

    def _room_player(
        self, user_id: str
    ) -> Tuple[Optional[LiminalRoom], Optional[LiminalPlayer]]:
        room_id = self.player_rooms.get(user_id)
        if room_id is None:
            return None, None
        room = self.rooms.get(room_id)
        if room is None:
            return None, None
        return room, room.players.get(user_id)

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
        asyncio.create_task(self._remove_after_grace(room.room_id, connection.user_id, token))

    async def _remove_after_grace(self, room_id: str, user_id: str, token: str) -> None:
        await asyncio.sleep(DISCONNECT_GRACE_SECONDS)
        room = self.rooms.get(room_id)
        if room is None:
            return
        player = room.players.get(user_id)
        if player is None or player.disconnect_token != token or player.connected:
            return
        await self._remove_player(room, user_id, announce=True)

    async def evict_player_for_other_game(self, user_id: str) -> None:
        room_id = self.player_rooms.get(user_id)
        room = self.rooms.get(room_id) if room_id else None
        player = room.players.get(user_id) if room is not None else None
        if room is None or player is None:
            self.player_rooms.pop(user_id, None)
            return
        try:
            await player.connection.websocket.send_json(
                {"type": "room_removed", "reason": "joined_other_game"}
            )
        except Exception:
            pass
        await self._remove_player(room, user_id, announce=True, close_code=4004)

    async def _remove_player(
        self,
        room: LiminalRoom,
        user_id: str,
        announce: bool = False,
        close_code: int = 1000,
    ) -> None:
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


lobby_manager = LiminalLobbyManager()


def get_reconnect_session(user_id: str) -> Optional[Dict[str, str]]:
    room_id = lobby_manager.player_rooms.get(user_id)
    if not room_id or room_id == PUBLIC_ROOM_ID:
        return None
    room = lobby_manager.rooms.get(room_id)
    if not room or user_id not in room.players:
        return None
    return {
        "game_id": GAME_ID,
        "room_id": room_id,
        "url": "/liminal-platform?room=" + quote(room_id, safe=""),
    }


register_game(
    GAME_ID,
    get_player_room=lobby_manager.player_rooms.get,
    evict_player=lobby_manager.evict_player_for_other_game,
    get_reconnect_session=get_reconnect_session,
)
