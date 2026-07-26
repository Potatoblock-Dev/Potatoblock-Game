# Potatoblock Game

[土豆方块](https://game.potatoblock.com) 的线上游戏门户与部署镜像。

玩家在这里登录、选游戏、断线重连；本仓库对应服务器上的应用目录（`/app`），由 CD 推送到 MCSManager。

**游玩：** [game.potatoblock.com](https://game.potatoblock.com)

---

## 现在有什么

| 入口 | 说明 |
|------|------|
| 阈限月台 | 合作多人平台 / 设施向玩法（源码在 [Liminal-Platform](https://github.com/Potatoblock-Dev/Liminal-Platform)） |
| 皮套大厅 | 装扮与大厅 |
| 你画我猜 | 经典你画我猜 |
| 画画接龙 | 轮流接画 |

音效授权见 [THIRD_PARTY_AUDIO.md](./THIRD_PARTY_AUDIO.md)（游戏音效均为 CC0）。

---

## 仓库角色（简要）

```
玩法 SoT（如 Liminal-Platform）──vendor──► 本仓 games/*
本仓 main ──CD──► MCS /app ──► game.potatoblock.com
```

- **本仓**：门户、挂载、整树部署；不把某个游戏的完整开发流程绑死在这里。
- **玩法源仓**：改月台 / 皮套等，先推 SoT，再 vendor 进 `games/`。
- **服务器本地、不进本仓：** `main.py`、`routers/`、`var/`、`.env` 等（实例入口与运行时数据）。

日常开发约定见各游戏目录的 `SOURCE.md`，以及协作侧的 deploy skill。

---

## 维护者：CD 与部署

`main` 有推送时，[`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml) 会跑 `deploy.py`：分包上传到 MCS、解压、重启实例。

### GitHub Secrets

| Secret | 说明 |
|--------|------|
| `MCSM_PANEL_URL` | 面板地址 |
| `MCSM_API_KEY` | API 密钥（面板须 `enableApiKey: true`） |
| `MCSM_DAEMON_ID` | 守护进程 UUID |
| `MCSM_INSTANCE_UUID` | 实例 UUID |

可选 Variables：`MCSM_UPLOAD_DIR`（默认 `/app`）、`MCSM_MAX_PART_BYTES` / `MCSM_UPLOAD_RETRIES` / `MCSM_UPLOAD_TIMEOUT`（大包分包与重试）。

面板 → 用户中心拿 API 密钥；实例详情复制 daemon / instance UUID。

### 手动部署

```bash
export MCSM_PANEL_URL="http://your-panel:23333"
export MCSM_API_KEY="…"
export MCSM_DAEMON_ID="…"
export MCSM_INSTANCE_UUID="…"
python deploy.py

MCSM_DRY_RUN=1 python deploy.py   # 只测连接
```

面板在内网时：用 self-hosted runner，或在能访问面板的机器上跑 `deploy.py`。

大包易被 daemon 掐断时，脚本会按体积分包；超限单文件（多为音频）直传。排障细节以协作文档 / `deploy.py` 注释为准。

### 不要做的事

- 用本地 stub 覆盖已有的 `deploy.py`、`.github/`、合作者维护的说明
- 把服务器独有文件强行塞进仓库
- 在玩法 SoT 尚未更新时，把本仓 `games/liminal_platform` 当唯一编辑面长期改
