# Liminal Platform（阈限月台）

本地开发目录。**线上部署以** `app/games/liminal_platform/` **为准**（CD 只同步该包）。

改完本目录后，发布前请同步到部署包：

```bash
rsync -a --delete --exclude '__pycache__' --exclude 'README.md' \
  game/Liminal_Platform/ app/games/liminal_platform/
# 再写入包 __init__.py（见仓库约定）
```

或直接在 `app/games/liminal_platform/` 开发，再回拷到本目录。
