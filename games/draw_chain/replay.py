"""画画接龙结束回放的纯状态与投票计算。"""

from __future__ import annotations

import time
import uuid
from collections import Counter
from typing import Dict, List, Optional
from urllib.parse import quote


VERDICT_SECONDS = 15
ARTWORK_VOTE_SECONDS = 20
WINNER_SECONDS = 7

REPLAY_VERDICT = "replay_verdict"
REPLAY_ARTWORKS = "replay_artworks"
REPLAY_WINNER = "replay_winner"
REPLAY_PHASES = frozenset({REPLAY_VERDICT, REPLAY_ARTWORKS, REPLAY_WINNER})


def replay_voter_ids(room: Dict) -> List[str]:
    """返回仍在线且参加了本局接龙的非观众席玩家。"""
    roster = room.get("chain_roster", [])
    return [
        player_id
        for player_id in roster
        if player_id in room["players"]
        and room["players"][player_id].get("connected", True)
        and not room["players"][player_id].get("watching", False)
        and not room["players"][player_id].get("spectator", False)
    ]


def build_replay_artworks(room: Dict) -> List[Dict[str, object]]:
    """把每一棒画作和紧随其后的猜词配对。"""
    steps = room.get("chain_steps", [])
    items: List[Dict[str, object]] = []
    for index, step in enumerate(steps):
        if step.get("kind") != "drawing":
            continue
        guess = ""
        if index + 1 < len(steps) and steps[index + 1].get("kind") == "guess":
            guess = str(steps[index + 1].get("text") or "")
        artwork_id = str(step.get("artwork_id") or "")
        if not artwork_id:
            continue
        items.append(
            {
                "artwork_id": artwork_id,
                "author_id": str(step.get("player_id") or ""),
                "author_name": str(step.get("player_name") or ""),
                "guess": guess,
                "preview_url": (
                    "/draw-chain/artworks/"
                    + quote(str(room["room_id"]), safe="")
                    + "/"
                    + quote(artwork_id, safe="")
                ),
            }
        )
    return items


def start_replay(room: Dict) -> None:
    """初始化正确性投票阶段。"""
    word_steps = [
        step for step in room.get("chain_steps", []) if step.get("kind") == "word"
    ]
    guess_steps = [
        step for step in room.get("chain_steps", []) if step.get("kind") == "guess"
    ]
    room["turn_phase"] = REPLAY_VERDICT
    room["replay_original_word"] = str(word_steps[0].get("text") or "") if word_steps else ""
    room["replay_final_guess"] = str(guess_steps[-1].get("text") or "") if guess_steps else ""
    room["replay_artworks"] = build_replay_artworks(room)
    room["replay_verdict_votes"] = {}
    room["replay_artwork_votes"] = {}
    room["replay_is_correct"] = None
    room["replay_winner_id"] = ""
    room["replay_token"] = uuid.uuid4().hex
    room["replay_deadline"] = time.monotonic() + VERDICT_SECONDS


def vote_verdict(room: Dict, player_id: str, is_correct: bool) -> bool:
    """记录正确性投票；返回是否所有合资格玩家都已投票。"""
    eligible = replay_voter_ids(room)
    if player_id not in eligible:
        return False
    room["replay_verdict_votes"][player_id] = bool(is_correct)
    return bool(eligible) and all(
        voter_id in room["replay_verdict_votes"] for voter_id in eligible
    )


def resolve_verdict(room: Dict) -> bool:
    """按简单多数判定；平票视为不正确。"""
    eligible = set(replay_voter_ids(room))
    votes = [
        vote
        for player_id, vote in room["replay_verdict_votes"].items()
        if player_id in eligible
    ]
    yes_count = sum(1 for vote in votes if vote)
    room["replay_is_correct"] = yes_count > len(votes) - yes_count
    return bool(room["replay_is_correct"])


def start_artwork_vote(room: Dict) -> None:
    """进入最佳画作投票阶段。"""
    room["turn_phase"] = REPLAY_ARTWORKS
    room["replay_token"] = uuid.uuid4().hex
    room["replay_deadline"] = time.monotonic() + ARTWORK_VOTE_SECONDS


def vote_artwork(room: Dict, player_id: str, artwork_id: str) -> bool:
    """记录最佳画作投票；返回是否所有合资格玩家都已投票。"""
    eligible = replay_voter_ids(room)
    candidate_ids = {
        str(item["artwork_id"]) for item in room.get("replay_artworks", [])
    }
    if player_id not in eligible or artwork_id not in candidate_ids:
        return False
    room["replay_artwork_votes"][player_id] = artwork_id
    return bool(eligible) and all(
        voter_id in room["replay_artwork_votes"] for voter_id in eligible
    )


def resolve_artwork_winner(room: Dict) -> str:
    """按票数选出最佳画作；平票时取接龙中更早出现的画作。"""
    eligible = set(replay_voter_ids(room))
    counts = Counter(
        artwork_id
        for player_id, artwork_id in room["replay_artwork_votes"].items()
        if player_id in eligible
    )
    candidates = room.get("replay_artworks", [])
    winner_id = ""
    best_count = -1
    for item in candidates:
        artwork_id = str(item["artwork_id"])
        count = counts.get(artwork_id, 0)
        if count > best_count:
            winner_id = artwork_id
            best_count = count
    room["replay_winner_id"] = winner_id
    return winner_id


def start_winner_display(room: Dict) -> None:
    """进入最佳画作展示阶段。"""
    room["turn_phase"] = REPLAY_WINNER
    room["replay_token"] = uuid.uuid4().hex
    room["replay_deadline"] = time.monotonic() + WINNER_SECONDS


def replay_remaining(room: Dict) -> int:
    """返回当前回放阶段剩余秒数。"""
    return max(0, int(room.get("replay_deadline", 0.0) - time.monotonic() + 0.999))


def serialize_replay(room: Dict, player_id: str) -> Dict[str, object]:
    """序列化当前回放阶段及个人投票状态。"""
    eligible = replay_voter_ids(room)
    eligible_set = set(eligible)
    winner_id = str(room.get("replay_winner_id") or "")
    winner: Optional[Dict[str, object]] = next(
        (
            item
            for item in room.get("replay_artworks", [])
            if str(item["artwork_id"]) == winner_id
        ),
        None,
    )
    artwork_votes = room.get("replay_artwork_votes", {})
    verdict_votes = room.get("replay_verdict_votes", {})
    counts = Counter(
        artwork_id
        for voter_id, artwork_id in artwork_votes.items()
        if voter_id in eligible_set
    )
    return {
        "stage": room.get("turn_phase", ""),
        "original_word": room.get("replay_original_word", ""),
        "final_guess": room.get("replay_final_guess", ""),
        "remaining": replay_remaining(room),
        "eligible": player_id in eligible,
        "vote_required": len(eligible),
        "vote_count": (
            sum(1 for voter_id in verdict_votes if voter_id in eligible_set)
            if room.get("turn_phase") == REPLAY_VERDICT
            else sum(1 for voter_id in artwork_votes if voter_id in eligible_set)
        ),
        "verdict_vote": verdict_votes.get(player_id),
        "is_correct": room.get("replay_is_correct"),
        "artworks": [
            {**item, "votes": counts.get(str(item["artwork_id"]), 0)}
            for item in room.get("replay_artworks", [])
        ],
        "artwork_vote": artwork_votes.get(player_id, ""),
        "winner": winner,
        "winner_votes": counts.get(winner_id, 0),
    }
