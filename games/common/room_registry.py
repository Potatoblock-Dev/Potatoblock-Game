"""跨游戏共享的玩家房间占用注册表。

同一进程内的所有游戏包共用这份注册表：一个玩家同一时间只能占用一个房间，
不论房间属于哪个游戏。玩家加入任何游戏的房间前，先通过这里把他从其他
游戏的房间中移出；单独本地运行某个游戏时注册表里只有自己，等价于无操作。
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable, Dict, Optional, Tuple

_LookupHandler = Callable[[str], Optional[str]]
_EvictHandler = Callable[[str], Awaitable[None]]
_ReconnectHandler = Callable[[str], Optional[Dict[str, str]]]

_GameRegistration = Tuple[_LookupHandler, _EvictHandler, Optional[_ReconnectHandler]]

_games: Dict[str, _GameRegistration] = {}


def register_game(
    game_id: str,
    *,
    get_player_room: _LookupHandler,
    evict_player: _EvictHandler,
    get_reconnect_session: Optional[_ReconnectHandler] = None,
) -> None:
    """登记一个游戏的房间占用查询、移出与可重连会话查询回调。"""
    _games[game_id] = (get_player_room, evict_player, get_reconnect_session)


async def evict_from_other_games(current_game_id: str, player_id: str) -> None:
    """把玩家从当前游戏之外的所有游戏房间中移出。"""
    for game_id, (get_player_room, evict_player, _) in _games.items():
        if game_id == current_game_id:
            continue
        if get_player_room(player_id):
            await evict_player(player_id)


def find_reconnect_session(user_id: str) -> Optional[Dict[str, Any]]:
    """返回用户当前可重连的游戏会话（game_id、room_id、url）。"""
    player_id = str(user_id)
    for _, (_, _, get_reconnect_session) in _games.items():
        if get_reconnect_session is None:
            continue
        session = get_reconnect_session(player_id)
        if session:
            return session
    return None
