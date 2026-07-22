# Potatoblock-Game

镜像线上实例的 Python 包目录（MCS 路径 `/app`）。

- 日常发布：本地 `push-github.py` 一次推送
- 服务器：`git pull --ff-only` 增量更新（见 `auto_update.py`）
- 未纳入本仓库的文件（`main.py`、`routers/`、`var/` 等）保留在服务器本地
- **CD 流水线**：push 到 `main` 分支自动部署到 MCSManager（见下方）
- **音效授权**：[THIRD_PARTY_AUDIO.md](./THIRD_PARTY_AUDIO.md)（游戏音效均为 CC0）

---

## CD 流水线

`.github/workflows/deploy.yml` 在 `main` 分支有推送时，自动将项目文件打包上传到 MCSManager 实例并重启。

### 前置准备

1. **获取 API 密钥**：MCSManager 面板 → 用户管理 → API 密钥
2. **获取实例信息**：面板 → 实例详情 → 复制「守护进程 ID」和「实例 UUID」
3. **配置 GitHub Secrets**（仓库 Settings → Secrets and variables → Actions）：

**必填 Secrets：**

| Secret | 说明 |
| --- | --- |
| `MCSM_PANEL_URL` | 面板地址，如 `http://10.0.0.1:23333` |
| `MCSM_API_KEY` | API 密钥 |
| `MCSM_DAEMON_ID` | 守护进程 UUID |
| `MCSM_INSTANCE_UUID` | 实例 UUID |

**可选 Variables：**

| Variable | 默认值 | 说明 |
| --- | --- | --- |
| `MCSM_UPLOAD_DIR` | `/app` | 上传目标目录 |

### 内网部署

如果 MCSManager 面板位于内网，GitHub Actions 无法直接访问，有两种方案：

- **使用 Self-hosted Runner**：将 `runs-on: ubuntu-latest` 改为 `runs-on: self-hosted`，在内网机器上运行 runner
- **手动部署**：在能访问面板的机器上执行 `python deploy.py`

### 手动部署

```bash
# 设置环境变量后直接运行
export MCSM_PANEL_URL="http://your-panel:23333"
export MCSM_API_KEY="your-api-key"
export MCSM_DAEMON_ID="your-daemon-id"
export MCSM_INSTANCE_UUID="your-instance-uuid"
python deploy.py

# 仅检查连接（不实际部署）
MCSM_DRY_RUN=1 python deploy.py
```

### 部署流程

1. `git ls-files` 获取仓库跟踪文件，排除服务器本地文件（`var/`、`.env` 等）
2. 打包为 zip
3. 通过 MCSManager API 上传到实例
4. 在服务器上解压覆盖
5. 清理临时文件
6. 重启实例
