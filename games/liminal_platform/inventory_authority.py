"""阈限月台服务端物品栏权威：网格、堆叠、共享仓库/地面/弹药箱。

与客户端 lp-inventory-core.js 的 JSON 形状对齐（id/cols/rows/slots/mag）。
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Dict, List, Optional, Tuple

# 测试阶段：燃料/弹药消耗后自动补满（含弹匣、弹药箱）。正式上线前改为 False。
TEST_AUTO_REFILL_CONSUMABLES = True
CONSUMABLE_TYPES = frozenset({"fuel", "ammo"})

# 与 lp-item-catalog.js 关键字段对齐（校验用）
ITEMS: Dict[str, Dict[str, Any]] = {
    "coal": {"maxStack": 100, "w": 1, "h": 1, "type": "fuel", "boilerFuel": 18, "canHold": True},
    "lumber": {"maxStack": 100, "w": 1, "h": 1, "type": "material", "canHold": True},
    "iron_ingot": {"maxStack": 50, "w": 1, "h": 1, "type": "metal", "canHold": True},
    "scrap": {"maxStack": 50, "w": 1, "h": 1, "type": "material", "canHold": True},
    "wrench": {"maxStack": 1, "w": 2, "h": 1, "type": "tool", "canHold": True},
    "turret_ammo": {"maxStack": 100, "w": 1, "h": 1, "type": "ammo", "canHold": True},
    "shell_casing": {"maxStack": 100, "w": 1, "h": 1, "type": "material", "canHold": True},
    "small_caliber_ammo": {"maxStack": 90, "w": 1, "h": 1, "type": "ammo", "canHold": True},
    "gur65": {
        "maxStack": 1,
        "w": 3,
        "h": 2,
        "type": "weapon",
        "magazineSize": 27,
        "ammoId": "small_caliber_ammo",
        "canHold": True,
        "weaponId": "gur65",
    },
    "work_cap": {"maxStack": 1, "w": 1, "h": 1, "type": "apparel", "equip": "head", "canHold": True},
    "work_vest": {"maxStack": 1, "w": 2, "h": 2, "type": "apparel", "equip": "chest", "canHold": False},
    "work_pants": {"maxStack": 1, "w": 2, "h": 2, "type": "apparel", "equip": "legs", "canHold": False},
    "signal_lamp": {
        "maxStack": 1,
        "w": 1,
        "h": 1,
        "type": "accessory",
        "equip": "accessory",
        "canHold": True,
    },
    "work_satchel": {
        "maxStack": 1,
        "w": 2,
        "h": 2,
        "type": "apparel",
        "equip": "backpack",
        "bagCols": 6,
        "bagRows": 4,
        "canHold": False,
    },
}

EQUIP_SLOT_KEYS = ["head", "chest", "legs", "accessory", "accessory", "backpack"]
PLAYER_BASE = (4, 2)
HANDS_UTILITY = 2


def _norm_stack(stack: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not stack or not stack.get("itemId") or not stack.get("qty"):
        return None
    if stack.get("occupiedBy") is not None:
        return None
    item = ITEMS.get(str(stack["itemId"]))
    if not item:
        return None
    qty = max(1, min(int(stack["qty"]), int(item["maxStack"])))
    out: Dict[str, Any] = {"itemId": str(stack["itemId"]), "qty": qty}
    mag_size = item.get("magazineSize")
    if mag_size:
        mag_raw = stack.get("mag", mag_size)
        try:
            mag = int(mag_raw)
        except (TypeError, ValueError):
            mag = int(mag_size)
        out["mag"] = max(0, min(int(mag_size), mag))
    return out


class Inventory:
    """服务端网格库存。"""

    def __init__(
        self,
        inv_id: str,
        cols: int,
        rows: int,
        *,
        ignore_item_size: bool = False,
        slot_keys: Optional[List[str]] = None,
    ):
        self.id = inv_id
        self.cols = cols
        self.rows = rows
        self.ignore_item_size = ignore_item_size
        self.slot_keys = list(slot_keys) if slot_keys else None
        self.slots: List[Optional[Dict[str, Any]]] = [None] * (cols * rows)

    def size(self) -> int:
        return len(self.slots)

    def size_for(self, item_id: str) -> Tuple[int, int]:
        if self.ignore_item_size:
            return 1, 1
        item = ITEMS.get(item_id) or {}
        return int(item.get("w", 1)), int(item.get("h", 1))

    def accepts(self, item_id: str, index: Optional[int] = None) -> bool:
        item = ITEMS.get(item_id)
        if not item:
            return False
        if self.id == "hands" or self.id.startswith("hands"):
            if not item.get("canHold", True):
                return False
            if index == HANDS_UTILITY and item.get("type") == "weapon":
                return False
            return True
        if self.slot_keys:
            if index is None:
                return any(
                    item.get("equip") == key and self.get_slot(i) is None
                    for i, key in enumerate(self.slot_keys)
                )
            if index < 0 or index >= len(self.slot_keys):
                return False
            return item.get("equip") == self.slot_keys[index]
        return True

    def index_at(self, col: int, row: int) -> int:
        if col < 0 or row < 0 or col >= self.cols or row >= self.rows:
            return -1
        return row * self.cols + col

    def coords_of(self, index: int) -> Tuple[int, int]:
        return index % self.cols, index // self.cols

    def footprint(self, origin: int, item_id: str) -> Optional[List[int]]:
        w, h = self.size_for(item_id)
        col, row = self.coords_of(origin)
        cells: List[int] = []
        for dy in range(h):
            for dx in range(w):
                idx = self.index_at(col + dx, row + dy)
                if idx < 0:
                    return None
                cells.append(idx)
        return cells

    def origin_index(self, index: int) -> int:
        raw = self.slots[index] if 0 <= index < self.size() else None
        if raw and raw.get("occupiedBy") is not None:
            return int(raw["occupiedBy"])
        return index

    def get_slot(self, index: int) -> Optional[Dict[str, Any]]:
        origin = self.origin_index(index)
        raw = self.slots[origin] if 0 <= origin < self.size() else None
        if not raw or raw.get("occupiedBy") is not None:
            return None
        return dict(raw)

    def is_covered(self, index: int) -> bool:
        raw = self.slots[index] if 0 <= index < self.size() else None
        return bool(raw and raw.get("occupiedBy") is not None)

    def can_place_at(self, origin: int, item_id: str, ignore_origin: int = -1) -> bool:
        if not self.accepts(item_id, origin):
            return False
        cells = self.footprint(origin, item_id)
        if cells is None:
            return False
        for idx in cells:
            raw = self.slots[idx]
            if not raw:
                continue
            owner = int(raw["occupiedBy"]) if raw.get("occupiedBy") is not None else idx
            if owner == ignore_origin:
                continue
            return False
        return True

    def clear_footprint(self, origin: int) -> None:
        raw = self.slots[origin] if 0 <= origin < self.size() else None
        if not raw or raw.get("occupiedBy") is not None:
            if 0 <= origin < self.size():
                self.slots[origin] = None
            return
        cells = self.footprint(origin, str(raw["itemId"])) or [origin]
        for idx in cells:
            self.slots[idx] = None

    def place_stack(self, origin: int, stack: Dict[str, Any], ignore_origin: int = -1) -> bool:
        normalized = _norm_stack(stack)
        if not normalized:
            return False
        if not self.can_place_at(origin, normalized["itemId"], ignore_origin):
            return False
        if ignore_origin >= 0:
            self.clear_footprint(ignore_origin)
        else:
            self.clear_footprint(origin)
        cells = self.footprint(origin, normalized["itemId"]) or [origin]
        self.slots[origin] = normalized
        for idx in cells:
            if idx == origin:
                continue
            self.slots[idx] = {"occupiedBy": origin}
        return True

    def take_slot(self, index: int) -> Optional[Dict[str, Any]]:
        origin = self.origin_index(index)
        stack = self.get_slot(origin)
        if not stack:
            return None
        self.clear_footprint(origin)
        return stack

    def find_place_index(self, item_id: str) -> int:
        for i in range(self.size()):
            if self.can_place_at(i, item_id):
                return i
        return -1

    def add_item(self, item_id: str, qty: int) -> int:
        item = ITEMS.get(item_id)
        if not item or qty <= 0:
            return qty
        if not self.accepts(item_id):
            return qty
        remaining = qty
        for i in range(self.size()):
            if remaining <= 0:
                break
            raw = self.slots[i]
            if not raw or raw.get("occupiedBy") is not None or raw.get("itemId") != item_id:
                continue
            space = int(item["maxStack"]) - int(raw["qty"])
            if space <= 0:
                continue
            moved = min(space, remaining)
            raw["qty"] = int(raw["qty"]) + moved
            remaining -= moved
        while remaining > 0:
            origin = self.find_place_index(item_id)
            if origin < 0:
                break
            moved = min(int(item["maxStack"]), remaining)
            self.place_stack(origin, {"itemId": item_id, "qty": moved})
            remaining -= moved
        return remaining

    def remove_item(self, item_id: str, qty: int) -> int:
        if qty <= 0:
            return 0
        need = qty
        removed = 0
        for i in range(self.size()):
            if need <= 0:
                break
            raw = self.slots[i]
            if not raw or raw.get("occupiedBy") is not None or raw.get("itemId") != item_id:
                continue
            take = min(int(raw["qty"]), need)
            if take >= int(raw["qty"]):
                self.clear_footprint(i)
            else:
                raw["qty"] = int(raw["qty"]) - take
            need -= take
            removed += take
        return removed

    def count_item(self, item_id: str) -> int:
        total = 0
        for i in range(self.size()):
            raw = self.slots[i]
            if not raw or raw.get("occupiedBy") is not None or raw.get("itemId") != item_id:
                continue
            total += int(raw["qty"])
        return total

    def update_slot(self, index: int, patch: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        origin = self.origin_index(index)
        raw = self.slots[origin]
        if not raw or raw.get("occupiedBy") is not None:
            return None
        merged = dict(raw)
        merged.update(patch)
        normalized = _norm_stack(merged)
        if not normalized:
            return None
        self.slots[origin] = normalized
        return dict(normalized)

    def to_json(self) -> Dict[str, Any]:
        slots: List[Optional[Dict[str, Any]]] = []
        for slot in self.slots:
            if not slot or slot.get("occupiedBy") is not None:
                slots.append(None)
            else:
                out = {"itemId": slot["itemId"], "qty": slot["qty"]}
                if slot.get("mag") is not None:
                    out["mag"] = slot["mag"]
                slots.append(out)
        data: Dict[str, Any] = {
            "id": self.id,
            "cols": self.cols,
            "rows": self.rows,
            "ignoreItemSize": self.ignore_item_size,
            "slots": slots,
        }
        if self.slot_keys:
            data["slotKeys"] = list(self.slot_keys)
        return data

    @classmethod
    def from_json(cls, data: Dict[str, Any], **overrides: Any) -> "Inventory":
        ignore = overrides.get("ignore_item_size", bool(data.get("ignoreItemSize")))
        slot_keys = overrides.get("slot_keys", data.get("slotKeys"))
        inv = cls(
            str(data.get("id") or "inv"),
            int(data.get("cols") or 1),
            int(data.get("rows") or 1),
            ignore_item_size=ignore,
            slot_keys=slot_keys,
        )
        pending = []
        for i, stack in enumerate(data.get("slots") or []):
            normalized = _norm_stack(stack)
            if normalized:
                pending.append((i, normalized))
        for index, stack in pending:
            if not inv.place_stack(index, stack):
                inv.add_item(stack["itemId"], stack["qty"])
        return inv


def place_on_slot(inventory: Inventory, index: int, stack: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """放入槽位，返回剩余/换出堆叠。"""
    incoming = _norm_stack(stack)
    if not incoming:
        return stack
    origin = inventory.origin_index(index)
    if not inventory.accepts(incoming["itemId"], origin):
        return stack
    current = inventory.get_slot(origin)
    if not current:
        if not inventory.place_stack(origin, incoming):
            return incoming
        return None
    if current["itemId"] == incoming["itemId"]:
        item = ITEMS[incoming["itemId"]]
        space = int(item["maxStack"]) - int(current["qty"])
        if space <= 0:
            return incoming
        moved = min(space, incoming["qty"])
        inventory.slots[origin]["qty"] = int(current["qty"]) + moved
        leftover = incoming["qty"] - moved
        return {"itemId": incoming["itemId"], "qty": leftover} if leftover > 0 else None
    removed = inventory.take_slot(origin)
    if not inventory.place_stack(origin, incoming):
        if removed:
            inventory.place_stack(origin, removed)
        return incoming
    return removed


def quick_transfer(source: Inventory, source_index: int, target: Inventory) -> bool:
    origin = source.origin_index(source_index)
    stack = source.get_slot(origin)
    if not stack or not target.accepts(stack["itemId"]):
        return False
    item = ITEMS.get(stack["itemId"]) or {}
    if item.get("type") == "weapon" or stack.get("mag") is not None:
        dest = target.find_place_index(stack["itemId"])
        if dest < 0:
            return False
        if not target.place_stack(dest, stack):
            return False
        source.take_slot(origin)
        return True
    leftover = target.add_item(stack["itemId"], stack["qty"])
    if leftover >= stack["qty"]:
        return False
    if leftover <= 0:
        source.take_slot(origin)
    else:
        source.slots[origin]["qty"] = leftover
    return True


def create_default_player() -> Inventory:
    """开局背包：与 lp-inventory-core.js PLAYER_SEED 对齐。

    work_satchel 为 2×2，占 0/1/4/5；其余种子落在 2/3/6/7，避免足迹冲突。
    """
    inv = Inventory("player", PLAYER_BASE[0], PLAYER_BASE[1])
    seeds = [
        (0, {"itemId": "work_satchel", "qty": 1}),
        (2, {"itemId": "coal", "qty": 16}),
        (3, {"itemId": "scrap", "qty": 4}),
        (6, {"itemId": "turret_ammo", "qty": 24}),
        (7, {"itemId": "small_caliber_ammo", "qty": 54}),
    ]
    for index, stack in seeds:
        if not inv.place_stack(index, stack):
            inv.add_item(stack["itemId"], int(stack["qty"]))
    return inv


def create_default_storage() -> Inventory:
    """开局仓库：与客户端 STORAGE_SEED 大致对齐（数量取服务端权威默认）。"""
    inv = Inventory("storage", 8, 8)
    for index, stack in [
        (0, {"itemId": "coal", "qty": 100}),
        (1, {"itemId": "lumber", "qty": 64}),
        (2, {"itemId": "iron_ingot", "qty": 40}),
        (3, {"itemId": "scrap", "qty": 20}),
        (4, {"itemId": "turret_ammo", "qty": 80}),
        (5, {"itemId": "small_caliber_ammo", "qty": 90}),
        (16, {"itemId": "gur65", "qty": 1, "mag": 27}),
    ]:
        if not inv.place_stack(index, stack):
            inv.add_item(stack["itemId"], int(stack["qty"]))
    return inv


def create_default_hands() -> Inventory:
    inv = Inventory("hands", 3, 1, ignore_item_size=True)
    inv.place_stack(1, {"itemId": "gur65", "qty": 1, "mag": 27})
    return inv


def create_default_equip() -> Inventory:
    return Inventory("equip", len(EQUIP_SLOT_KEYS), 1, ignore_item_size=True, slot_keys=EQUIP_SLOT_KEYS)


def create_default_crates() -> Dict[str, Inventory]:
    ammo = Inventory("guard-ammo", 4, 2)
    ammo.place_stack(0, {"itemId": "turret_ammo", "qty": 60})
    recycle = Inventory("guard-recycle", 3, 2)
    return {"ammo": ammo, "recycle": recycle}


def resolve_bag_size(equip: Inventory) -> Tuple[int, int]:
    worn = equip.get_slot(5)
    if worn:
        item = ITEMS.get(worn["itemId"]) or {}
        if item.get("bagCols") and item.get("bagRows"):
            return int(item["bagCols"]), int(item["bagRows"])
    return PLAYER_BASE


def sync_player_to_equip(player: Inventory, equip: Inventory) -> List[Dict[str, Any]]:
    cols, rows = resolve_bag_size(equip)
    if player.cols == cols and player.rows == rows:
        return []
    stacks = []
    for i in range(player.size()):
        if player.is_covered(i):
            continue
        stack = player.get_slot(i)
        if stack:
            stacks.append(stack)
    player.cols = cols
    player.rows = rows
    player.slots = [None] * (cols * rows)
    overflow: List[Dict[str, Any]] = []
    for stack in stacks:
        placed = False
        for i in range(player.size()):
            if player.can_place_at(i, stack["itemId"]):
                player.place_stack(i, stack)
                placed = True
                break
        if not placed:
            leftover = player.add_item(stack["itemId"], stack["qty"])
            if leftover > 0:
                drop = {"itemId": stack["itemId"], "qty": leftover}
                if stack.get("mag") is not None:
                    drop["mag"] = stack["mag"]
                overflow.append(drop)
    return overflow


class PlayerInventories:
    """单名玩家的私有库存。"""

    def __init__(self) -> None:
        self.equip = create_default_equip()
        self.player = create_default_player()
        self.hands = create_default_hands()
        sync_player_to_equip(self.player, self.equip)

    def personal_snapshot(self) -> Dict[str, Any]:
        return {
            "player": self.player.to_json(),
            "hands": self.hands.to_json(),
            "equip": self.equip.to_json(),
        }

    def apply_personal(self, data: Dict[str, Any]) -> None:
        if data.get("equip"):
            self.equip = Inventory.from_json(data["equip"], ignore_item_size=True, slot_keys=EQUIP_SLOT_KEYS)
        if data.get("player"):
            self.player = Inventory.from_json(data["player"])
        if data.get("hands"):
            self.hands = Inventory.from_json(data["hands"], ignore_item_size=True)
        sync_player_to_equip(self.player, self.equip)


class RoomInventories:
    """房间共享：仓库、地面、炮塔箱。"""

    def __init__(self) -> None:
        self.storage = create_default_storage()
        self.crates = create_default_crates()
        self.ground: List[Dict[str, Any]] = []
        self._pile_seq = 1

    def room_snapshot(self) -> Dict[str, Any]:
        return {
            "storage": self.storage.to_json(),
            "crates": {
                "ammo": self.crates["ammo"].to_json(),
                "recycle": self.crates["recycle"].to_json(),
            },
            "ground": [
                {
                    "id": p["id"],
                    "x": p["x"],
                    "y": p["y"],
                    "inv": p["inv"].to_json(),
                }
                for p in self.ground
                if any(p["inv"].get_slot(i) for i in range(p["inv"].size()))
            ],
        }

    def get_bag(self, name: str, personal: PlayerInventories, pile_id: Optional[str] = None) -> Optional[Inventory]:
        if name == "player":
            return personal.player
        if name == "hands":
            return personal.hands
        if name == "equip":
            return personal.equip
        if name == "storage":
            return self.storage
        if name == "crate_ammo":
            return self.crates["ammo"]
        if name == "crate_recycle":
            return self.crates["recycle"]
        if name == "ground" and pile_id:
            for pile in self.ground:
                if pile["id"] == pile_id:
                    return pile["inv"]
        return None

    def ensure_ground(self, x: float, y: float) -> Dict[str, Any]:
        for pile in self.ground:
            if abs(pile["x"] - x) <= 48:
                return pile
        pile = {
            "id": f"pile-{self._pile_seq}",
            "x": float(x),
            "y": float(y),
            "inv": Inventory(f"ground-{self._pile_seq}", 5, 4),
        }
        self._pile_seq += 1
        self.ground.append(pile)
        return pile

    def drop_stacks(self, x: float, y: float, stacks: List[Dict[str, Any]]) -> None:
        pile = self.ensure_ground(x, y)
        for raw in stacks:
            stack = _norm_stack(raw)
            if not stack:
                continue
            leftover = pile["inv"].add_item(stack["itemId"], stack["qty"])
            if stack.get("mag") is not None and leftover < stack["qty"]:
                for i in range(pile["inv"].size()):
                    slot = pile["inv"].slots[i]
                    if slot and slot.get("itemId") == stack["itemId"] and slot.get("mag") is None:
                        slot["mag"] = stack["mag"]
                        break
            while leftover > 0:
                pile = {
                    "id": f"pile-{self._pile_seq}",
                    "x": float(x) + self._pile_seq * 6,
                    "y": float(y),
                    "inv": Inventory(f"ground-{self._pile_seq}", 5, 4),
                }
                self._pile_seq += 1
                self.ground.append(pile)
                leftover = pile["inv"].add_item(stack["itemId"], leftover)


def held_weapon_id(personal: PlayerInventories) -> Optional[str]:
    """右手优先，再左手。"""
    for index in (1, 0):
        stack = personal.hands.get_slot(index)
        if not stack:
            continue
        item = ITEMS.get(stack["itemId"]) or {}
        if item.get("type") == "weapon":
            return stack["itemId"]
    return None


def item_is_consumable(item_id: str) -> bool:
    """燃料与弹药视为消耗品（测试自动补充范围）。"""
    item = ITEMS.get(str(item_id)) or {}
    return item.get("type") in CONSUMABLE_TYPES


def refill_consumable_stacks(inv: Inventory) -> None:
    """把库存中燃料/弹药堆叠补到 maxStack，武器弹匣补满。"""
    for index in range(inv.size()):
        if inv.is_covered(index):
            continue
        stack = inv.slots[index]
        if not stack or not stack.get("itemId"):
            continue
        item = ITEMS.get(str(stack["itemId"])) or {}
        if item.get("type") in CONSUMABLE_TYPES:
            inv.slots[index]["qty"] = int(item["maxStack"])
        mag_size = item.get("magazineSize")
        if mag_size is not None:
            inv.slots[index]["mag"] = int(mag_size)


def refill_player_consumables(personal: PlayerInventories) -> None:
    """补满玩家背包/手部/装备里的消耗品与弹匣。"""
    refill_consumable_stacks(personal.player)
    refill_consumable_stacks(personal.hands)
    refill_consumable_stacks(personal.equip)


def refill_room_consumables(room_inv: RoomInventories) -> None:
    """补满仓库、炮塔箱、地面堆中的消耗品。"""
    refill_consumable_stacks(room_inv.storage)
    for crate in room_inv.crates.values():
        refill_consumable_stacks(crate)
    for pile in room_inv.ground:
        refill_consumable_stacks(pile["inv"])


def consume_from_personal(personal: PlayerInventories, item_id: str, qty: int) -> int:
    """从手部再背包扣除物品。测试模式下消耗品视为扣成功并立即补满。"""
    need = max(0, int(qty))
    if need <= 0:
        return 0
    if TEST_AUTO_REFILL_CONSUMABLES and item_is_consumable(item_id):
        have = personal.hands.count_item(item_id) + personal.player.count_item(item_id)
        if have <= 0:
            item = ITEMS.get(item_id) or {}
            personal.player.add_item(item_id, int(item.get("maxStack") or need))
        refill_player_consumables(personal)
        return need
    removed = personal.hands.remove_item(item_id, need)
    rest = need - removed
    if rest > 0:
        removed += personal.player.remove_item(item_id, rest)
    return removed
