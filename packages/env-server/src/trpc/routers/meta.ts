import { authedProcedure, publicProcedure, router } from '../trpc.js'
import { config } from '../../config.js'
import { getMeta, isPaired } from '../../envmeta/service.js'
import { opencodeSupervisor } from '../../agent/opencode.js'
import { getIdentityToken } from '../../identity/client.js'

export const metaRouter = router({
  info: authedProcedure.query(() => {
    const m = getMeta()
    return {
      kind: config.CC_KIND,
      label: config.CC_LABEL,
      workingDir: config.CC_WORKING_DIR,
      paired: m.envTokenHash !== null,
      pairedAt: m.pairedAt,
      opencodeReady: opencodeSupervisor.isReady(),
      identityReady: getIdentityToken() !== null,
      version: '0.0.1',
    }
  }),

  // Unauthenticated liveness — same info `meta.info` returns but without
  // the bearer requirement. Useful for diagnostics over the trpc transport.
  status: publicProcedure.query(() => {
    return {
      kind: config.CC_KIND,
      label: config.CC_LABEL,
      paired: isPaired(),
    }
  }),
})
