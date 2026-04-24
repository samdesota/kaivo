import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().min(1),
  DATA_DIR: z.string().default('/data'),
  // Host-side path that is bind-mounted to DATA_DIR in the app container.
  // Required when the app runs in a container and spawns sandbox containers
  // on the same Docker daemon — the daemon resolves bind sources against the
  // host filesystem, so we must translate container-local paths to host paths
  // before calling `docker create`. When unset, falls back to DATA_DIR (for
  // running the server directly on the host).
  HOST_DATA_DIR: z.string().optional(),
  PUBLIC_URL: z.string().default('http://localhost:3000'),
  // When set, enables host-header-based preview routing. Preview URLs become
  // https://<sandboxId>-<port>.{PREVIEW_HOSTNAME}/. Unset => path-based only.
  PREVIEW_HOSTNAME: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  ADMIN_PASSWORD_BOOTSTRAP: z.string().optional(),
  SANDBOX_BASE_IMAGE: z.string().default('cloud-code-sandbox:dev'),
  DOCKER_NETWORK: z.string().default('cloud-code-net'),
  // URL sandboxes use to reach the app for agentShell.* calls. Container
  // DNS on the shared docker network, so `http://app:3000` is the default.
  // Override in dev when the app listens on the host (`host.docker.internal`).
  SANDBOX_APP_URL: z.string().default('http://app:3000'),
  // Dev-only: bind-mount this host file into each sandbox at
  // /opt/cloud-code-plugin/index.js so `npm run build:plugin` + a sandbox
  // restart is enough to pick up plugin changes (no image rebuild).
  DEV_PLUGIN_HOST_PATH: z.string().optional(),
  // Optional host directory containing an SSH private key (`id_ed25519` or
  // similar) and `known_hosts`. Bind-mounted RO into each sandbox at
  // /home/coder/.ssh, enabling `git clone` against ssh:// or git@host:path
  // remotes. Files must be readable by uid 1000 (the `coder` user inside
  // the sandbox).
  SANDBOX_SSH_DIR: z.string().optional(),
  // Mount the host docker socket into each sandbox so agents can run
  // `docker` commands (build images, start sibling containers, etc).
  // Note: this gives the sandbox effective root on the host docker daemon —
  // the per-container sandboxing (caps drop, readonly rootfs) does not apply
  // to anything launched through the socket.
  SANDBOX_DOCKER_SOCK: z
    .union([z.literal('true'), z.literal('false')])
    .default('true')
    .transform((v) => v === 'true'),
  // GID of the host docker socket. Added to each sandbox container so the
  // non-root `coder` user can read /var/run/docker.sock. Default 0 matches
  // Docker Desktop on macOS; on Linux set to the host `docker` group gid
  // (commonly 988 or 999).
  SANDBOX_DOCKER_SOCK_GID: z.coerce.number().int().nonnegative().default(0),
  COOKIE_SECURE: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  // Apex domain to scope the session cookie to. Set this when previews live
  // on subdomains so the iframe (different host) sends the session cookie.
  // Example: `438d.xyz` covers `code.438d.xyz` + `*.preview.438d.xyz`.
  COOKIE_DOMAIN: z.string().optional(),
  // Phase 4 bootstrap knobs. Keys here are only consulted on first start
  // (or when the corresponding DB row is absent) — see AgentService.
  ANTHROPIC_API_KEY_BOOTSTRAP: z.string().optional(),
  ANTHROPIC_BASE_URL_BOOTSTRAP: z.string().optional(),
  OPENAI_API_KEY_BOOTSTRAP: z.string().optional(),
  OPENAI_BASE_URL_BOOTSTRAP: z.string().optional(),
  // Shared secret for orchestrator → identity's envAuth.issueFromService.
  // In v1 the orchestrator and identity routers live in the same process so
  // this is essentially a self-check; still required so the wiring mirrors
  // the split-process deployment.
  CC_SERVICE_CREDENTIAL: z.string().min(16),
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  console.error('Invalid environment:', parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const env = parsed.data

export const isProd = env.NODE_ENV === 'production'
export const isTest = env.NODE_ENV === 'test'
