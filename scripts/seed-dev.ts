import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import bcrypt from 'bcrypt'
import { runLocalAppMigrations } from '../server/db/local-migrate'

const DEFAULT_PASSWORD = 'password'
const DEFAULT_OPENAI_API_KEY = 'dev-local-llm-key'
const DEFAULT_OPENAI_BASE_URL = 'https://llm.438d.xyz'
const DEFAULT_OPENAI_API_KEY_OP_REF = 'op://Personal/llm.438d.xyz/password'
const DEFAULT_MODEL = { providerID: 'openai', modelID: 'gpt-5.5' }
const BCRYPT_COST = 12
const DESKTOP_APP_ID = 'cloud-code-desktop'

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production' && process.env.CC_SEED_FORCE !== 'true') {
    throw new Error('Refusing to run dev seed with NODE_ENV=production. Set CC_SEED_FORCE=true to override.')
  }

  const target = process.env.CC_SEED_TARGET ?? 'desktop-dev'
  const cwd = path.resolve(process.cwd())
  const homeDir = process.env.HOME ?? cwd
  const instanceId = sanitizeId(process.env.CC_INSTANCE_ID ?? defaultInstanceId(target, cwd))
  const instanceRoot = path.resolve(process.env.CC_INSTANCE_ROOT ?? defaultInstanceRoot(target, homeDir, cwd, instanceId))
  const dataDir = path.resolve(process.env.DATA_DIR ?? process.env.CC_APP_DATA_DIR ?? path.join(instanceRoot, 'app'))
  const sqlitePath = path.resolve(process.env.APP_SQLITE_PATH ?? process.env.CC_APP_SQLITE_PATH ?? path.join(dataDir, 'app.db'))

  process.env.NODE_ENV ??= 'development'
  process.env.DATA_DIR = dataDir
  process.env.APP_SQLITE_PATH = sqlitePath
  process.env.CC_SERVICE_CREDENTIAL ??= 'local-dev-seed-service-credential'

  const migration = runLocalAppMigrations(sqlitePath)

  const [{ db }, { admin }, { putSecret }] = await Promise.all([
    import('../server/db/client'),
    import('../server/db/schema'),
    import('../server/secrets/index'),
  ])

  const password = process.env.CC_SEED_ADMIN_PASSWORD ?? DEFAULT_PASSWORD
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST)
  await db
    .insert(admin)
    .values({ id: 1, passwordHash })
    .onConflictDoUpdate({
      target: admin.id,
      set: { passwordHash },
    })

  const openaiApiKey = process.env.CC_SEED_OPENAI_API_KEY ?? readOnePasswordSecret() ?? DEFAULT_OPENAI_API_KEY
  const openaiBaseUrl = process.env.CC_SEED_OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL
  const model = {
    providerID: process.env.CC_SEED_MODEL_PROVIDER ?? DEFAULT_MODEL.providerID,
    modelID: process.env.CC_SEED_MODEL_ID ?? DEFAULT_MODEL.modelID,
  }

  await putSecret('provider.openai.api_key', openaiApiKey)
  await putSecret('provider.openai.base_url', openaiBaseUrl)
  await putSecret('agent.default_model', JSON.stringify(model))

  const displayPath = path.relative(process.cwd(), sqlitePath) || sqlitePath
  console.log(`Seed target: ${target}`)
  console.log(`Seeded dev app database: ${displayPath}`)
  if (migration.applied.length > 0) console.log(`Applied migrations: ${migration.applied.join(', ')}`)
  console.log(`Admin password: ${password}`)
  console.log(`OpenAI-compatible base URL: ${openaiBaseUrl}`)
  console.log(`OpenAI-compatible API key: ${openaiApiKey === DEFAULT_OPENAI_API_KEY ? 'placeholder' : 'configured'}`)
  console.log(`Default model: ${model.providerID}/${model.modelID}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})

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
  return path.join(cwd, '.cloud-code', 'instances', instanceId)
}

function readOnePasswordSecret(): string | null {
  const ref = process.env.CC_SEED_OPENAI_API_KEY_OP_REF ?? DEFAULT_OPENAI_API_KEY_OP_REF
  if (process.env.CC_SEED_OPENAI_API_KEY_OP_REF === '') return null
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
