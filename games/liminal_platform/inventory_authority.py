"""阈限月台服务端物品栏权威：网格、堆叠、共享仓库/地面/弹药箱。

与客户端 lp-inventory-core.js 的 JSON 形状对齐（id/cols/rows/slots/mag）。
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Dict, List, Optional, Tuple

# TEST_ONLY — remove after playtest：燃料/弹药堆与仓储种子物资自动补满；炮塔箱同。
# 不含手持武器弹匣（开火必须扣弹）。正式上线前改为 False。
TEST_AUTO_REFILL_CONSUMABLES = True
CONSUMABLE_TYPES = frozenset({"fuel", "ammo"})

# 与 create_default_storage 对齐；无限仓储按此种子补到 maxStack（或缺省 qty）。
STORAGE_SEED: List[Tuple[int, Dict[str, Any]]] = [
    (0, {"itemId": "coal", "qty": 100}),
    (1, {"itemId": "lumber", "qty": 64}),
    (2, {"itemId": "iron_ingot", "qty": 40}),
    (3, {"itemId": "scrap", "qty": 20}),
    (4, {"itemId": "turret_ammo", "qty": 80}),
    (5, {"itemId": "small_caliber_ammo", "qty": 90}),
    (16, {"itemId": "gur65", "qty": 1, "mag": 27}),
]

# 与 lp-item-catalog.js 关键字段对齐（校验用）
ITEMS: Dict[str, Dict[str, Any]] = {
    "coal": {"maxStack": 100, "w": 1, "h": 1, "type": "fuel", "boilerFuel": 18, "canHold": True},
    "lumber": {"maxStack": 100, "w": 1, "h": 1, "type": "material", "canHold": True},
    "iron_ingot": {"maxStack": 50, "w": 1, "h": 1, "type": "metal", "canHold": True},
    "scrap": {"maxStack": 50, "w": 1, "h": 1, "type": "material", "canHold": True},
    "wrench": {"maxStack": 1, "w": 2, "h": 1, "type": "tool", "canHold": True},
    "turret_ammo": {"maxStack": 100, "w": 1, "h": 2, "type": "ammo", "canHold": True},
    "shell_casing": {"maxStack": 100, "w": 1, "h": 2, "type": "material", "canHold": True},
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
HANDS_WEAPON_SLOTS = (0, 1)


def _is_weapon(item_id: str) -> bool:
    """与客户端 Catalog.isWeapon 对齐：type==weapon 或声明 weaponId。"""
    item = ITEMS.get(item_id) or {}
    return item.get("type") == "weapon" or bool(item.get("weaponId"))


def _stack_rot(stack: Optional[Dict[str, Any]]) -> int:
    """读取堆叠朝向：仅 0 与顺时针 90。"""
    if not stack:
        return 0
    try:
        return 90 if int(stack.get("rot") or 0) == 90 else 0
    except (TypeError, ValueError):
        return 0


def _toggled_rot(rot: int) -> int:
    """在 0° / 90° 之间切换。"""
    return 0 if int(rot) == 90 else 90


def _oriented_size(item_id: str, rot: int = 0) -> Tuple[int, int]:
    """按朝向返回占格宽高（90° 时交换 w/h）。"""
    item = ITEMS.get(item_id) or {}
    w = int(item.get("w", 1))
    h = int(item.get("h", 1))
    if int(rot) == 90:
        return h, w
    return w, h


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
    if _stack_rot(stack) == 90:
        out["rot"] = 90
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

    def size_for(self, item_id: str, rot: int = 0) -> Tuple[int, int]:
        if self.ignore_item_size:
            return 1, 1
        return _oriented_size(item_id, rot)

    def accepts(self, item_id: str, index: Optional[int] = None) -> bool:
        """手部 0/1 仅武器；快捷槽禁止武器；装备栏按 slot_keys。"""
        item = ITEMS.get(item_id)
        if not item:
            return False
        if self.id == "hands" or self.id.startswith("hands"):
            if not item.get("canHold", True):
                return False
            is_weapon = _is_weapon(item_id)
            if index is None:
                # 未指定槽：武器可进 0/1，其它可进快捷槽；具体格由 can_place_at 判定。
                return True
            if index == HANDS_UTILITY:
                return not is_weapon
            return is_weapon
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

    def footprint(self, origin: int, item_id: str, rot: int = 0) -> Optional[List[int]]:
        w, h = self.size_for(item_id, rot)
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

    def can_place_at(
        self, origin: int, item_id: str, ignore_origin: int = -1, rot: int = 0
    ) -> bool:
        if not self.accepts(item_id, origin):
            return False
        cells = self.footprint(origin, item_id, rot)
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
        cells = self.footprint(origin, str(raw["itemId"]), _stack_rot(raw)) or [origin]
        for idx in cells:
            self.slots[idx] = None

    def place_stack(self, origin: int, stack: Dict[str, Any], ignore_origin: int = -1) -> bool:
        normalized = _norm_stack(stack)
        if not normalized:
            return False
        if not self.can_place_at(
            origin, normalized["itemId"], ignore_origin, _stack_rot(normalized)
        ):
            return False
        if ignore_origin >= 0:
            self.clear_footprint(ignore_origin)
        else:
            self.clear_footprint(origin)
        cells = self.footprint(
            origin, normalized["itemId"], _stack_rot(normalized)
        ) or [origin]
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

    def toggle_rotation(self, origin: int) -> bool:
        """切换原点堆叠朝向；新足迹放不下则拒绝。"""
        stack = self.get_slot(origin)
        if not stack or self.origin_index(origin) != origin:
            return False
        next_rot = _toggled_rot(_stack_rot(stack))
        if not self.can_place_at(origin, stack["itemId"], origin, next_rot):
            return False
        next_stack = dict(stack)
        if next_rot == 90:
            next_stack["rot"] = 90
        else:
            next_stack.pop("rot", None)
        self.clear_footprint(origin)
        return self.place_stack(origin, next_stack)

    def find_place_index(self, item_id: str, rot: int = 0) -> int:
        for i in range(self.size()):
            if self.can_place_at(i, item_id, -1, rot):
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
                if _stack_rot(slot) == 90:
                    out["rot"] = 90
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
        if leftover <= 0:
            return None
        left: Dict[str, Any] = {"itemId": incoming["itemId"], "qty": leftover}
        if incoming.get("mag") is not None:
            left["mag"] = incoming["mag"]
        if _stack_rot(incoming) == 90:
            left["rot"] = 90
        return left
    removed = inventory.take_slot(origin)
    if not inventory.place_stack(origin, incoming):
        if removed:
            inventory.place_stack(origin, removed)
        return incoming
    return removed


def weapon_accepts_ammo(weapon_item_id: str, ammo_item_id: str) -> bool:
    """武器是否接受该弹药：须有 magazineSize，且 ammoId 与弹药 id 一致。"""
    weapon = ITEMS.get(str(weapon_item_id) or "") or {}
    ammo_id = str(ammo_item_id or "").strip()
    if not weapon or not ammo_id:
        return False
    if weapon.get("type") != "weapon" and not weapon.get("weaponId"):
        return False
    mag_size = weapon.get("magazineSize")
    accepts = weapon.get("ammoId")
    if mag_size is None or not accepts:
        return False
    return str(accepts) == ammo_id


def is_ammo_onto_weapon_intent(
    ammo_stack: Optional[Dict[str, Any]], weapon_stack: Optional[Dict[str, Any]]
) -> bool:
    """弹药堆拖到带弹匣武器上时视为装填意图（兼容与否另判）。"""
    if not ammo_stack or not weapon_stack:
        return False
    ammo_item = ITEMS.get(str(ammo_stack.get("itemId") or "")) or {}
    weapon_item = ITEMS.get(str(weapon_stack.get("itemId") or "")) or {}
    if ammo_item.get("type") != "ammo":
        return False
    if weapon_item.get("magazineSize") is None:
        return False
    return weapon_item.get("type") == "weapon" or bool(weapon_item.get("weaponId"))


def try_load_ammo_onto_weapon(
    weapon_inv: Inventory, weapon_index: int, ammo_stack: Dict[str, Any]
) -> Tuple[bool, int, Optional[Dict[str, Any]]]:
    """用弹药堆装填武器格弹匣。

    返回 (ok, loaded, leftover)：
    - ok=False：不匹配，leftover 为原弹药堆（调用方原位放回）
    - ok=True：已写入 mag；leftover 为剩余弹药（None=用尽）
    """
    incoming = _norm_stack(ammo_stack)
    if not incoming:
        return False, 0, ammo_stack
    origin = weapon_inv.origin_index(weapon_index)
    weapon_stack = weapon_inv.get_slot(origin)
    if not is_ammo_onto_weapon_intent(incoming, weapon_stack):
        return False, 0, incoming
    assert weapon_stack is not None
    if not weapon_accepts_ammo(str(weapon_stack["itemId"]), str(incoming["itemId"])):
        return False, 0, incoming
    weapon_item = ITEMS.get(str(weapon_stack["itemId"])) or {}
    mag_size = int(weapon_item.get("magazineSize") or 0)
    need = mag_size - int(weapon_stack.get("mag") or 0)
    if need <= 0:
        return True, 0, incoming
    take = min(need, int(incoming["qty"]))
    if take <= 0:
        return True, 0, incoming
    weapon_inv.update_slot(origin, {"mag": int(weapon_stack.get("mag") or 0) + take})
    left_qty = int(incoming["qty"]) - take
    if left_qty <= 0:
        return True, take, None
    return True, take, {"itemId": incoming["itemId"], "qty": left_qty}


def quick_transfer(source: Inventory, source_index: int, target: Inventory) -> bool:
    origin = source.origin_index(source_index)
    stack = source.get_slot(origin)
    if not stack or not target.accepts(stack["itemId"]):
        return False
    item = ITEMS.get(stack["itemId"]) or {}
    if item.get("type") == "weapon" or stack.get("mag") is not None or _stack_rot(stack) == 90:
        dest = target.find_place_index(stack["itemId"], _stack_rot(stack))
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

    work_satchel 为 2×2，占 0/1/4/5；其余种子落在 2/3/6。
    turret_ammo 现为 1×2，基础 4×2 装不下，由客户端 PLAYER_OVERFLOW_SEED 丢到脚边。
    """
    inv = Inventory("player", PLAYER_BASE[0], PLAYER_BASE[1])
    seeds = [
        (0, {"itemId": "work_satchel", "qty": 1}),
        (2, {"itemId": "coal", "qty": 16}),
        (3, {"itemId": "scrap", "qty": 4}),
        (6, {"itemId": "small_caliber_ammo", "qty": 54}),
    ]
    for index, stack in seeds:
        if not inv.place_stack(index, stack):
            inv.add_item(stack["itemId"], int(stack["qty"]))
    return inv


