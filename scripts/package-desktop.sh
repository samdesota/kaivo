#!/usr/bin/env bash
# package-desktop.sh — build a self-contained Cloud Code Desktop.app
#
# Bundles the webapp server, env-server, opencode plugin, and client SPA
# into the Electron app so it runs without the source repo.
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
desktop_dir="$repo_root/packages/cloud-code-desktop"
bundle_dir="$desktop_dir/bundle"
install_app=false

for arg in "$@"; do
  case "$arg" in
    --install)
      install_app=true
      ;;
    *)
      echo "unknown argument: $arg" >&2
      echo "usage: $0 [--install]" >&2
      exit 2
      ;;
  esac
done

echo "==> cleaning bundle dir"
rm -rf "$bundle_dir"
mkdir -p "$bundle_dir/app-server" "$bundle_dir/env-server" "$bundle_dir/opencode-plugin"

echo "==> building client SPA"
(cd "$repo_root" && npx vite build)

echo "==> building app server"
(cd "$repo_root" && npx tsup)

echo "==> staging app server bundle"
cp "$repo_root/dist/server/index.js" "$bundle_dir/app-server/index.js"
cp -R "$repo_root/dist/client" "$bundle_dir/client"

# runtime package.json with only server-side deps
node --input-type=module -e "
  import fs from 'node:fs'
  const src = JSON.parse(fs.readFileSync('${repo_root}/package.json', 'utf8'))
  // only server-side deps — client deps are bundled by vite
  const serverDeps = [
    '@fastify/cookie', '@fastify/static', '@fastify/websocket',
    '@opencode-ai/sdk', '@trpc/server', '@trpc/client',
    'bcrypt', 'better-sqlite3', 'dockerode', 'drizzle-orm',
    'fastify', 'node-pty', 'pino', 'pino-pretty',
    'superjson', 'ulid', 'undici', 'ws', 'zod',
    '@xterm/addon-serialize', '@xterm/headless', '@xterm/xterm',
    'chokidar',
  ]
  const deps = {}
  for (const d of serverDeps) {
    if (src.dependencies[d]) deps[d] = src.dependencies[d]
  }
  const out = {
    name: 'cc-app-server-runtime',
    version: src.version,
    private: true,
    type: 'module',
    dependencies: deps,
  }
  fs.writeFileSync('${bundle_dir}/app-server/package.json', JSON.stringify(out, null, 2) + '\n')
"

echo "==> installing app server dependencies"
(cd "$bundle_dir/app-server" && npm install --omit=dev --no-audit --no-fund --silent)

echo "==> building env-server"
(cd "$repo_root/packages/env-server" && npm run build)

echo "==> staging env-server bundle"
cp "$repo_root/packages/env-server/dist/main.js" "$bundle_dir/env-server/main.js"
cp "$repo_root/packages/env-server/dist/terminal-daemon.js" "$bundle_dir/env-server/terminal-daemon.js"
rsync -a "$repo_root/packages/env-server/migrations/" "$bundle_dir/env-server/migrations/"

node --input-type=module -e "
  import fs from 'node:fs'
  const src = JSON.parse(fs.readFileSync('${repo_root}/packages/env-server/package.json', 'utf8'))
  const out = {
    name: 'cc-env-runtime',
    version: src.version,
    private: true,
    type: 'module',
    dependencies: src.dependencies ?? {},
  }
  fs.writeFileSync('${bundle_dir}/env-server/package.json', JSON.stringify(out, null, 2) + '\n')
"

echo "==> installing env-server dependencies"
(cd "$bundle_dir/env-server" && npm install --omit=dev --no-audit --no-fund --silent)

# node-pty spawn-helper needs execute permission
find "$bundle_dir/env-server/node_modules/node-pty/prebuilds" -name spawn-helper -type f -exec chmod 755 {} + 2>/dev/null || true

echo "==> building opencode plugin"
(cd "$repo_root/packages/opencode-plugin" && npm run build)

echo "==> staging opencode plugin"
cp "$repo_root/packages/opencode-plugin/dist/index.js" "$bundle_dir/opencode-plugin/index.js"

echo "==> building desktop electron app"
(cd "$desktop_dir" && npm run build)

echo "==> packaging electron app"
(cd "$desktop_dir" && npx electron-packager . "Cloud Code Desktop" \
  --platform=darwin --arch=arm64 --out=release --overwrite \
  --no-asar \
  --ignore='^/src($|/)' \
  --ignore='^/dist/.*\.map$' \
  --ignore='^/\.cloud-code($|/)' \
  --ignore='^/release($|/)')

if [ "$install_app" = true ]; then
  echo "==> installing to /Applications"
  stage_dir=$(mktemp -d "${TMPDIR:-/tmp}/cloud-code-desktop-install.XXXXXX")
  next_app="$stage_dir/Cloud Code Desktop.app"
  backup_dir="${HOME}/Library/Application Support/cloud-code-desktop/app-backups"
  backup_app="$backup_dir/Cloud Code Desktop.app.$(date +%Y%m%d%H%M%S)"
  mkdir -p "$backup_dir"
  cp -R "$desktop_dir/release/Cloud Code Desktop-darwin-arm64/Cloud Code Desktop.app" "$next_app"
  # fix spawn-helper permissions that cp may strip
  find "$next_app" -name spawn-helper -type f -exec chmod 755 {} + 2>/dev/null || true
  codesign --force --deep --sign - "$next_app"
  if [ -e '/Applications/Cloud Code Desktop.app' ]; then
    mv '/Applications/Cloud Code Desktop.app' "$backup_app"
  fi
  mv "$next_app" '/Applications/Cloud Code Desktop.app'
  rm -rf "$stage_dir"
  echo "==> previous app moved to $backup_app"
else
  echo "==> packaged app at $desktop_dir/release/Cloud Code Desktop-darwin-arm64/Cloud Code Desktop.app"
  echo "==> not installing to /Applications; rerun with --install from outside the running app to install"
fi

echo "==> cleaning bundle dir"
rm -rf "$bundle_dir"

echo "==> done"
