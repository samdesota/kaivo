#!/usr/bin/env bash
# Stage the prebuilt opencode-plugin + cc-env artifacts into the
# docker/base-sandbox/ build context so `docker build docker/base-sandbox`
# can COPY them. Run as part of `npm run prepare:sandbox-image` after the
# package-level builds.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
ctx="${root}/docker/base-sandbox"

mkdir -p "${ctx}/plugin" "${ctx}/cc-env"
cp "${root}/packages/opencode-plugin/dist/index.js" "${ctx}/plugin/index.js"

# cc-env: bundled main.js + migrations + a slimmed-down package.json with
# just the runtime deps (better-sqlite3, node-pty) that the tsup bundle
# imports externally. Everything else was inlined by tsup.
cp "${root}/packages/env-server/dist/main.js" "${ctx}/cc-env/main.js"
rm -rf "${ctx}/cc-env/migrations"
cp -R "${root}/packages/env-server/migrations" "${ctx}/cc-env/migrations"

# Minimal runtime package.json. Keep version + name so npm install is
# deterministic; drop devDeps and non-native runtime deps (tsup inlined).
node --input-type=module -e "
  import fs from 'node:fs'
  const src = JSON.parse(fs.readFileSync('${root}/packages/env-server/package.json', 'utf8'))
  const native = ['better-sqlite3', 'node-pty']
  const out = {
    name: src.name,
    version: src.version,
    private: true,
    type: 'module',
    dependencies: Object.fromEntries(
      Object.entries(src.dependencies ?? {}).filter(([k]) => native.includes(k))
    ),
  }
  fs.writeFileSync('${ctx}/cc-env/package.json', JSON.stringify(out, null, 2) + '\n')
"
