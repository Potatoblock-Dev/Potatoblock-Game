"""
CD 部署脚本：将项目文件上传到 MCSManager 并重启实例。

使用 MCSManager v10 REST API，仅依赖 Python 标准库 + requests。

环境变量（必需）:
  MCSM_PANEL_URL      MCSManager 面板地址，如 http://10.0.0.1:23333
  MCSM_API_KEY        API 密钥（面板 → 用户管理 → API 密钥）
  MCSM_DAEMON_ID      守护进程/远程节点 UUID
  MCSM_INSTANCE_UUID  实例 UUID

环境变量（可选）:
  MCSM_UPLOAD_DIR     上传目标目录，默认 /app
  MCSM_DEPLOY_ARCHIVE 上传的 zip 文件名（单包兜底名），默认 __deploy_package__.zip
  MCSM_MAX_PART_BYTES 分包上限（压缩后目标），默认 2621440（2.5MiB）
  MCSM_UPLOAD_RETRIES 单次上传重试次数，默认 4
  MCSM_UPLOAD_TIMEOUT 单次上传超时秒数，默认 180
  MCSM_DRY_RUN        设为 1 仅校验连接与参数，不实际部署

用法:
  python deploy.py          # 直接部署
  MCSM_DRY_RUN=1 python deploy.py  # 仅检查连接

说明:
  MCS daemon 上传通道对大包不稳（约 >3MB 易 408 / RemoteDisconnected）。
  脚本会把仓库打成多个小 zip；超过分包上限的单个大文件改为直传目标目录。
"""

from __future__ import annotations

import os
import sys
import json
import time
import tempfile
import zipfile
import subprocess
from pathlib import Path
from urllib.parse import urljoin

# ---------------------------------------------------------------------------
# 环境变量
# ---------------------------------------------------------------------------
PANEL_URL = os.environ.get("MCSM_PANEL_URL", "").strip().rstrip("/")
API_KEY = os.environ.get("MCSM_API_KEY", "").strip()
DAEMON_ID = os.environ.get("MCSM_DAEMON_ID", "").strip()
INSTANCE_UUID = os.environ.get("MCSM_INSTANCE_UUID", "").strip()
UPLOAD_DIR = os.environ.get("MCSM_UPLOAD_DIR", "/app").strip()
DEPLOY_ARCHIVE = os.environ.get("MCSM_DEPLOY_ARCHIVE", "__deploy_package__.zip").strip()
DRY_RUN = os.environ.get("MCSM_DRY_RUN", "0").strip() in {"1", "true", "yes"}
MAX_PART_BYTES = int(os.environ.get("MCSM_MAX_PART_BYTES", str(2621440)))
UPLOAD_RETRIES = max(1, int(os.environ.get("MCSM_UPLOAD_RETRIES", "4")))
UPLOAD_TIMEOUT = max(30, int(os.environ.get("MCSM_UPLOAD_TIMEOUT", "180")))

APP_ROOT = Path(__file__).resolve().parent

# 项目自身文件（不在 git 跟踪但在仓库中且需要部署的）
ALWAYS_INCLUDE = [
    ".deploy-write-probe",
]

# 服务器本地文件 —— 不会被打包部署
SERVER_LOCAL_FILES = {
    "main.py", "routers/", "var/", "uploads/",
    ".env", ".env.*",
}


def require_env() -> None:
    """检查必需环境变量。"""
    missing = []
    for name in ("MCSM_PANEL_URL", "MCSM_API_KEY", "MCSM_DAEMON_ID", "MCSM_INSTANCE_UUID"):
        if not os.environ.get(name, "").strip():
            missing.append(name)
    if missing:
        print(f"❌ 缺少必需环境变量: {', '.join(missing)}", file=sys.stderr)
        print("  请设置后重试。", file=sys.stderr)
        sys.exit(1)


def ensure_requests() -> None:
    """确保 requests 可用；如未安装则尝试自动安装。"""
    try:
        import requests  # noqa: F401
    except ImportError:
        print("📦 安装 requests …", file=sys.stderr)
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "requests"],
            stdout=sys.stderr,
            stderr=sys.stderr,
        )


# 在模块顶层完成检查
require_env()
ensure_requests()

import requests


# ---------------------------------------------------------------------------
# API 客户端
# ---------------------------------------------------------------------------

