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
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  ADMIN_PASSWORD_BOOTSTRAP: z.string().optional(),
  SANDBOX_BASE_IMAGE: z.string().default('cloud-code-sandbox:dev'),
  DOCKER_NETWORK: z.string().default('cloud-code-net'),
  // URL sandboxes use to reach the app for agentShell.* calls. Container
  // DNS on the shared docker network, so `http://app:3000` is the default.
  // Override in dev when the app listens on the host (`host.docker.internal`).
  SANDBOX_APP_URL: z.string().default('http://app:3000'),
  COOKIE_SECURE: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  // Phase 4 bootstrap knobs. Keys here are only consulted on first start
  // (or when the corresponding DB row is absent) — see AgentService.
  ANTHROPIC_API_KEY_BOOTSTRAP: z.string().optional(),
  ANTHROPIC_BASE_URL_BOOTSTRAP: z.string().optional(),
  OPENAI_API_KEY_BOOTSTRAP: z.string().optional(),
  OPENAI_BASE_URL_BOOTSTRAP: z.string().optional(),
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  console.error('Invalid environment:', parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const env = parsed.data

export const isProd = env.NODE_ENV === 'production'
export const isTest = env.NODE_ENV === 'test'
