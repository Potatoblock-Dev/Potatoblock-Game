"""服务器侧自动更新：git fetch/pull --ff-only，仅在远端领先时拉取并退出进程以便 MCS 重启。

仓库根目录即本包目录（/app）。未纳入 git 的文件（如 main.py、routers/、var/）保持不动。
"""

from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import sys
from pathlib import Path

logger = logging.getLogger("auto_update")

APP_ROOT = Path(__file__).resolve().parent
DEFAULT_INTERVAL_SEC = 60
DEFAULT_REMOTE = "origin"
DEFAULT_BRANCH = "main"


def _env_int(name: str, default: int) -> int:
    """读取正整数环境变量，非法时回落默认值。"""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    return max(1, int(raw))


def _git(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    """在 APP_ROOT 下执行 git，捕获 stdout/stderr 文本。"""
    return subprocess.run(
        ["git", "-C", str(APP_ROOT), *args],
        check=check,
        capture_output=True,
        text=True,
    )


def git_repo_ready() -> bool:
    """确认 /app 已是 git 工作树且配置了远端。"""
    if not (APP_ROOT / ".git").exists():
        return False
    probe = _git("remote", "get-url", DEFAULT_REMOTE, check=False)
    return probe.returncode == 0


def remote_ahead() -> bool:
    """fetch 后比较 HEAD 与 origin/branch，远端领先则返回 True。"""
    branch = os.environ.get("AUTO_UPDATE_BRANCH", DEFAULT_BRANCH).strip() or DEFAULT_BRANCH
    remote = os.environ.get("AUTO_UPDATE_REMOTE", DEFAULT_REMOTE).strip() or DEFAULT_REMOTE
    fetch = _git("fetch", remote, branch, check=False)
    if fetch.returncode != 0:
        logger.warning("git fetch failed: %s", (fetch.stderr or fetch.stdout).strip())
        return False
    local = _git("rev-parse", "HEAD").stdout.strip()
    upstream = _git("rev-parse", f"{remote}/{branch}").stdout.strip()
    return local != upstream


def pull_ff_only() -> None:
    """仅快进拉取；失败则抛出 CalledProcessError。"""
    branch = os.environ.get("AUTO_UPDATE_BRANCH", DEFAULT_BRANCH).strip() or DEFAULT_BRANCH
    remote = os.environ.get("AUTO_UPDATE_REMOTE", DEFAULT_REMOTE).strip() or DEFAULT_REMOTE
    _git("pull", "--ff-only", remote, branch)


def restart_process() -> None:
    """退出进程，交由 MCSManager 按实例配置自动拉起。"""
    logger.info("auto_update: exiting for restart after git pull")
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)


async def _poll_loop() -> None:
    """后台轮询远端；有新提交则 pull 并重启。"""
    interval = _env_int("AUTO_UPDATE_INTERVAL_SEC", DEFAULT_INTERVAL_SEC)
    logger.info(
        "auto_update enabled: root=%s interval=%ss",
        APP_ROOT,
        interval,
    )
    while True:
        await asyncio.sleep(interval)
        try:
            if not remote_ahead():
                continue
            logger.info("auto_update: remote ahead, pulling")
            pull_ff_only()
            restart_process()
        except Exception:
            logger.exception("auto_update cycle failed")


def attach_auto_update(fastapi_app) -> None:
    """挂到 FastAPI lifespan：进程启动后开始轮询（可用 AUTO_UPDATE=0 关闭）。"""
    enabled = os.environ.get("AUTO_UPDATE", "1").strip().lower()
    if enabled in {"0", "false", "off", "no"}:
        logger.info("auto_update disabled by AUTO_UPDATE")
        return
    if not git_repo_ready():
        logger.warning(
            "auto_update skipped: %s is not a git checkout with remote %s",
            APP_ROOT,
            DEFAULT_REMOTE,
        )
        return

    task_holder: dict[str, asyncio.Task | None] = {"task": None}

    @fastapi_app.on_event("startup")
    async def _start_auto_update() -> None:
        task_holder["task"] = asyncio.create_task(_poll_loop())

    @fastapi_app.on_event("shutdown")
    async def _stop_auto_update() -> None:
        task = task_holder["task"]
        if task is None:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
