import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Single working directory owned by this env. For container mode this
  // is mounted at /workspace; for local mode it's the host path the user
  // picked during install.sh. Must exist and be a directory at boot.
  CC_WORKING_DIR: z.string().min(1),

  // Loopback port for local; 0.0.0.0 in container (the orchestrator's
  // reverse proxy routes externally).
  CC_PORT: z.coerce.number().int().positive().default(47821),
  CC_HOST: z.string().default('0.0.0.0'),

  // URL of the identity service (`cc-control`). Used for
  // envApi.resolveProviderKeys / getRepoConfig and other env→identity calls.
  CC_IDENTITY_URL: z.string().url(),

  // Where SQLite + secrets.json + logs live.
  CC_STATE_DIR: z.string().min(1),

  CC_KIND: z.enum(['container', 'local']).default('local'),

  // Stable identity for a desktop-managed local runtime. Electron uses this
  // to distinguish its matching cc-env from another worktree's cc-env.
  CC_INSTANCE_ID: z.string().default('default'),

  // Human label; shown in meta.info. Orchestrator/install.sh writes this.
  CC_LABEL: z.string().default('unnamed env'),

  // CORS allowlist — comma-separated origins that may call this env
  // server. "*" is NOT allowed; we always need bearer auth from a
  // specific origin so tokens aren't leaked cross-site.
  CC_ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),

  // Opencode binary; must be in PATH or an absolute path.
  CC_OPENCODE_BIN: z.string().default('opencode'),

  // `file://` URI or absolute path to the Zoottle opencode plugin. In
  // container mode the Dockerfile bakes it to /opt; in local mode
  // install.sh writes it under the state dir.
  CC_OPENCODE_PLUGIN_PATH: z.string().default('file:///opt/zoottle-opencode-plugin/index.js'),

  // Desktop-managed local envs proxy persistent PTY shells to a sibling
  // terminal daemon over this Unix socket. Container/manual envs leave it unset
  // and keep the historical in-process terminal service behavior.
  CC_TERMINAL_SOCKET: z.string().optional(),
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  console.error('Invalid environment:', parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const config = parsed.data
const configuredAllowedOrigins = config.CC_ALLOWED_ORIGINS.split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const localDevOrigins =
  config.CC_KIND === 'local'
    ? ['http://localhost:3000', 'http://127.0.0.1:3000']
    : []

export const allowedOrigins = Array.from(
  new Set([...configuredAllowedOrigins, ...localDevOrigins]),
)