def create_default_storage() -> Inventory:
    """开局仓库：与客户端 STORAGE_SEED 大致对齐（数量取服务端权威默认）。"""
    inv = Inventory("storage", 8, 8)
    for index, stack in STORAGE_SEED:
        if not inv.place_stack(index, dict(stack)):
            inv.add_item(stack["itemId"], int(stack["qty"]))
    return inv


def _dump_stack_to_player(player: Inventory, stack: Dict[str, Any]) -> None:
    """把堆叠退回背包（尽量保留弹匣与朝向）。"""
    if not stack:
        return
    rot = _stack_rot(stack)
    for i in range(player.size()):
        if player.is_covered(i):
            continue
        if player.get_slot(i):
            continue
        if player.can_place_at(i, stack["itemId"], -1, rot):
            player.place_stack(i, stack)
            return
    player.add_item(stack["itemId"], int(stack["qty"]))


def sanitize_hands(hands: Inventory, player: Inventory) -> None:
    """手部武器槽清出非武器，快捷槽清出枪械；非法物品退回背包。"""
    for index in HANDS_WEAPON_SLOTS:
        stack = hands.get_slot(index)
        if stack and not _is_weapon(stack["itemId"]):
            taken = hands.take_slot(index)
            if taken:
                _dump_stack_to_player(player, taken)
    util = hands.get_slot(HANDS_UTILITY)
    if util and _is_weapon(util["itemId"]):
        taken = hands.take_slot(HANDS_UTILITY)
        if taken:
            _dump_stack_to_player(player, taken)


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
            if player.can_place_at(i, stack["itemId"], -1, _stack_rot(stack)):
                player.place_stack(i, stack)
                placed = True
                break
        if not placed:
            leftover = player.add_item(stack["itemId"], stack["qty"])
            if leftover > 0:
                drop = {"itemId": stack["itemId"], "qty": leftover}
                if stack.get("mag") is not None:
                    drop["mag"] = stack["mag"]
                if _stack_rot(stack) == 90:
                    drop["rot"] = 90
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
        """套用客户端/存档私有库存，并校正手部槽合法性。"""
        if data.get("equip"):
            self.equip = Inventory.from_json(data["equip"], ignore_item_size=True, slot_keys=EQUIP_SLOT_KEYS)
        if data.get("player"):
            self.player = Inventory.from_json(data["player"])
        if data.get("hands"):
            self.hands = Inventory.from_json(data["hands"], ignore_item_size=True)
        sanitize_hands(self.hands, self.player)
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
    """右手优先，再左手（仅武器槽 0/1）。"""
    for index in HANDS_WEAPON_SLOTS[::-1]:
        stack = personal.hands.get_slot(index)
        if not stack:
            continue
        if _is_weapon(stack["itemId"]):
            return stack["itemId"]
    return None


