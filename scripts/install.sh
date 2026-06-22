#!/usr/bin/env bash
# install.sh — install cc-env as a background service on macOS / Linux.
#
#   1. Builds cc-env + the Kaivo OpenCode plugin from this repo checkout
#      (requires node ≥ 20 + npm in PATH).
#   2. Stages the bundle into $INSTALL_DIR (default ~/.local/share/cc-env).
#   3. Walks the device-flow pairing against a cc-control identity URL,
#      stores the returned identity token in $STATE_DIR/secrets.json (0600).
#   4. Writes a launchd plist (macOS) or a systemd user unit (Linux) and
#      loads it so cc-env runs at login.
#
# Re-running is safe: each step is idempotent. Pass --reset to clear the
# state dir and re-pair.
#
# Env overrides:
#   CC_INSTALL_DIR   — where cc-env lives (default ~/.local/share/cc-env)
#   CC_STATE_DIR     — where cc-env keeps its SQLite + secrets (default
#                      $CC_INSTALL_DIR/state)
#   CC_IDENTITY_URL  — URL of cc-control. Prompted if unset.
#   CC_WORKING_DIR   — workspace path cc-env will own. Prompted if unset.
#   CC_LABEL         — human label shown in the orchestrator UI. Prompted.
#   CC_PORT          — local port (default 47821).
#   CC_APP_ORIGIN    — browser origin allowed to call cc-env via CORS.
#                      Defaults to $CC_IDENTITY_URL.

set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
install_dir=${CC_INSTALL_DIR:-"${HOME}/.local/share/cc-env"}
state_dir_default="${install_dir}/state"
state_dir=${CC_STATE_DIR:-$state_dir_default}
reset=0
if [[ "${1:-}" == "--reset" ]]; then
  reset=1
  shift
fi

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1" >&2; exit 1; }
}

require node
require npm
require curl
require jq

platform=$(uname -s)
case "$platform" in
  Darwin) service_kind="launchd" ;;
  Linux) service_kind="systemd" ;;
  *) echo "unsupported platform: $platform"; exit 1 ;;
esac

prompt() {
  local var=$1 prompt_msg=$2 default=$3 resp
  local existing=${!var:-}
  if [[ -n "$existing" ]]; then
    printf -v "$var" '%s' "$existing"
    return
  fi
  if [[ -n "$default" ]]; then
    read -rp "$prompt_msg [$default]: " resp
  else
    read -rp "$prompt_msg: " resp
  fi
  if [[ -z "$resp" ]]; then resp=$default; fi
  if [[ -z "$resp" ]]; then echo "value required"; exit 1; fi
  printf -v "$var" '%s' "$resp"
}

echo "==> cc-env installer"
echo "     repo:        $repo_root"
echo "     install dir: $install_dir"
echo "     state dir:   $state_dir"
echo "     platform:    $platform ($service_kind)"

prompt CC_IDENTITY_URL "cc-control identity URL (e.g. https://your-control.example.com)" ""
# Strip trailing slash for downstream use.
CC_IDENTITY_URL=${CC_IDENTITY_URL%/}

