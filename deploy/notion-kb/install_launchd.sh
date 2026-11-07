#!/usr/bin/env bash
# 安装/更新「课程板块」每 30 分钟同步的 launchd 任务。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
LABEL="com.jimmy.shubian-kb-sync"
PLIST_SRC="$HERE/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$REPO/tools/notion-sync/logs"

[[ -f "$PLIST_SRC" ]] || { echo "缺少 $PLIST_SRC" >&2; exit 1; }
[[ -x "$REPO/tools/notion-sync/run.sh" ]] || { echo "缺少可执行的 tools/notion-sync/run.sh" >&2; exit 1; }
[[ -f "$HOME/.config/shubian-kb/env" ]] || { echo "缺少 ~/.config/shubian-kb/env（见 deploy/notion-kb/README.md）" >&2; exit 1; }

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
install -m 0644 "$PLIST_SRC" "$PLIST_DST"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
launchctl enable "gui/$(id -u)/$LABEL"
echo "已安装 ${LABEL}（每 30 分钟一次）。手动跑：bash $REPO/tools/notion-sync/run.sh --full"