def item_is_consumable(item_id: str) -> bool:
    """燃料与弹药视为消耗品（测试自动补充范围）。"""
    item = ITEMS.get(str(item_id)) or {}
    return item.get("type") in CONSUMABLE_TYPES


def refill_consumable_stacks(inv: Inventory) -> None:
    """把库存中燃料/弹药堆叠补到 maxStack（不补武器弹匣）。"""
    for index in range(inv.size()):
        if inv.is_covered(index):
            continue
        stack = inv.slots[index]
        if not stack or not stack.get("itemId"):
            continue
        item = ITEMS.get(str(stack["itemId"])) or {}
        if item.get("type") in CONSUMABLE_TYPES:
            inv.slots[index]["qty"] = int(item["maxStack"])


def refill_storage_infinite(storage: Inventory) -> None:
    """TEST_ONLY — remove after playtest：仓储种子物资补到 maxStack（或种子 qty），取用不尽。"""
    for _index, seed in STORAGE_SEED:
        item_id = str(seed["itemId"])
        item = ITEMS.get(item_id) or {}
        want = int(item.get("maxStack") or seed.get("qty") or 1)
        have = storage.count_item(item_id)
        if have >= want:
            continue
        need = want - have
        leftover = storage.add_item(item_id, need)
        # 武器等带弹匣：若刚补进，把缺 mag 的堆设为满匣
        mag_size = item.get("magazineSize")
        if mag_size is None or leftover >= need:
            continue
        for i in range(storage.size()):
            if storage.is_covered(i):
                continue
            st = storage.slots[i]
            if not st or st.get("itemId") != item_id:
                continue
            if st.get("mag") is None:
                storage.slots[i]["mag"] = int(mag_size)


def refill_player_consumables(personal: PlayerInventories) -> None:
    """补满玩家背包/手部/装备里的燃料与弹药堆（不补弹匣）。"""
    refill_consumable_stacks(personal.player)
    refill_consumable_stacks(personal.hands)
    refill_consumable_stacks(personal.equip)


def refill_room_consumables(room_inv: RoomInventories) -> None:
    """TEST_ONLY：无限仓储 + 炮塔箱/地面消耗品堆补满。"""
    refill_storage_infinite(room_inv.storage)
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
