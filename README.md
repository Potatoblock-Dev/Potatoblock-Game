# Potatoblock-Game

镜像线上实例的 Python 包目录（MCS 路径 `/app`）。

- 日常发布：本地 `push-github.py` 一次推送
- 服务器：`git pull --ff-only` 增量更新（见 `auto_update.py`）
- 未纳入本仓库的文件（`main.py`、`routers/`、`var/` 等）保留在服务器本地
