"""皮套文件管理：校验、落盘、列出、读取、删除、穿戴记忆。

存储布局（每个皮套一个目录，方便以后格式扩展成多贴图/动画帧）：

    var/uploads/skins/
    └── <skin_id>/
        ├── texture.png      # 皮套贴图（格式草案 v0：单张 PNG/WebP）
        └── manifest.json    # 元信息：名称、上传者、时间、格式版本、内容哈希

    var/uploads/worn/
    └── <user_key>.txt       # 该用户当前穿戴的皮套 id

保存模式要点：
- 归属：系统皮套（uploader = system）对所有人可见；其余皮套只对上传者可见。
- 去重：同一用户上传字节完全相同的贴图时复用已有皮套，不重复存储。
- 覆盖：传入 skin_id 且属于该用户时，原地更新而非新建（编辑器同一会话反复保存用）。
- 配额：每人皮套数量上限，超出自动淘汰最旧的（不含正在穿戴的）。

皮套格式细节见 docs/skin-format.md，后续调整格式时同步改这里的校验与 FORMAT_VERSION。
"""

from __future__ import annotations

import hashlib
import json
import logging
import shutil
import time
import uuid
from pathlib import Path
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

FORMAT_VERSION = 0
MAX_TEXTURE_BYTES = 2 * 1024 * 1024
DEFAULT_HEIGHT_SCALE = 1.0
MIN_HEIGHT_SCALE = 0.8
MAX_HEIGHT_SCALE = 1.5

# 系统内置皮套的上传者标记：对所有玩家可见，且不可删除。
SYSTEM_UPLOADER = "system"
# 每个玩家最多保留的皮套数量（不含系统皮套），超出自动淘汰最旧的。
MAX_SKINS_PER_USER = 20

# plain = 整张贴图直接绘制；uv = 按 docs/skin-format.md 的 UV 图版式分部位绘制
SKIN_KINDS = {"plain", "uv"}

# 本地包位于 <project>/app/games；线上包直接位于 /app/games。
_APP_ROOT = Path(__file__).resolve().parents[2]
_PROJECT_ROOT = (
    _APP_ROOT.parent
    if (_APP_ROOT.parent / "requirements.txt").is_file()
    else _APP_ROOT
)
SKINS_ROOT = _PROJECT_ROOT / "var" / "uploads" / "skins"
WORN_ROOT = _PROJECT_ROOT / "var" / "uploads" / "worn"


class SkinValidationError(ValueError):
    """皮套文件不符合当前格式草案时抛出，message 直接展示给用户。"""


def _detect_extension(data: bytes) -> str:
    """按魔数识别贴图格式，不认识的格式直接拒绝。"""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "webp"
    raise SkinValidationError("仅支持 PNG 或 WebP 贴图")


def validate_texture(data: bytes) -> str:
    """校验皮套贴图字节流，返回扩展名；不合规抛 SkinValidationError。"""
    if not data:
        raise SkinValidationError("文件为空")
    if len(data) > MAX_TEXTURE_BYTES:
        raise SkinValidationError(
            f"贴图不能超过 {MAX_TEXTURE_BYTES // 1024 // 1024} MB"
        )
    return _detect_extension(data)


def _content_hash(data: bytes) -> str:
    """贴图字节的内容指纹，用于同一用户的去重。"""
    return hashlib.sha1(data).hexdigest()


def _is_valid_id(skin_id: str) -> bool:
    """皮套 id 只允许字母数字，避免路径穿越。"""
    return bool(skin_id) and skin_id.isalnum()


def _user_key(user_id: str) -> str:
    """把用户标识转成安全的文件名片段。"""
    return "".join(ch if ch.isalnum() else "_" for ch in str(user_id)) or "anon"


def _write_texture(skin_dir: Path, data: bytes, extension: str) -> str:
    """写入贴图，覆盖时先清掉旧的 texture.* 以免残留不同扩展名。"""
    for stale in skin_dir.glob("texture.*"):
        stale.unlink()
    texture_name = f"texture.{extension}"
    (skin_dir / texture_name).write_bytes(data)
    return texture_name


def _iter_manifests() -> List[Tuple[Path, Dict]]:
    """遍历所有皮套目录，返回 (目录, manifest) 列表，跳过损坏项。"""
    if not SKINS_ROOT.is_dir():
        return []
    out: List[Tuple[Path, Dict]] = []
    for manifest_path in SKINS_ROOT.glob("*/manifest.json"):
        manifest = _read_manifest(manifest_path)
        if manifest is not None:
            out.append((manifest_path.parent, manifest))
    return out


