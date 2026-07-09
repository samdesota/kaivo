import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import bcrypt from 'bcrypt'
import { runLocalAppMigrations } from '../server/db/local-migrate'

const DEFAULT_PASSWORD = 'password'
const DEFAULT_OPENAI_API_KEY = 'dev-local-llm-key'
const DEFAULT_OPENAI_BASE_URL = 'https://llm.438d.xyz'
const DEFAULT_OPENAI_API_KEY_OP_REF = 'op://Personal/llm.438d.xyz/password'
const DEFAULT_MODEL = { providerID: 'openai', modelID: 'gpt-5.6-sol' }
const BCRYPT_COST = 12
const DESKTOP_APP_ID = 'kaivo-desktop'

export type DevSeedOptions = {
  env?: NodeJS.ProcessEnv
  cwd?: string
  log?: (message: string) => void
}

export async function runDevSeed(options: DevSeedOptions = {}): Promise<void> {
  const seedEnv = options.env ?? process.env
  const log = options.log ?? console.log

  if (seedEnv.NODE_ENV === 'production' && seedEnv.CC_SEED_FORCE !== 'true') {
    throw new Error('Refusing to run dev seed with NODE_ENV=production. Set CC_SEED_FORCE=true to override.')
  }

  const target = seedEnv.CC_SEED_TARGET ?? 'desktop-dev'
  const cwd = path.resolve(options.cwd ?? process.cwd())
  const homeDir = seedEnv.HOME ?? cwd
  const instanceId = sanitizeId(seedEnv.CC_INSTANCE_ID ?? defaultInstanceId(target, cwd))
  const instanceRoot = path.resolve(seedEnv.CC_INSTANCE_ROOT ?? defaultInstanceRoot(target, homeDir, cwd, instanceId))
  const dataDir = path.resolve(seedEnv.DATA_DIR ?? seedEnv.CC_APP_DATA_DIR ?? path.join(instanceRoot, 'app'))
  const sqlitePath = path.resolve(seedEnv.APP_SQLITE_PATH ?? seedEnv.CC_APP_SQLITE_PATH ?? path.join(dataDir, 'app.db'))

  seedEnv.NODE_ENV ??= 'development'
  seedEnv.DATA_DIR = dataDir
  seedEnv.APP_SQLITE_PATH = sqlitePath
  seedEnv.CC_SERVICE_CREDENTIAL ??= 'local-dev-seed-service-credential'

  Object.assign(process.env, seedEnv)

  const migration = runLocalAppMigrations(sqlitePath)

  const [{ db }, { admin }, { putSecret }] = await Promise.all([
    import('../server/db/client'),
    import('../server/db/schema'),
    import('../server/secrets/index'),
  ])

  const password = seedEnv.CC_SEED_ADMIN_PASSWORD ?? DEFAULT_PASSWORD
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST)
  await db
    .insert(admin)
    .values({ id: 1, passwordHash })
    .onConflictDoUpdate({
      target: admin.id,
      set: { passwordHash },
    })

  const openaiApiKey = seedEnv.CC_SEED_OPENAI_API_KEY ?? readOnePasswordSecret(seedEnv) ?? DEFAULT_OPENAI_API_KEY
  const openaiBaseUrl = seedEnv.CC_SEED_OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL
  const model = {
    providerID: seedEnv.CC_SEED_MODEL_PROVIDER ?? DEFAULT_MODEL.providerID,
    modelID: seedEnv.CC_SEED_MODEL_ID ?? DEFAULT_MODEL.modelID,
  }

  await putSecret('provider.openai.api_key', openaiApiKey)
  await putSecret('provider.openai.base_url', openaiBaseUrl)
  await putSecret('agent.default_model', JSON.stringify(model))

  const displayPath = path.relative(process.cwd(), sqlitePath) || sqlitePath
  log(`Seed target: ${target}`)
  log(`Seeded dev app database: ${displayPath}`)
  if (migration.applied.length > 0) log(`Applied migrations: ${migration.applied.join(', ')}`)
  log(`Admin password: ${password}`)
  log(`OpenAI-compatible base URL: ${openaiBaseUrl}`)
  log(`OpenAI-compatible API key: ${openaiApiKey === DEFAULT_OPENAI_API_KEY ? 'placeholder' : 'configured'}`)
  log(`Default model: ${model.providerID}/${model.modelID}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDevSeed().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
  })
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

function sanitizeId(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return sanitized || 'default'
}

function defaultInstanceId(target: string, cwd: string): string {
  if (target === 'desktop-prod') return DESKTOP_APP_ID
  return `dev-${shortHash(cwd)}`
}

function defaultInstanceRoot(target: string, homeDir: string, cwd: string, instanceId: string): string {
  if (target === 'desktop-prod') {
    return path.join(homeDir, 'Library', 'Application Support', DESKTOP_APP_ID, 'instances', instanceId)
  }
  return path.join(cwd, '.kaivo', 'instances', instanceId)
}

function readOnePasswordSecret(seedEnv: NodeJS.ProcessEnv): string | null {
  const ref = seedEnv.CC_SEED_OPENAI_API_KEY_OP_REF ?? DEFAULT_OPENAI_API_KEY_OP_REF
  if (seedEnv.CC_SEED_OPENAI_API_KEY_OP_REF === '') return null
  try {
    const value = execFileSync('op', ['read', ref], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000,
    }).trim()
    return value || null
  } catch {
    return null
  }
}
