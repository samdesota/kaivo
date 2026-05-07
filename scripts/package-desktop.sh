#!/usr/bin/env bash
# package-desktop.sh — build a self-contained Cloud Code Desktop.app
#
# Bundles the webapp server, env-server, opencode plugin, and client SPA
# into the Electron app so it runs without the source repo.
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
desktop_dir="$repo_root/packages/cloud-code-desktop"
bundle_dir="$desktop_dir/bundle"
package_cache_dir="${CC_PACKAGE_CACHE_DIR:-$repo_root/node_modules/.cache/cloud-code-desktop-package}"
install_app=false
job_log_dir=""

cleanup_job_logs() {
  if [ -n "$job_log_dir" ]; then
    rm -rf "$job_log_dir"
  fi
}
trap cleanup_job_logs EXIT

run_job() {
  local pid_var="$1"
  local name="$2"
  shift
  shift
  local log_file="$job_log_dir/$name.log"
  echo "==> starting $name"
  ("$@") >"$log_file" 2>&1 &
  printf -v "$pid_var" '%s' "$!"
}

wait_job() {
  local name="$1"
  local pid="$2"
  local log_file="$job_log_dir/$name.log"
  if wait "$pid"; then
    echo "==> completed $name"
  else
    echo "==> failed $name" >&2
    cat "$log_file" >&2
    exit 1
  fi
}

runtime_cache_key() {
  local package_json="$1"
  local lock_file="$2"
  {
    shasum -a 256 "$package_json"
    shasum -a 256 "$lock_file"
    node -p "process.platform + '-' + process.arch + '-abi' + process.versions.modules"
    npm --version
    echo "runtime-cache-v1"
  } | shasum -a 256 | awk '{print $1}'
}

install_runtime_deps() {
  local runtime_dir="$1"
  local cache_name="$2"
  local lock_file="$3"
  local cache_dir="$package_cache_dir/$cache_name"
  local key
  key=$(runtime_cache_key "$runtime_dir/package.json" "$lock_file")

  if [ -d "$cache_dir/node_modules" ] && [ -f "$cache_dir/.cache-key" ] && [ "$(cat "$cache_dir/.cache-key")" = "$key" ]; then
    echo "==> reusing cached $cache_name dependencies"
  else
    echo "==> installing $cache_name dependencies into cache"
    local tmp_dir="$cache_dir.tmp.$$"
    rm -rf "$tmp_dir"
    mkdir -p "$tmp_dir"
    cp "$runtime_dir/package.json" "$tmp_dir/package.json"
    (cd "$tmp_dir" && npm install --omit=dev --no-audit --no-fund --silent)
    echo "$key" > "$tmp_dir/.cache-key"
    rm -rf "$cache_dir"
    mkdir -p "$(dirname "$cache_dir")"
    mv "$tmp_dir" "$cache_dir"
  fi

  echo "==> staging cached $cache_name dependencies"
  mkdir -p "$runtime_dir/node_modules"
  rsync -a --delete "$cache_dir/node_modules/" "$runtime_dir/node_modules/"
}

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
job_log_dir=$(mktemp -d "${TMPDIR:-/tmp}/cloud-code-desktop-package.XXXXXX")

run_job client_pid "client-spa" bash -lc "cd '$repo_root' && npx vite build"
run_job app_server_pid "app-server-build" bash -lc "cd '$repo_root' && npx tsup"
run_job env_server_pid "env-server-build" bash -lc "cd '$repo_root/packages/env-server' && npm run build"
run_job opencode_plugin_pid "opencode-plugin-build" bash -lc "cd '$repo_root/packages/opencode-plugin' && npm run build"
run_job desktop_pid "desktop-build" bash -lc "cd '$desktop_dir' && npm run build"

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

run_job app_deps_pid "app-server-deps" install_runtime_deps "$bundle_dir/app-server" "app-server" "$repo_root/package-lock.json"

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

run_job env_deps_pid "env-server-deps" install_runtime_deps "$bundle_dir/env-server" "env-server" "$repo_root/packages/env-server/package-lock.json"

wait_job "client-spa" "$client_pid"
wait_job "app-server-build" "$app_server_pid"
wait_job "app-server-deps" "$app_deps_pid"

echo "==> staging app server bundle"
cp "$repo_root/dist/server/index.js" "$bundle_dir/app-server/index.js"
cp -R "$repo_root/dist/client" "$bundle_dir/client"

wait_job "env-server-build" "$env_server_pid"
wait_job "env-server-deps" "$env_deps_pid"

echo "==> staging env-server bundle"
cp "$repo_root/packages/env-server/dist/main.js" "$bundle_dir/env-server/main.js"
cp "$repo_root/packages/env-server/dist/terminal-daemon.js" "$bundle_dir/env-server/terminal-daemon.js"
rsync -a "$repo_root/packages/env-server/migrations/" "$bundle_dir/env-server/migrations/"

# node-pty spawn-helper needs execute permission
find "$bundle_dir/env-server/node_modules/node-pty/prebuilds" -name spawn-helper -type f -exec chmod 755 {} + 2>/dev/null || true

wait_job "opencode-plugin-build" "$opencode_plugin_pid"

echo "==> staging opencode plugin"
cp "$repo_root/packages/opencode-plugin/dist/index.js" "$bundle_dir/opencode-plugin/index.js"

wait_job "desktop-build" "$desktop_pid"

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
