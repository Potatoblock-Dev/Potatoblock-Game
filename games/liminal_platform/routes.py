"""阈限月台路由挂载：加载 game/Liminal_Platform/routes.py。"""

import importlib.util
from pathlib import Path

_ROUTES_FILE = Path(__file__).resolve().parents[3] / "game" / "Liminal_Platform" / "routes.py"
_spec = importlib.util.spec_from_file_location("liminal_platform_game_routes", _ROUTES_FILE)
_module = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(_module)

game_info = _module.game_info
router = _module.router

__all__ = ["game_info", "router"]
