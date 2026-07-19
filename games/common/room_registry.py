"""跨游戏共享的玩家房间占用注册表。

同一进程内的所有游戏包共用这份注册表：一个玩家同一时间只能占用一个房间，
不论房间属于哪个游戏。玩家加入任何游戏的房间前，先通过这里把他从其他
游戏的房间中移出；单独本地运行某个游戏时注册表里只有自己，等价于无操作。
"""

from __future__ import annotations

from typing import Awaitable, Callable, Dict, Optional, Tuple

_LookupHandler = Callable[[str], Optional[str]]
_EvictHandler = Callable[[str], Awaitable[None]]

_games: Dict[str, Tuple[_LookupHandler, _EvictHandler]] = {}


def register_game(
    game_id: str,
    *,
    get_player_room: _LookupHandler,
    evict_player: _EvictHandler,
) -> None:
    """登记一个游戏的房间占用查询与移出回调。"""
    _games[game_id] = (get_player_room, evict_player)


async def evict_from_other_games(current_game_id: str, player_id: str) -> None:
    """把玩家从当前游戏之外的所有游戏房间中移出。"""
    for game_id, (get_player_room, evict_player) in _games.items():
        if game_id == current_game_id:
            continue
        if get_player_room(player_id):
            await evict_player(player_id)
