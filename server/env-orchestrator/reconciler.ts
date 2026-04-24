import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { envs } from '../db/schema.js'
import { getDocker } from '../docker/client.js'
import { logger } from '../logger.js'
import { ENV_CONTAINER_LABEL } from './paths.js'

/**
 * Reconcile the docker-side view of cc-env containers with the `envs`
 * table:
 *   - If a `kind='container'` row has a containerId that no longer exists,
 *     clear the containerId and mark status='stopped'.
 *   - If a container with our label exists but isn't referenced, leave it
 *     (an operator may have launched it by hand).
 */
class EnvReconciler {
  async reconcile(): Promise<void> {
    const docker = getDocker()
    const liveIds = new Set<string>()
    try {
      const list = await docker.listContainers({ all: true })
      for (const c of list) {
        if (c.Labels && ENV_CONTAINER_LABEL in c.Labels) {
          liveIds.add(c.Id)
        }
      }
    } catch (err) {
      logger.warn({ err }, 'env reconciler: docker list failed')
      return
    }

    const rows = await db.select().from(envs)
    for (const row of rows) {
      if (row.kind !== 'container') continue
      if (!row.containerId) continue
      if (!liveIds.has(row.containerId)) {
        logger.info(
          { envId: row.id, containerId: row.containerId },
          'reconciler: container missing, clearing',
        )
        await db
          .update(envs)
          .set({ containerId: null, status: 'unreachable' })
          .where(eq(envs.id, row.id))
      }
    }
  }
}

export const envReconciler = new EnvReconciler()