def _find_user_skin_by_hash(
    uploader_id: str,
    content_hash: str,
    manifests: Optional[List[Tuple[Path, Dict]]] = None,
) -> Optional[Dict]:
    """在某用户名下查找内容哈希相同的皮套，用于去重复用。"""
    items = manifests if manifests is not None else _iter_manifests()
    for _, manifest in items:
        if (
            manifest.get("uploader_id") == uploader_id
            and manifest.get("content_hash") == content_hash
        ):
            return manifest
    return None


def save_skin(
    data: bytes,
    skin_name: str,
    uploader_id: str,
    kind: str = "plain",
    height_scale: float = DEFAULT_HEIGHT_SCALE,
    skin_id: Optional[str] = None,
) -> Dict:
    """校验并保存一张皮套贴图，返回写入的 manifest。

    skin_id 指定且属于该用户时原地覆盖；否则同内容去重复用，再否则新建。
    """
    if kind not in SKIN_KINDS:
        raise SkinValidationError("未知的皮套类型")
    if not MIN_HEIGHT_SCALE <= height_scale <= MAX_HEIGHT_SCALE:
        raise SkinValidationError("身高比例必须在 80% 到 150% 之间")
    extension = validate_texture(data)
    content_hash = _content_hash(data)

    # 单次扫描，供去重与配额共用，避免多次读盘。
    manifests = _iter_manifests()
    reused_id = _resolve_target_id(skin_id, uploader_id, content_hash, manifests)
    final_id = reused_id or uuid.uuid4().hex[:12]
    skin_dir = SKINS_ROOT / final_id
    skin_dir.mkdir(parents=True, exist_ok=True)
    texture_name = _write_texture(skin_dir, data, extension)

    manifest = {
        "id": final_id,
        "name": skin_name.strip()[:32] or "未命名皮套",
        "uploader_id": uploader_id,
        "texture": texture_name,
        "kind": kind,
        "height_scale": round(height_scale, 2),
        "content_hash": content_hash,
        "format_version": FORMAT_VERSION,
        "created_at": int(time.time()),
    }
    (skin_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    if reused_id is None:
        _enforce_quota(uploader_id, keep_id=final_id, manifests=manifests)
    return manifest


def _resolve_target_id(
    skin_id: Optional[str],
    uploader_id: str,
    content_hash: str,
    manifests: List[Tuple[Path, Dict]],
) -> Optional[str]:
    """决定复用哪个已有皮套目录：显式覆盖优先，其次同内容去重。"""
    if skin_id and _is_valid_id(skin_id):
        existing = _read_manifest(SKINS_ROOT / skin_id / "manifest.json")
        if existing is not None and existing.get("uploader_id") == uploader_id:
            return skin_id
    duplicate = _find_user_skin_by_hash(uploader_id, content_hash, manifests)
    return duplicate.get("id") if duplicate else None


def _enforce_quota(
    uploader_id: str,
    keep_id: str,
    manifests: Optional[List[Tuple[Path, Dict]]] = None,
) -> None:
    """超出每人配额时，淘汰最旧的自有皮套（保留刚保存的和正在穿戴的）。"""
    items = manifests if manifests is not None else _iter_manifests()
    owned = [
        manifest
        for _, manifest in items
        if manifest.get("uploader_id") == uploader_id
    ]
    # 刚新建的皮套尚未出现在本次扫描结果里，计入总数。
    if not any(m.get("id") == keep_id for m in owned):
        owned = owned + [{"id": keep_id, "created_at": int(time.time())}]
    if len(owned) <= MAX_SKINS_PER_USER:
        return
    worn_id = get_worn(uploader_id)
    owned.sort(key=lambda item: item.get("created_at", 0))
    removable = [
        m for m in owned if m.get("id") not in (keep_id, worn_id)
    ]
    overflow = len(owned) - MAX_SKINS_PER_USER
    for manifest in removable[:overflow]:
        _remove_skin_dir(manifest["id"])


def _read_manifest(manifest_path: Path) -> Optional[Dict]:
    """读取单个 manifest；损坏或缺失时记录日志并返回 None。"""
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        logger.warning("跳过损坏的皮套 manifest: %s (%s)", manifest_path, exc)
        return None
    if not isinstance(payload, dict) or not payload.get("id"):
        logger.warning("跳过无效的皮套 manifest: %s", manifest_path)
        return None
    return payload


def list_skins(user_id: str) -> List[Dict]:
    """列出该用户可见的皮套（系统皮套 + 自己上传的），按时间倒序。"""
    visible = [
        manifest
        for _, manifest in _iter_manifests()
        if manifest.get("uploader_id") in (SYSTEM_UPLOADER, user_id)
    ]
    visible.sort(key=lambda item: item.get("created_at", 0), reverse=True)
    return visible


def delete_skin(skin_id: str, user_id: str) -> bool:
    """删除该用户自己的皮套；系统皮套或非本人皮套一律拒绝。"""
    if not _is_valid_id(skin_id):
        return False
    manifest = _read_manifest(SKINS_ROOT / skin_id / "manifest.json")
    if manifest is None or manifest.get("uploader_id") != user_id:
        return False
    _remove_skin_dir(skin_id)
    if get_worn(user_id) == skin_id:
        set_worn(user_id, None)
    return True


def _remove_skin_dir(skin_id: str) -> None:
    """物理删除皮套目录。"""
    shutil.rmtree(SKINS_ROOT / skin_id, ignore_errors=True)


def get_texture_path(skin_id: str) -> Optional[Path]:
    """返回某个皮套的贴图文件路径；皮套不存在或 id 非法返回 None。"""
    if not _is_valid_id(skin_id):
        return None
    manifest_path = SKINS_ROOT / skin_id / "manifest.json"
    if not manifest_path.is_file():
        return None
    manifest = _read_manifest(manifest_path)
    if manifest is None:
        return None
    texture_name = str(manifest.get("texture") or "")
    if not texture_name:
        return None
    texture_path = SKINS_ROOT / skin_id / texture_name
    return texture_path if texture_path.is_file() else None


def get_worn(user_id: str) -> Optional[str]:
    """读取该用户当前穿戴的皮套 id；未设置返回 None。"""
    worn_path = WORN_ROOT / f"{_user_key(user_id)}.txt"
    if not worn_path.is_file():
        return None
    skin_id = worn_path.read_text(encoding="utf-8").strip()
    return skin_id if _is_valid_id(skin_id) else None


def set_worn(user_id: str, skin_id: Optional[str]) -> bool:
    """记录该用户穿戴的皮套；skin_id 为空则清除。皮套不可见时拒绝。"""
    worn_path = WORN_ROOT / f"{_user_key(user_id)}.txt"
    if not skin_id:
        worn_path.unlink(missing_ok=True)
        return True
    if not _is_valid_id(skin_id):
        return False
    manifest = _read_manifest(SKINS_ROOT / skin_id / "manifest.json")
    if manifest is None or manifest.get("uploader_id") not in (
        SYSTEM_UPLOADER,
        user_id,
    ):
        return False
    WORN_ROOT.mkdir(parents=True, exist_ok=True)
    worn_path.write_text(skin_id, encoding="utf-8")
    return True


def _appearance_from_manifest(manifest: Dict) -> Dict:
    """把 manifest 收成多人同步用的外观字段。"""
    return {
        "skinId": manifest.get("id"),
        "kind": manifest.get("kind") or "plain",
        "heightScale": float(manifest.get("height_scale") or DEFAULT_HEIGHT_SCALE),
        "contentHash": str(manifest.get("content_hash") or manifest.get("created_at") or ""),
    }


def get_appearance_for_user(user_id: str) -> Optional[Dict]:
    """读取用户当前穿戴皮套的外观；未穿戴返回 None。"""
    worn_id = get_worn(user_id)
    if not worn_id:
        return None
    return get_appearance_for_broadcast(user_id, worn_id)


def get_appearance_for_broadcast(user_id: str, skin_id: Optional[str]) -> Optional[Dict]:
    """供多人广播：仅系统皮套或该用户自己的皮套可被暴露；清空穿戴返回占位外观。"""
    if not skin_id:
        return {
            "skinId": None,
            "kind": "plain",
            "heightScale": DEFAULT_HEIGHT_SCALE,
            "contentHash": "",
        }
    if not _is_valid_id(str(skin_id)):
        return None
    manifest = _read_manifest(SKINS_ROOT / str(skin_id) / "manifest.json")
    if manifest is None:
        return None
    if manifest.get("uploader_id") not in (SYSTEM_UPLOADER, user_id):
        return None
    return _appearance_from_manifest(manifest)