prompt CC_WORKING_DIR "workspace directory cc-env will serve" "$HOME/code"
CC_WORKING_DIR=${CC_WORKING_DIR/#\~/$HOME}
if [[ ! -d "$CC_WORKING_DIR" ]]; then
  mkdir -p "$CC_WORKING_DIR"
  echo "     created $CC_WORKING_DIR"
fi

prompt CC_LABEL "env label (shown in the orchestrator UI)" "$(hostname -s)"
: "${CC_PORT:=47821}"
: "${CC_APP_ORIGIN:=$CC_IDENTITY_URL}"

mkdir -p "$install_dir/app" "$state_dir"

echo "==> ensuring opencode CLI is available"
if ! command -v opencode >/dev/null 2>&1; then
  echo "    opencode not found in PATH; installing globally via npm"
  npm install -g --no-audit --no-fund --silent opencode-ai@1.17.9
fi
opencode_bin=$(command -v opencode)
opencode_dir=$(dirname "$opencode_bin")
echo "    opencode at $opencode_bin"

echo "==> building cc-env"
(
  cd "$repo_root/packages/env-server"
  npm install --no-audit --no-fund --silent
  npm run build --silent
)

echo "==> building Kaivo OpenCode plugin"
(
  cd "$repo_root/packages/opencode-plugin"
  npm install --no-audit --no-fund --silent
  npm run build --silent
)

echo "==> staging into $install_dir"
cp "$repo_root/packages/env-server/dist/main.js" "$install_dir/app/main.js"
rm -rf "$install_dir/app/migrations"
cp -R "$repo_root/packages/env-server/migrations" "$install_dir/app/migrations"

# Ship the env-server package.json verbatim so `npm install` pulls in all
# runtime deps. tsup externalizes `dependencies`, so the bundled main.js
# expects to resolve them from a real node_modules tree.
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
  fs.writeFileSync('${install_dir}/app/package.json', JSON.stringify(out, null, 2) + '\n')
"

(
  cd "$install_dir/app"
  npm install --omit=dev --no-audit --no-fund --silent
)

# node-pty's macOS prebuild launches PTYs through spawn-helper. Some package
# copy/install paths can strip its executable bit, which makes PTY creation fail
# with the opaque native error "posix_spawnp failed.".
if [[ -d "$install_dir/app/node_modules/node-pty/prebuilds" ]]; then
  find "$install_dir/app/node_modules/node-pty/prebuilds" -name spawn-helper -type f -exec chmod 755 {} +
fi

# Plugin bundle lives next to the binary so the Dockerfile / local install
# share the same config shape.
mkdir -p "$install_dir/kaivo-opencode-plugin"
cp "$repo_root/packages/opencode-plugin/dist/index.js" "$install_dir/kaivo-opencode-plugin/index.js"

plugin_path_uri="file://${install_dir}/kaivo-opencode-plugin/index.js"

# --- device-flow pairing ---------------------------------------------------

secrets_path="$state_dir/secrets.json"

if [[ $reset -eq 1 ]]; then
  rm -f "$secrets_path"
  echo "==> reset: cleared $secrets_path"
fi

if [[ -f "$secrets_path" ]] && jq -e '.identityToken' "$secrets_path" >/dev/null 2>&1; then
  echo "==> identity token already present — skipping pairing"
else
  echo "==> starting device flow against $CC_IDENTITY_URL"
  device_start_body=$(jq -n --arg label "$CC_LABEL" '{json: {label: $label}}')
  start_resp=$(curl -fsS -X POST \
    -H "content-type: application/json" \
    -d "$device_start_body" \
    "$CC_IDENTITY_URL/trpc/envAuth.deviceStart") || {
      echo "failed to call envAuth.deviceStart at $CC_IDENTITY_URL" >&2
      exit 1
    }
  device_code=$(jq -r '.result.data.json.deviceCode' <<<"$start_resp")
  user_code=$(jq -r '.result.data.json.userCode' <<<"$start_resp")
  verification_url=$(jq -r '.result.data.json.verificationUrl' <<<"$start_resp")
  if [[ -z "$device_code" || "$device_code" == "null" ]]; then
    echo "unexpected deviceStart response: $start_resp" >&2
    exit 1
  fi

  cat <<EOF

  Open this URL in a logged-in browser and confirm the code:

    $verification_url

    (user code: $user_code)

EOF

  echo -n "   polling"
  identity_token=""
  for _ in $(seq 1 120); do
    echo -n "."
    sleep 2
    input_json=$(jq -n --arg c "$device_code" '{json: {deviceCode: $c}}')
    encoded=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$input_json")
    poll_resp=$(curl -fsS \
      "$CC_IDENTITY_URL/trpc/envAuth.devicePoll?input=$encoded" \
      -H "content-type: application/json" || echo "")
    if [[ -z "$poll_resp" ]]; then continue; fi
    status=$(jq -r '.result.data.json.status' <<<"$poll_resp")
    if [[ "$status" == "approved" ]]; then
      identity_token=$(jq -r '.result.data.json.identityToken' <<<"$poll_resp")
      echo
      echo "==> pairing approved"
      break
    fi
    if [[ "$status" == "denied" || "$status" == "expired" ]]; then
      echo
      echo "device flow returned status=$status; re-run install.sh" >&2
      exit 1
    fi
  done
  if [[ -z "$identity_token" ]]; then
    echo
    echo "device flow timed out; re-run install.sh" >&2
    exit 1
  fi

  umask 077
  jq -n --arg t "$identity_token" '{identityToken: $t}' > "$secrets_path"
  chmod 600 "$secrets_path"
  echo "==> wrote $secrets_path (mode 0600)"
fi

# --- service unit ----------------------------------------------------------

node_bin=$(command -v node)

case "$service_kind" in
  launchd)
    plist_path="$HOME/Library/LaunchAgents/com.cloudcode.env.plist"
    mkdir -p "$HOME/Library/LaunchAgents"
    log_dir="$state_dir/log"
    mkdir -p "$log_dir"
    cat > "$plist_path" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.cloudcode.env</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node_bin}</string>
    <string>${install_dir}/app/main.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CC_KIND</key><string>local</string>
    <key>CC_LABEL</key><string>${CC_LABEL}</string>
    <key>CC_WORKING_DIR</key><string>${CC_WORKING_DIR}</string>
    <key>CC_PORT</key><string>${CC_PORT}</string>
    <key>CC_HOST</key><string>127.0.0.1</string>
    <key>CC_STATE_DIR</key><string>${state_dir}</string>
    <key>CC_IDENTITY_URL</key><string>${CC_IDENTITY_URL}</string>
    <key>CC_ALLOWED_ORIGINS</key><string>${CC_APP_ORIGIN}</string>
    <key>CC_OPENCODE_PLUGIN_PATH</key><string>${plugin_path_uri}</string>
    <key>PATH</key><string>${opencode_dir}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log_dir}/cc-env.log</string>
  <key>StandardErrorPath</key><string>${log_dir}/cc-env.err</string>
