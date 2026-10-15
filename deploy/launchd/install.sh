#!/usr/bin/env bash
# local worker を launchd の LaunchAgent として入れる（入れ直しも同じ）。手順は src/worker/README.md
set -euo pipefail

label=dev.wwwyo.agent-calendar.worker
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
bun=$(mise which bun 2>/dev/null || command -v bun)
dest="$HOME/Library/LaunchAgents/$label.plist"

if [[ ! -f "$HOME/.config/agent-calendar/local.toml" ]]; then
  echo "~/.config/agent-calendar/local.toml がない。src/worker/README.md の例から作る" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
sed -e "s|__BUN__|$bun|g" -e "s|__REPO__|$repo|g" -e "s|__HOME__|$HOME|g" -e "s|__PATH__|$PATH|g" \
  "$here/$label.plist" >"$dest"

launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$dest"
echo "installed: $dest（ログは ~/Library/Logs/agent-calendar-worker.log）"
