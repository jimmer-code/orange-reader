#!/usr/bin/env bash
# 书边译「课程」板块同步入口：加锁 → 读 token → 跑 sync.py → 日志追加。
#
#   bash run.sh --from-fixtures DIR --dry-run   # 无 token 开发/验收
#   bash run.sh                                 # 真实模式增量（需要 600 环境文件）
#   bash run.sh --full                          # 真实模式全量
#   bash run.sh --publish                       # 构建后发布（config.publish.enabled + KB_REMOTE_DIR）
#
# 环境变量：
#   PYTHON         Python 解释器（默认 ~/.venvs/main/bin/python）
#   KB_ENV_FILE    token/发布环境文件（默认 ~/.config/shubian-kb/env，600，不进 Git）
# 退出码：0 成功；非 0 失败/被锁/鉴权失败。token 不会打印到日志。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${PYTHON:-$HOME/.venvs/main/bin/python}"
KB_ENV_FILE="${KB_ENV_FILE:-$HOME/.config/shubian-kb/env}"

mkdir -p "$HERE/logs" "$HERE/state"
LOG="$HERE/logs/sync.log"
LOCK="$HERE/state/.run.lock"

# 真实模式才读 token 文件；fixture 模式也允许没有该文件
if [[ -f "$KB_ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$KB_ENV_FILE"
  set +a
fi

# 加锁：macOS 没有 flock；优先 flock，其次 shlock（两者都没有就依赖 sync.py 里的 fcntl）
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK"
  if ! flock -n 9; then
    echo "[run] 已有同步在跑（flock），退出" >&2
    exit 75
  fi
elif command -v shlock >/dev/null 2>&1; then
  if ! shlock -f "$LOCK" -p $$; then
    echo "[run] 已有同步在跑（shlock），退出" >&2
    exit 75
  fi
  trap 'rm -f "$LOCK"' EXIT
fi

if [[ ! -x "$PYTHON" ]]; then
  echo "[run] Python 不存在：$PYTHON（设 PYTHON=/path/to/python）" >&2
  exit 2
fi

{
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') run.sh $*"
} >>"$LOG"

set +e
"$PYTHON" "$HERE/sync.py" "$@" 2>&1 | tee -a "$LOG"
rc=${PIPESTATUS[0]}
set -e

echo "=== $(date '+%Y-%m-%d %H:%M:%S') exit $rc" >>"$LOG"
exit "$rc"