class MCSMError(Exception):
    """MCSManager API 错误。"""
    def __init__(self, status_code: int, url: str, detail: str) -> None:
        self.status_code = status_code
        self.url = url
        self.detail = detail
        super().__init__(f"HTTP {status_code}: {detail}")


class MCSMClient:
    """MCSManager v10 REST API 轻量客户端。"""

    def __init__(self, base_url: str, api_key: str) -> None:
        self.base_url = base_url
        self.api_key = api_key
        self.session = requests.Session()
        self.session.headers.setdefault("Content-Type", "application/json; charset=utf-8")
        self.session.headers.setdefault("X-Requested-With", "XMLHttpRequest")

    def _url(self, path: str, **params: str) -> str:
        """构建完整 URL，自动附带 apikey。"""
        qs = {"apikey": self.api_key}
        qs.update(params)
        pairs = "&".join(f"{k}={v}" for k, v in qs.items() if v)
        sep = "&" if "?" in path else "?"
        return urljoin(self.base_url, f"{path}{sep}{pairs}")

    def _get(self, path: str, **params: str) -> dict:
        r = self.session.get(self._url(path, **params))
        return self._handle(r)

    def _post(self, path: str, body: dict | None = None, **params: str) -> dict:
        kwargs = {"json": body} if body is not None else {}
        r = self.session.post(self._url(path, **params), **kwargs)
        return self._handle(r)

    def _put(self, path: str, body: dict | None = None, **params: str) -> dict:
        kwargs = {"json": body} if body is not None else {}
        r = self.session.put(self._url(path, **params), **kwargs)
        return self._handle(r)

    @staticmethod
    def _api_ok(resp: dict) -> bool:
        """MCS JSON 响应体 status==200 视为成功（与 HTTP 状态码独立）。"""
        if not isinstance(resp, dict):
            return False
        status = resp.get("status")
        return status is None or status == 200

    @staticmethod
    def _handle(r: requests.Response) -> dict:
        """统一处理响应；校验 JSON status，避免 HTTP 500 包成功体却被当成失败/成功混淆。"""
        try:
            payload = r.json()
        except ValueError:
            payload = {"_raw_status": r.status_code, "_raw_text": r.text}
        if isinstance(payload, dict) and payload.get("status") not in (None, 200):
            detail = payload.get("data", payload)
            raise MCSMError(r.status_code, r.url, str(detail))
        if r.ok:
            return payload
        if r.status_code == 500 and isinstance(payload, dict):
            return payload
        try:
            detail = payload if isinstance(payload, dict) else r.text[:2000]
        except Exception:
            detail = r.text[:2000]
        raise MCSMError(r.status_code, r.url, str(detail))

    def _delete(self, path: str, body: dict | None = None, **params: str) -> dict:
        kwargs = {"json": body} if body is not None else {}
        r = self.session.delete(self._url(path, **params), **kwargs)
        return self._handle(r)

    # ---- 工具方法 ----

    def ping(self) -> bool:
        """验证面板连通性与 API 密钥。"""
        try:
            self._get("api/overview")
            return True
        except MCSMError as e:
            print(f"❌ 面板连接失败: {e}", file=sys.stderr)
            return False

    def list_instances(self) -> list[dict]:
        """列出当前 daemon 下的所有实例。"""
        # 尝试 1: api/instance?daemonId=X
        try:
            data = self._get("api/instance", daemonId=DAEMON_ID)
        except MCSMError:
            data = {}
        items = data.get("data", [])
        if isinstance(items, list):
            return items
        if isinstance(items, dict):
            return [items]

        # 尝试 2: 远程服务实例列表
        try:
            data = self._get("api/service/remote_service_instances", daemonId=DAEMON_ID)
        except MCSMError:
            return []
        items = data.get("data", [])
        if isinstance(items, list):
            return items
        if isinstance(items, dict):
            return [items]
        return []

    def find_instance(self) -> dict | None:
        """查找目标实例。先尝试直接获取，再走列表查询。"""
        # MCSM v10: 直接通过 uuid 获取实例信息
        try:
            data = self._get("api/instance", daemonId=DAEMON_ID, uuid=INSTANCE_UUID)
            inst = data.get("data", data)
            if isinstance(inst, dict) and (inst.get("instanceUuid") or inst.get("uuid")):
                return inst
        except MCSMError:
            pass  # 直接查询失败，走列表回退

        # 回退：遍历所有实例
        for inst in self.list_instances():
            if inst.get("instanceUuid") == INSTANCE_UUID or inst.get("uuid") == INSTANCE_UUID:
                return inst
        return None

    # ---- 文件操作 ----

    def request_upload(self, upload_dir: str | None = None) -> dict:
        """请求上传配置（第一步），返回 {password, addr}。

        此版本 MCSM 的 validator 要求所有参数均为 query 参数。
        """
        target_dir = (upload_dir or UPLOAD_DIR).rstrip("/") or "/"
        resp = self._post(
            "api/files/upload",
            body=None,
            daemonId=DAEMON_ID,
            uuid=INSTANCE_UUID,
            upload_dir=target_dir,
        )
        # 兼容嵌套与平铺两种响应格式
        cfg = resp.get("data", resp)
        if "addr" not in cfg or "password" not in cfg:
            print(f"❌ 上传配置响应格式异常: {json.dumps(resp, ensure_ascii=False)[:500]}", file=sys.stderr)
            sys.exit(2)
        return cfg

    def _daemon_upload_url(self, upload_config: dict) -> str:
        """把 daemon 返回的 addr 解析成可从外网访问的 upload URL。"""
        addr: str = upload_config.get("addr", "")
        password: str = upload_config.get("password", "")
        if not addr or not password:
            raise MCSMError(0, "upload", f"缺失 addr/password: {upload_config}")

        if "://" in addr:
            protocol = "https" if addr.startswith("https://") else "http"
            host_port = addr.split("://", 1)[1]
        else:
            protocol = "http"
            host_port = addr

        panel_host = PANEL_URL.split("://", 1)[1].split("/")[0]
        daemon_host, _, daemon_port = host_port.partition(":")
        if daemon_host in ("localhost", "127.0.0.1", "0.0.0.0"):
            panel_host_no_port = panel_host.split(":")[0]
            host_port = f"{panel_host_no_port}:{daemon_port}" if daemon_port else panel_host_no_port
            print(f"   🔧 daemon addr 是 {addr}，已替换为面板的 IP:PORT")

        return f"{protocol}://{host_port}/upload/{password}"

    def upload_file(
        self,
        file_path: str,
        *,
        remote_name: str,
        upload_dir: str | None = None,
        content_type: str = "application/zip",
        timeout: int | None = None,
        retries: int | None = None,
    ) -> bool:
        """上传本地文件到 daemon（可重试）；remote_name 为落到 upload_dir 下的 basename。"""
        attempts = retries if retries is not None else UPLOAD_RETRIES
        wait_s = timeout if timeout is not None else UPLOAD_TIMEOUT
        target_dir = (upload_dir or UPLOAD_DIR).rstrip("/") or "/"
        size_mb = Path(file_path).stat().st_size / (1024 * 1024)

        for attempt in range(1, attempts + 1):
            try:
                upload_config = self.request_upload(target_dir)
                upload_url = self._daemon_upload_url(upload_config)
                with open(file_path, "rb") as fh:
                    r = requests.post(
                        upload_url,
                        files={"file": (remote_name, fh, content_type)},
                        timeout=wait_s,
                    )
                if r.status_code in (200, 201, 204):
                    print(
                        f"✅ 已上传: {remote_name} → {target_dir}/ "
                        f"({size_mb:.2f} MiB, try {attempt}/{attempts})"
                    )
                    return True
                print(
                    f"⚠️  上传失败 HTTP {r.status_code} (try {attempt}/{attempts}): "
                    f"{r.text[:200]}",
                    file=sys.stderr,
                )
            except requests.RequestException as exc:
                print(
                    f"⚠️  上传异常 (try {attempt}/{attempts}): {exc}",
                    file=sys.stderr,
                )
            if attempt < attempts:
                time.sleep(min(8, attempt * 2))

        print(f"❌ 文件上传失败: {remote_name} → {target_dir}/", file=sys.stderr)
        return False

    def decompress(self, archive_path: str, target_dir: str) -> dict:
        """在服务器上解压 zip（type=2）；archive_path 须为实例内绝对路径。"""
        resp = self._post("api/files/compress", body={
            "type": 2,
            "source": archive_path,
            "targets": target_dir,
            "code": "utf-8",
        }, daemonId=DAEMON_ID, uuid=INSTANCE_UUID)
        if not self._api_ok(resp):
            raise MCSMError(0, "api/files/compress", str(resp.get("data", resp)))
        return resp

    def delete_file(self, file_path: str) -> dict:
        """删除服务器上的文件。"""
        # delete 的 targets 是数组，需放在 body 中
        return self._delete("api/files", body={
            "targets": [file_path],
        }, daemonId=DAEMON_ID, uuid=INSTANCE_UUID)

    def delete_files(self, paths: list[str]) -> dict:
        """批量删除服务器上的文件。"""
        if not paths:
            return {}
        return self._delete("api/files", body={
            "targets": paths,
        }, daemonId=DAEMON_ID, uuid=INSTANCE_UUID)

    def read_text_file(self, file_path: str) -> str | None:
        """读取实例上的文本文件（PUT /api/files，见官方文件管理 API）。"""
        try:
            data = self._put("api/files", body={"target": file_path},
                             daemonId=DAEMON_ID, uuid=INSTANCE_UUID)
            if not self._api_ok(data):
                return None
            content = data.get("data", data.get("content", ""))
            return content if isinstance(content, str) else None
        except MCSMError:
            return None

    def list_files(self, directory: str = "/") -> list[dict]:
        """列出实例目录下的文件。"""
        data = self._get(
            "api/files/list",
            daemonId=DAEMON_ID,
            uuid=INSTANCE_UUID,
            target=directory,
            page="0",
            page_size="100",
        )
        payload = data.get("data", {})
        if isinstance(payload, dict):
            return payload.get("items", [])
        return payload if isinstance(payload, list) else []

    # ---- 实例操作 ----

    def restart_instance(self) -> dict:
        """重启实例。"""
        print("🔄 正在重启实例 …")
        # MCSM v10 的 restart 是 POST
        return self._post(
            "api/protected_instance/restart",
            daemonId=DAEMON_ID,
            uuid=INSTANCE_UUID,
        )

    def send_command(self, command: str) -> dict:
        """向实例控制台发送命令。"""
        return self._post("api/protected_instance/command", body={
            "command": command,
        }, daemonId=DAEMON_ID, uuid=INSTANCE_UUID)


