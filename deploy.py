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
  MCSM_DEPLOY_ARCHIVE 上传的 zip 文件名，默认 __deploy_package__.zip
  MCSM_DRY_RUN        设为 1 仅校验连接与参数，不实际部署

用法:
  python deploy.py          # 直接部署
  MCSM_DRY_RUN=1 python deploy.py  # 仅检查连接
"""

from __future__ import annotations

import os
import sys
import json
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

    def _delete(self, path: str, body: dict | None = None, **params: str) -> dict:
        kwargs = {"json": body} if body is not None else {}
        r = self.session.delete(self._url(path, **params), **kwargs)
        return self._handle(r)

    @staticmethod
    def _handle(r: requests.Response) -> dict:
        """统一处理响应；非 2xx 抛出 MCSMError（500 除外，部分接口返回 500 但实际成功）。"""
        if r.ok:
            try:
                return r.json()
            except ValueError:
                return {"_raw_status": r.status_code, "_raw_text": r.text}
        if r.status_code == 500:
            try:
                return r.json()
            except ValueError:
                return {"_raw_status": 500, "_raw_text": r.text}
        # 非 500 错误 → 抛异常
        try:
            detail = r.json()
        except Exception:
            detail = r.text[:2000]
        raise MCSMError(r.status_code, r.url, str(detail))

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

    def request_upload(self) -> dict:
        """请求上传配置（第一步），返回 {password, addr}。

        此版本 MCSM 的 validator 要求所有参数均为 query 参数。
        """
        resp = self._post("api/files/upload", body=None,
                          daemonId=DAEMON_ID, uuid=INSTANCE_UUID, upload_dir=UPLOAD_DIR)
        # 兼容嵌套与平铺两种响应格式
        cfg = resp.get("data", resp)
        if "addr" not in cfg or "password" not in cfg:
            print(f"❌ 上传配置响应格式异常: {json.dumps(resp, ensure_ascii=False)[:500]}", file=sys.stderr)
            sys.exit(2)
        return cfg

    def upload_file(self, file_path: str, upload_config: dict) -> bool:
        """将本地文件上传到 daemon（第二步）。

        若 daemon 返回的 addr 是 localhost/127.0.0.1，自动替换为面板的公网地址。
        """
        addr: str = upload_config.get("addr", "")
        password: str = upload_config.get("password", "")

        if not addr or not password:
            print(f"❌ 上传配置缺失 addr 或 password: {upload_config}", file=sys.stderr)
            return False

        # 分离协议与 host:port；addr 通常为 host:port（如 localhost:24444）
        if "://" in addr:
            protocol = "https" if addr.startswith("https://") else "http"
            host_port = addr.split("://", 1)[1]
        else:
            protocol = "http"
            host_port = addr

        # 如果 daemon 返回 localhost，替换为面板 host
        panel_host = PANEL_URL.split("://", 1)[1].split("/")[0]  # 例: example.com:23333
        daemon_host, _, daemon_port = host_port.partition(":")
        if daemon_host in ("localhost", "127.0.0.1", "0.0.0.0"):
            # 保留原端口，host 从面板地址取
            panel_host_no_port = panel_host.split(":")[0]
            host_port = f"{panel_host_no_port}:{daemon_port}" if daemon_port else panel_host_no_port
            print(f"   🔧 daemon addr 是 {addr}，已替换为 {host_port}")

        upload_url = f"{protocol}://{host_port}/upload/{password}"

        with open(file_path, "rb") as fh:
            # MCSM daemon 的上传接口接受 multipart
            r = requests.post(
                upload_url,
                files={"file": (Path(file_path).name, fh, "application/zip")},
            )
        if r.status_code not in (200, 201, 204):
            print(f"❌ 文件上传失败 HTTP {r.status_code}: {r.text[:500]}", file=sys.stderr)
            return False
        print(f"✅ 文件已上传: {Path(file_path).name}")
        return True

    def decompress(self, archive_path: str, target_dir: str) -> dict:
        """在服务器上解压 zip 文件（覆盖已有文件）。"""
        return self._post("api/files/compress", body=None,
                          daemonId=DAEMON_ID, uuid=INSTANCE_UUID,
                          type="2", source=archive_path, targets=target_dir, code="utf-8")

    def delete_file(self, file_path: str) -> dict:
        """删除服务器上的文件。"""
        # delete 的 targets 是数组，需放在 body 中
        return self._delete("api/files", body={
            "targets": [file_path],
        }, daemonId=DAEMON_ID, uuid=INSTANCE_UUID)

    def list_files(self, directory: str = "/") -> list[dict]:
        """列出实例目录下的文件。"""
        data = self._get(
            "api/files/list",
            daemonId=DAEMON_ID,
            uuid=INSTANCE_UUID,
            target=directory,
        )
        return data.get("data", [])

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

def build_archive() -> Path:
    """将 git 跟踪的文件打成 zip，返回临时文件路径。

    排除 .gitignore 中的文件和服务器本地文件。
    """
    # 获取 git 跟踪的文件列表
    result = subprocess.run(
        ["git", "-C", str(APP_ROOT), "ls-files", "-z"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print("❌ 无法获取 git 文件列表，请在 git 仓库中运行。", file=sys.stderr)
        sys.exit(1)

    tracked = [f for f in result.stdout.split("\0") if f]

    # 过滤服务器本地文件
    def _should_skip(rel: str) -> bool:
        parts = Path(rel).parts
        for part in parts:
            if part in SERVER_LOCAL_FILES:
                return True
        # 检查路径前缀
        for local in SERVER_LOCAL_FILES:
            if rel.startswith(local.rstrip("/") + "/") or rel == local.rstrip("/"):
                return True
        return False

    deploy_files = [f for f in tracked if not _should_skip(f)] + [
        f for f in ALWAYS_INCLUDE if (APP_ROOT / f).exists()
    ]

    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    zip_path = Path(tmp.name)
    tmp.close()

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel in sorted(set(deploy_files)):
            abs_path = APP_ROOT / rel
            if not abs_path.exists():
                continue
            zf.write(abs_path, rel)

    size_kb = zip_path.stat().st_size / 1024
    print(f"📦 打包完成: {len(deploy_files)} 个文件 → {zip_path.name} ({size_kb:.1f} KB)")
    return zip_path


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def main() -> None:
    print(f"🚀 Potatoblock CD 部署")
    print(f"   面板: {PANEL_URL}")
    print(f"   目标: daemon={DAEMON_ID[:8]}… instance={INSTANCE_UUID[:8]}…")
    print(f"   目录: {UPLOAD_DIR}")
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

    # 3. 打包
    print("\n📦 打包项目文件 …")
    archive_path = build_archive()

    try:
        # 4. 请求上传 URL
        print("\n📤 请求上传配置 …")
        try:
            upload_cfg = client.request_upload()
        except MCSMError as e:
            print(f"❌ 获取上传令牌失败: {e}", file=sys.stderr)
            sys.exit(2)
        print(f"   获取到上传令牌: addr={upload_cfg.get('addr', '?')}")

        # 5. 上传文件
        print("\n📤 上传文件到 daemon …")
        ok = client.upload_file(str(archive_path), upload_cfg)
        if not ok:
            print("❌ 上传失败，终止部署。", file=sys.stderr)
            sys.exit(1)

        # 远端 zip 路径
        remote_zip = f"{UPLOAD_DIR.rstrip('/')}/{DEPLOY_ARCHIVE}"

        # 6. 解压（覆盖已有文件）
        print(f"\n📂 解压文件到 {UPLOAD_DIR} …")
        try:
            client.decompress(remote_zip, UPLOAD_DIR)
        except MCSMError as e:
            print(f"❌ 解压失败: {e}", file=sys.stderr)
            # 尝试清理远端 zip
            try:
                client.delete_file(remote_zip)
            except Exception:
                pass
            sys.exit(2)
        print("✅ 文件解压完成")

        # 7. 清理远端 zip
        print("\n🧹 清理远端临时文件 …")
        try:
            client.delete_file(remote_zip)
            print(f"✅ 已删除 {DEPLOY_ARCHIVE}")
        except (MCSMError, Exception):
            print(f"⚠️  无法删除远端 zip（可能已自动清理）")

        # 8. 重启实例
        print("")
        try:
            client.restart_instance()
            print("✅ 重启指令已发送")
        except MCSMError as e:
            print(f"❌ 重启失败: {e}", file=sys.stderr)
            print("⚠️  文件已上传解压，但实例未重启。请手动重启。", file=sys.stderr)
            sys.exit(2)

    finally:
        # 清理本地临时文件
        archive_path.unlink(missing_ok=True)

    print(f"\n🎉 部署完成！")


if __name__ == "__main__":
    main()
