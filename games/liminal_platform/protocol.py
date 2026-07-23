"""阈限月台 WebSocket 协议常量与消息形状（TypedDict）。

与大厅 avatar（docs/networking-plan.md, PROTOCOL_VERSION=6）不是同一套。
改字段时同步：本文件、client/src/protocol/messages.ts、docs/liminal-protocol.md

注意：仅使用 typing 标准库（无 NotRequired），兼容 Python 3.10+ 生产环境。
可选字段（aimX、throttle 等）在运行时可能缺失，以 TS / 文档为准。
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional, TypedDict, Union

PROTOCOL_VERSION = 1
PUBLIC_ROOM_ID = "public"
POSE_RATE_HZ = 20
MAX_PLAYERS_PER_ROOM = 10


class PoseMessage(TypedDict):
    type: Literal["pose"]
    protocolVersion: int
    sequence: int
    x: float
    y: float
    vx: float
    vy: float
    facing: float
    onGround: bool
    gait: Literal["walk", "run"]
    headLook: float
    heldId: Optional[str]


class JoinMessage(TypedDict):
    type: Literal["join"]
    protocolVersion: int
    roomId: str


class CreateMessage(TypedDict):
    type: Literal["create"]
    protocolVersion: int


class TrainMessage(TypedDict):
    type: Literal["train"]
    protocolVersion: int


class FuelAddMessage(TypedDict):
    type: Literal["fuel_add"]
    protocolVersion: int
    itemId: str


class FireMessage(TypedDict):
    type: Literal["fire"]
    protocolVersion: int
    x: float
    y: float
    dirX: float
    dirY: float


class InvMessage(TypedDict):
    type: Literal["inv"]
    protocolVersion: int


class AppearanceOutMessage(TypedDict):
    type: Literal["appearance"]
    protocolVersion: int
    skinId: Optional[str]


class ChatOutMessage(TypedDict):
    type: Literal["chat"]
    protocolVersion: int
    text: str


class PingMessage(TypedDict):
    type: Literal["ping"]
    t: float


ClientMessage = Union[
    JoinMessage,
    CreateMessage,
    PoseMessage,
    TrainMessage,
    FuelAddMessage,
    FireMessage,
    InvMessage,
    AppearanceOutMessage,
    ChatOutMessage,
    PingMessage,
]


class SnapshotPlayer(TypedDict):
    id: str
    nickname: str
    x: float
    y: float
    vx: float
    vy: float
    facing: float
    onGround: bool
    gait: Literal["walk", "run"]
    headLook: float
    appearance: Dict[str, Any]
    connected: bool
    heldId: Optional[str]


class WorldSnapshotMessage(TypedDict):
    type: Literal["world_snapshot"]
    protocolVersion: int
    serverTick: int
    serverTimeMs: int
    roomId: str
    isPublic: bool
    playerCount: int
    maxPlayers: int
    players: List[SnapshotPlayer]
    world: Dict[str, Any]
