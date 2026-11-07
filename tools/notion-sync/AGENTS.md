# 书边译 · 课程板块同步（tools/notion-sync）

把 Jimmy 的 Notion 知识库（4 门课、~80 篇文章）同步成书边译 App 能离线阅读的静态内容包：正文 HTML、图片（WebP）、mermaid 预渲染 SVG、索引。属于 `shubian-translate` 项目的一部分，App 端见仓库根 `AGENTS.md` 和 `docs/notion-kb-*.md`。

- 数据流：Notion API（只读 internal connection）→ Mac 本机 `sync.py`（增量）→ `dist/` → rsync 到 jimmy `/var/www/shubian-kb/<secret>/` → `update.lemonation.cloud/shubian-kb/…` → App 第 4 个标签「课程」增量缓存。
- 定时：Mac launchd `com.jimmy.shubian-kb-sync`，每 30 分钟跑 `bash run.sh --publish`。日志 `logs/sync.log`；状态 `state/last-run.json`。
- 凭据：`~/.config/shubian-kb/env`（600，不进 Git）：`NOTION_TOKEN`、`KB_SECRET`、`KB_BASE`、`REMOTE`、`REMOTE_DIR`、可选 `KUMA_PUSH_URL`。**任何 token/secret 不打印、不写仓库、不写 App 源码。**
- 常用命令（在本目录）：
  - `bash run.sh --from-fixtures <dir> --dry-run` 无 token 跑离线样例
  - `bash run.sh --dry-run` 增量构建不发布
  - `bash run.sh --full --publish` 全量构建并发布
  - `python3 verify.py --dist dist` 契约校验（PASS/FAIL）
- 内容口径（2026-11-07 用户确认）：4 门课全收；作业/毕业项目/模板/综合页/待发布占位不进；正文保留「核心要点回顾」「来源」「图注」，去掉开头导语/页眉署名/「状态」段/结尾残句。
- 改动约定：产物字段/HTML 结构改 `docs/notion-kb-contract.md` 并同步 App 端；`config.yaml` 里课程 hub id、排除规则、发布参数；不要手工改 `dist/`（由构建生成）。mermaid 用本机 Chrome + `puppeteer-core`，字体用 App 同一份 Fusion Pixel。
- 回滚：`dist/` 与远端 `releases/` 保留最近 3 个；Caddy 路由在 `~/ops-hub/deploy/fold-ds-updates/Caddyfile`（改动前备份、`caddy validate` 后 reload）。发布前确认用户同意（2026-11-07 的部署已获批准）。

## 运维登记

- ops-hub 项目名：`shubian-kb`（`~/ops-hub/portfolio.yaml`，查看用 `ops info shubian-kb`）。
- 部署机：jimmy（腾讯云 `43.131.233.151`），路径 `/var/www/shubian-kb`；Caddy 域名 `update.lemonation.cloud`，路由 `/shubian-kb/*`。
- 健康检查：`https://update.lemonation.cloud/shubian-kb/<secret>/status.json`（`file.release`/`articles`；`generated_at` 新鲜）。secret 见 `~/.config/shubian-kb/env` 的 `KB_SECRET`/`KB_BASE`，不写进这里。
- 日志：本机 `tools/notion-sync/logs/sync.log`；Caddy `sudo tail -n 100 /var/log/caddy/fold-ds-updates.access.log`。
- 发布脚本：`tools/notion-sync/run.sh`；Caddy 片段：`deploy/notion-kb/Caddyfile.append`。
- 回滚：停 launchd（`launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.jimmy.shubian-kb-sync.plist`）；内容回滚用远端保留的 `index-<ts>.json` 覆盖 `index.json`。
