# 课程板块部署清单（P1）

同步产物由 `tools/notion-sync` 生成，发布到 jimmy VPS 的 `update.lemonation.cloud/shubian-kb/<secret>/`。

## 1. 生成 secret 与本地配置

```bash
mkdir -p ~/.config/shubian-kb
openssl rand -hex 16          # 记为 <secret>：内容目录名，同时写进 App 的 kb.base
cp deploy/notion-kb/env.example ~/.config/shubian-kb/env
chmod 600 ~/.config/shubian-kb/env
# 编辑 env：填 NOTION_TOKEN（ntn_…，只读 internal connection）和 <secret>
```

`~/.config/shubian-kb/env`（600，不进 Git）：

```
NOTION_TOKEN=ntn_xxx
KB_SECRET=<32 位 hex>
KB_BASE=https://update.lemonation.cloud/shubian-kb/<secret>
REMOTE=ubuntu@43.131.233.151
REMOTE_DIR=/var/www/shubian-kb
KUMA_PUSH_URL=            # 可选：Uptime Kuma push URL
```

App 的 `local.properties` 加（不进 Git）：

```
kb.base=https://update.lemonation.cloud/shubian-kb/<secret>
# kb.token=               # 可选，若 Caddy 加了请求头校验
```

## 2. 服务器目录

```bash
ssh ubuntu@43.131.233.151 'sudo install -d -o ubuntu -g ubuntu -m 0755 /var/www/shubian-kb'
```

## 3. Caddy（改 ops-hub 片段，两处同步）

把 `deploy/notion-kb/Caddyfile.append` 的内容插到 `~/ops-hub/deploy/fold-ds-updates/Caddyfile` 的
`handle { respond "Not Found" 404 }` **之前**，然后：

```bash
# 本地和服务器两处都更新
bash ~/ops-hub/deploy/fold-ds-updates/publish.sh   # 以 ops-hub 实际脚本为准
ssh ubuntu@43.131.233.151 'sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy'
curl -sI https://update.lemonation.cloud/shubian-kb/<secret>/status.json
```

回滚：把片段删掉、发布、validate + reload；`/var/www/shubian-kb` 可保留。

## 4. 首次全量同步 + 发布

```bash
cd ~/workspace/shubian-translate/tools/notion-sync
bash run.sh --full            # 同步 + 构建 + 发布（run.sh 里 source env）
bash run.sh --verify
```

验证：
- `curl -s https://update.lemonation.cloud/shubian-kb/<secret>/status.json`
- 抽查一篇 HTML：无 `notion` 域名、图片 200、mermaid 是 `<svg>`。
- 抽查 media 缓存头：`public, max-age=31536000, immutable`；index：`no-store`。

## 5. launchd 定时任务

```bash
bash deploy/notion-kb/install_launchd.sh
launchctl print gui/$(id -u)/com.jimmy.shubian-kb-sync | head
```

- 每 30 分钟跑一次，日志 `tools/notion-sync/logs/sync.log`。
- 手动补跑：`bash tools/notion-sync/run.sh --full`
- 停：`launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.jimmy.shubian-kb-sync.plist`

## 6. 监控与登记

- Uptime Kuma：push 监控（成功结束 curl `KUMA_PUSH_URL`），30 分钟一次、90 分钟没心跳告警。
- `status.json` 加进 ops-hub 探活；在 `~/ops-hub/portfolio.yaml` 增加 `shubian-kb` 条目（server: tencent、path_remote `/var/www/shubian-kb`、healthz 指 status.json、logs 指 caddy 日志）。
- 改完在 ops-hub 跑 `ops docs` 检查。

## 7. 回滚

1. 内容：`index-<ts>.json` 覆盖 `index.json`（VPS 上一行 mv），App 下一轮同步回到旧版。
2. 同步停摆：`launchctl bootout`，App 继续用本地缓存。
3. 整站：删除 Caddy 片段并 reload；服务器目录保留。