# ---------------------------------------------------------------------------
# 打包
# ---------------------------------------------------------------------------

MANIFEST_FILE = ".deploy-files.json"


def collect_deploy_files() -> list[str]:
    """收集 git 跟踪且非服务器本地的部署文件列表。"""
    result = subprocess.run(
        ["git", "-C", str(APP_ROOT), "ls-files", "-z"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print("❌ 无法获取 git 文件列表，请在 git 仓库中运行。", file=sys.stderr)
        sys.exit(1)

    tracked = [f for f in result.stdout.split("\0") if f]

    def _should_skip(rel: str) -> bool:
        parts = Path(rel).parts
        for part in parts:
            if part in SERVER_LOCAL_FILES:
                return True
        for local in SERVER_LOCAL_FILES:
            if rel.startswith(local.rstrip("/") + "/") or rel == local.rstrip("/"):
                return True
        return False

    deploy_files = [f for f in tracked if not _should_skip(f)] + [
        f for f in ALWAYS_INCLUDE if (APP_ROOT / f).exists()
    ]
    return sorted(set(deploy_files))


def _write_zip(members: list[str], *, include_manifest: list[str] | None = None) -> Path:
    """把 members（相对 APP_ROOT）打成临时 zip；可选写入全量 manifest。"""
    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    zip_path = Path(tmp.name)
    tmp.close()
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel in members:
            abs_path = APP_ROOT / rel
            if not abs_path.exists():
                continue
            zf.write(abs_path, rel)
        if include_manifest is not None:
            zf.writestr(
                MANIFEST_FILE,
                json.dumps(include_manifest, ensure_ascii=False, indent=2),
            )
    return zip_path


def build_upload_plan(deploy_files: list[str]) -> tuple[list[Path], list[str]]:
    """拆成「小 zip 分包」+「过大单文件直传」。

    返回 (zip_paths, large_rel_paths)。超过 MCSM_MAX_PART_BYTES 的单文件不进 zip，
    改为直传到 UPLOAD_DIR 下对应子目录（避免整包 20MB+ 被 daemon 掐断）。
    """
    large: list[str] = []
    small: list[str] = []
    for rel in deploy_files:
        abs_path = APP_ROOT / rel
        if not abs_path.is_file():
            continue
        size = abs_path.stat().st_size
        if size > MAX_PART_BYTES:
            large.append(rel)
        else:
            small.append(rel)

    parts: list[Path] = []
    batch: list[str] = []
    batch_raw = 0
    # 未压缩体积作粗估；已压缩媒体压缩率低，用 1.0；源码用 0.45
    def _est(rel: str, raw: int) -> int:
        ext = Path(rel).suffix.lower()
        if ext in {".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp3", ".wav", ".ogg", ".m4a", ".zip"}:
            return raw
        return max(256, int(raw * 0.45))

    def flush_batch() -> None:
        nonlocal batch, batch_raw
        if not batch:
            return
        # 首包写入全量 manifest，便于下次清理
        include = deploy_files if not parts else None
        parts.append(_write_zip(batch, include_manifest=include))
        batch = []
        batch_raw = 0

    for rel in small:
        raw = (APP_ROOT / rel).stat().st_size
        est = _est(rel, raw)
        if batch and batch_raw + est > MAX_PART_BYTES:
            flush_batch()
        batch.append(rel)
        batch_raw += est
        # 单文件估得已经很大时立刻落盘，避免超限
        if batch_raw >= MAX_PART_BYTES:
            flush_batch()
    flush_batch()

    # 若没有任何小文件但有大文件，仍写一个只含 manifest 的空包
    if not parts and large:
        parts.append(_write_zip([], include_manifest=deploy_files))

    total = sum(p.stat().st_size for p in parts)
    print(
        f"📦 分包完成: {len(deploy_files)} 个文件 → {len(parts)} 个 zip "
        f"({total / 1024:.1f} KiB) + {len(large)} 个大文件直传 "
        f"(上限 {MAX_PART_BYTES / 1024 / 1024:.2f} MiB)"
    )
    for i, p in enumerate(parts, 1):
        print(f"   · part {i}: {p.stat().st_size / 1024:.1f} KiB")
    for rel in large:
        print(f"   · direct: {rel} ({(APP_ROOT / rel).stat().st_size / 1024 / 1024:.2f} MiB)")
    return parts, large


def build_archive() -> tuple[Path, list[str]]:
    """兼容旧调用：打成单包（仅用于调试）。"""
    deploy_files = collect_deploy_files()
    zip_path = _write_zip(deploy_files, include_manifest=deploy_files)
    size_kb = zip_path.stat().st_size / 1024
    print(f"📦 打包完成: {len(deploy_files) + 1} 个条目 → {zip_path.name} ({size_kb:.1f} KB)")
    return zip_path, deploy_files


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def main() -> None:
    print(f"🚀 Potatoblock CD 部署")
    if DRY_RUN:
        print(f"   ⚠️  试运行模式 —— 不会实际部署")

    client = MCSMClient(PANEL_URL, API_KEY)

    # 1. 验证连接
    print("\n🔍 验证面板连接 …")
    if not client.ping():
        print("❌ 无法连接面板，请检查 MCSM_PANEL_URL 和 MCSM_API_KEY。", file=sys.stderr)
        sys.exit(1)
    print("✅ 面板连接成功")

    # 2. 验证实例
    print("\n🔍 查找目标实例 …")
    inst = client.find_instance()
    if inst is None:
        instances = client.list_instances()
        print(f"❌ 未找到实例 {INSTANCE_UUID}", file=sys.stderr)
        print(f"   当前 daemon 下的实例:", file=sys.stderr)
        for i in instances:
            iid = i.get("instanceUuid") or i.get("uuid", "?")
            iname = i.get("config", {}).get("nickname", i.get("name", "?"))
            print(f"     - {iid[:16]}…  {iname}", file=sys.stderr)
        sys.exit(1)
    inst_name = (
        inst.get("config", {}).get("nickname")
        or inst.get("name", "?")
    )
    print(f"✅ 找到实例: {inst_name}")

    if DRY_RUN:
        print("\n✅ 连接与参数校验通过（试运行）。")
        return

    # 3. 打包（分包 + 大文件直传列表）
    print("\n📦 打包项目文件 …")
    deploy_files = collect_deploy_files()
    part_zips, large_files = build_upload_plan(deploy_files)

    try:
        # 4. 读取旧 manifest，清理已从仓库删除的文件
        old_manifest_path = f"{UPLOAD_DIR.rstrip('/')}/{MANIFEST_FILE}"
        print(f"\n🔍 检查上次部署的文件清单 …")
        old_raw = client.read_text_file(old_manifest_path)
        if old_raw:
            try:
                old_files: list[str] = json.loads(old_raw)
                removed = [f for f in old_files if f not in deploy_files and f != MANIFEST_FILE]
                if removed:
                    print(f"   🧹 清理 {len(removed)} 个已删除的文件 …")
                    client.delete_files([f"{UPLOAD_DIR.rstrip('/')}/{f}" for f in removed])
                    print(f"   ✅ 已清理")
                else:
                    print(f"   ✅ 无已删除文件")
            except (json.JSONDecodeError, TypeError):
                print(f"   ⚠️  清单解析失败，跳过清理")
        else:
            print(f"   ℹ️  首次部署，无需清理")

        # 5–7. 逐包上传并解压
        print("\n📤 分包上传到 daemon …")
        for index, archive_path in enumerate(part_zips, 1):
            remote_name = (
                DEPLOY_ARCHIVE
                if len(part_zips) == 1
                else f"__deploy_part_{index:02d}__.zip"
            )
            print(f"\n—— part {index}/{len(part_zips)}: {remote_name} ——")
            ok = client.upload_file(str(archive_path), remote_name=remote_name)
            if not ok:
                print("❌ 上传失败，终止部署。", file=sys.stderr)
                sys.exit(1)
            remote_zip = f"{UPLOAD_DIR.rstrip('/')}/{remote_name}"
            print(f"📂 解压 {remote_zip} → {UPLOAD_DIR} …")
            try:
                client.decompress(remote_zip, UPLOAD_DIR)
            except MCSMError as e:
                print(f"❌ 解压失败: {e}", file=sys.stderr)
                try:
                    client.delete_file(remote_zip)
                except Exception:
                    pass
                sys.exit(2)
            try:
                client.delete_file(remote_zip)
                print(f"✅ 已删除 {remote_name}")
            except Exception:
                print(f"⚠️  清理 {remote_name} 失败（可忽略）")

        # 5b. 超限单文件直传到目标子目录（音频等）
        if large_files:
            print(f"\n📤 大文件直传（{len(large_files)}）…")
        for rel in large_files:
            abs_path = APP_ROOT / rel
            parent = str(Path(rel).parent).replace("\\", "/")
            if parent in (".", ""):
                target_dir = UPLOAD_DIR.rstrip("/") or "/"
            else:
                target_dir = f"{UPLOAD_DIR.rstrip('/')}/{parent}"
            remote_name = Path(rel).name
            # 大文件给更长超时
            timeout = max(UPLOAD_TIMEOUT, 300)
            print(f"\n—— direct: {rel} → {target_dir}/{remote_name} ——")
            ok = client.upload_file(
                str(abs_path),
                remote_name=remote_name,
                upload_dir=target_dir,
                content_type="application/octet-stream",
                timeout=timeout,
                retries=max(UPLOAD_RETRIES, 5),
            )
            if not ok:
                print("❌ 大文件上传失败，终止部署。", file=sys.stderr)
                sys.exit(1)

        print("\n✅ 全部上传完成")

        # 7.5 部署后校验：确认 PWA 模板已写入实例
        print("\n🔍 校验部署结果 …")
        probe_path = f"{UPLOAD_DIR.rstrip('/')}/templates/index.html"
        probe_text = client.read_text_file(probe_path)
        if not probe_text:
            print(f"❌ 校验失败：无法读取 {probe_path}", file=sys.stderr)
            sys.exit(2)
        # 用稳定 DOM id，避免文案改版（如「安装应用（PWA）」→「安装应用」）误杀部署。
        if 'id="pwaInstallButton"' not in probe_text and "id='pwaInstallButton'" not in probe_text:
            print(
                f"❌ 校验失败：{probe_path} 未包含 PWA 安装按钮。"
                " 请确认 MCSM_INSTANCE_UUID / MCSM_UPLOAD_DIR 指向 game.potatoblock.com 所在实例。",
                file=sys.stderr,
            )
            sys.exit(2)
        print("✅ PWA 模板校验通过")

        # 9. 重启实例
        print("")
        try:
            client.restart_instance()
            print("✅ 重启指令已发送")
        except MCSMError as e:
            print(f"❌ 重启失败: {e}", file=sys.stderr)
            print("⚠️  文件已上传解压，但实例未重启。请手动重启。", file=sys.stderr)
            sys.exit(2)

    finally:
        # 清理本地临时 zip
        for archive_path in part_zips:
            archive_path.unlink(missing_ok=True)

    print("\n🎉 部署完成！")


if __name__ == "__main__":
    main()
