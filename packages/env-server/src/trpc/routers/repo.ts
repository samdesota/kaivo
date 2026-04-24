import { authedProcedure, router } from '../trpc.js'
import { db } from '../../db/client.js'
import { repos } from '../../db/schema.js'

// Phase 3 stub: repos.* endpoints return the SQLite rows but don't yet
// orchestrate clone/remove. Phase 4 will flesh out add/remove once
// identity-side `envApi.listRepoConfigs` is plumbed.
export const repoRouter = router({
  list: authedProcedure.query(() => {
    return db.select().from(repos).all()
  }),
})