</dict>
</plist>
EOF
    # Unload any existing version so env var changes take effect; bootstrap
    # against the user's gui domain so it auto-starts at login.
    launchctl bootout "gui/$UID/com.cloudcode.env" 2>/dev/null || true
    launchctl bootstrap "gui/$UID" "$plist_path"
    launchctl enable "gui/$UID/com.cloudcode.env"
    echo "==> launchd loaded com.cloudcode.env"
    echo "    tail log:  tail -f ${log_dir}/cc-env.log"
    ;;
  systemd)
    unit_dir="$HOME/.config/systemd/user"
    mkdir -p "$unit_dir"
    unit_path="$unit_dir/cc-env.service"
    cat > "$unit_path" <<EOF
[Unit]
Description=cloud-code env server
After=network-online.target

[Service]
Type=simple
Environment=CC_KIND=local
Environment=CC_LABEL=${CC_LABEL}
Environment=CC_WORKING_DIR=${CC_WORKING_DIR}
Environment=CC_PORT=${CC_PORT}
Environment=CC_HOST=127.0.0.1
Environment=CC_STATE_DIR=${state_dir}
Environment=CC_IDENTITY_URL=${CC_IDENTITY_URL}
Environment=CC_ALLOWED_ORIGINS=${CC_APP_ORIGIN}
Environment=CC_OPENCODE_PLUGIN_PATH=${plugin_path_uri}
Environment=PATH=${opencode_dir}:/usr/local/bin:/usr/bin:/bin
ExecStart=${node_bin} ${install_dir}/app/main.js
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now cc-env.service
    echo "==> systemd loaded cc-env.service"
    echo "    tail log:  journalctl --user -u cc-env.service -f"
    ;;
esac

# --- pair with the webapp --------------------------------------------------

cat <<EOF

==> install complete

Next: finish pairing the webapp to this local env.
  1. Tail the log to see the pair code that cc-env printed on boot:
       $([[ "$service_kind" == launchd ]] && echo "tail -f ${state_dir}/log/cc-env.log" || echo "journalctl --user -u cc-env.service -f")
  2. In the webapp, add this local env:
       URL:   http://127.0.0.1:${CC_PORT}
       Label: ${CC_LABEL}
     and enter the 6-digit pair code from the log.

To re-pair:           scripts/install.sh --reset
To stop the service:  $([[ "$service_kind" == launchd ]] && echo "launchctl bootout gui/\$UID/com.cloudcode.env" || echo "systemctl --user disable --now cc-env.service")
EOF
