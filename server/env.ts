import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().min(1),
  DATA_DIR: z.string().default('/data'),
  PUBLIC_URL: z.string().default('http://localhost:3000'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  ADMIN_PASSWORD_BOOTSTRAP: z.string().optional(),
  SANDBOX_BASE_IMAGE: z.string().default('cloud-code-sandbox:dev'),
  DOCKER_NETWORK: z.string().default('cloud-code-net'),
  COOKIE_SECURE: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  console.error('Invalid environment:', parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const env = parsed.data

export const isProd = env.NODE_ENV === 'production'
export const isTest = env.NODE_ENV === 'test'
