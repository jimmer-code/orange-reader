#!/usr/bin/env bash
set -euo pipefail

APK_PATH="${1:?usage: publish_update.sh APK_PATH VERSION VERSION_CODE NOTES}"
VERSION="${2:?usage: publish_update.sh APK_PATH VERSION VERSION_CODE NOTES}"
VERSION_CODE="${3:?usage: publish_update.sh APK_PATH VERSION VERSION_CODE NOTES}"
NOTES="${4:?usage: publish_update.sh APK_PATH VERSION VERSION_CODE NOTES}"

REMOTE="${SHUBIAN_UPDATE_REMOTE:-ubuntu@43.131.233.151}"
REMOTE_DIR="/var/www/fold-ds-updates/shubian-translate"
DOMAIN="update.lemonation.cloud"

[[ -f "$APK_PATH" ]] || { echo "APK not found: $APK_PATH" >&2; exit 1; }
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]] || { echo "VERSION must be x.y or x.y.z" >&2; exit 1; }
[[ "$VERSION_CODE" =~ ^[1-9][0-9]*$ ]] || { echo "VERSION_CODE must be positive" >&2; exit 1; }

SHA256="$(shasum -a 256 "$APK_PATH" | awk '{print $1}')"
SIZE="$(stat -f '%z' "$APK_PATH")"
APK_NAME="shubian-translate-${VERSION}.apk"
SOURCE_APK_NAME="$(basename "$APK_PATH")"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

python3 - "$TEMP_DIR/latest.json" "$VERSION" "$VERSION_CODE" "$DOMAIN" "$APK_NAME" "$SIZE" "$SHA256" "$NOTES" <<'PY'
import json
import sys
from datetime import datetime, timezone

output, version, version_code, domain, apk_name, size, sha256, notes = sys.argv[1:]
manifest = {
    "version": version,
    "versionCode": int(version_code),
    "apkUrl": f"https://{domain}/shubian-translate/{apk_name}",
    "size": int(size),
    "sha256": sha256,
    "notes": notes,
    "publishedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
}
with open(output, "w", encoding="utf-8") as handle:
    json.dump(manifest, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY

REMOTE_TMP="/tmp/shubian-translate-update-$VERSION_CODE"
ssh "$REMOTE" "rm -rf '$REMOTE_TMP' && mkdir -m 0755 '$REMOTE_TMP'"
scp "$APK_PATH" "$TEMP_DIR/latest.json" "$REMOTE:$REMOTE_TMP/"
ssh "$REMOTE" "sudo install -d -o caddy -g caddy -m 0755 '$REMOTE_DIR' && sudo install -o caddy -g caddy -m 0644 '$REMOTE_TMP/$SOURCE_APK_NAME' '$REMOTE_DIR/$APK_NAME' && sudo install -o caddy -g caddy -m 0644 '$REMOTE_TMP/latest.json' '$REMOTE_DIR/latest.json' && rm -rf '$REMOTE_TMP' && find '$REMOTE_DIR' -maxdepth 1 -type f -name 'shubian-translate-*.apk' -printf '%T@ %p\n' | sort -nr | awk 'NR > 2 {print \$2}' | xargs -r sudo rm -f"

echo "Published 书边译 $VERSION ($VERSION_CODE): https://$DOMAIN/shubian-translate/latest.json"
