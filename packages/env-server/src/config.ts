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

  // Human label; shown in meta.info. Orchestrator/install.sh writes this.
  CC_LABEL: z.string().default('unnamed env'),

  // CORS allowlist — comma-separated origins that may call this env
  // server. "*" is NOT allowed; we always need bearer auth from a
  // specific origin so tokens aren't leaked cross-site.
  CC_ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  console.error('Invalid environment:', parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const config = parsed.data
export const allowedOrigins = config.CC_ALLOWED_ORIGINS.split(',')
  .map((s) => s.trim())
  .filter(Boolean)
