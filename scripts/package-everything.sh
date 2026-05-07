#!/usr/bin/env bash
# package-everything.sh — build + deploy everything for local dev:
#   1. env-server → ~/.local/share/cc-env/app/
#   2. opencode plugin → ~/.local/share/cc-env/opencode-plugin/
#   3. desktop Electron app → /Applications/
#   4. restart the launchd service
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
install_dir=${CC_INSTALL_DIR:-"${HOME}/.local/share/cc-env"}

echo "==> building env-server"
(cd "$repo_root/packages/env-server" && npm run build)

echo "==> staging env-server into $install_dir/app"
cp "$repo_root/packages/env-server/dist/main.js"     "$install_dir/app/main.js"
cp "$repo_root/packages/env-server/dist/main.js.map" "$install_dir/app/main.js.map"
cp "$repo_root/packages/env-server/dist/terminal-daemon.js"     "$install_dir/app/terminal-daemon.js"
cp "$repo_root/packages/env-server/dist/terminal-daemon.js.map" "$install_dir/app/terminal-daemon.js.map"
rsync -a --delete "$repo_root/packages/env-server/migrations/" "$install_dir/app/migrations/"
find "$install_dir/app/node_modules/node-pty/prebuilds" -name spawn-helper -type f -exec chmod 755 {} +

echo "==> building opencode plugin"
(cd "$repo_root/packages/opencode-plugin" && npm run build)

echo "==> staging opencode plugin"
cp "$repo_root/packages/opencode-plugin/dist/index.js" "$install_dir/opencode-plugin/index.js"

echo "==> packaging desktop app"
(cd "$repo_root/packages/cloud-code-desktop" && npm run package:mac)

echo "==> restarting cc-env"
launchctl kickstart -k "gui/$(id -u)/com.cloudcode.env"

echo "==> done"
