import { observable } from '@trpc/server/observable'
import { z } from 'zod'
import { protectedProcedure, router } from '../trpc.js'
import { previewService, type PreviewPort } from '../../preview/service.js'

export const previewRouter = router({
  ports: protectedProcedure
    .input(z.object({ sandboxId: z.string().min(1) }))
    .subscription(({ input }) => {
      return observable<{ sandboxId: string; ports: PreviewPort[] }>((emit) => {
        // Emit current snapshot, then tail.
        const snapshot = previewService.getPorts(input.sandboxId)
        emit.next({ sandboxId: input.sandboxId, ports: snapshot })
        const unsub = previewService.subscribe(input.sandboxId, (evt) => emit.next(evt))
        return () => unsub()
      })
    }),

  portsSnapshot: protectedProcedure
    .input(z.object({ sandboxId: z.string().min(1) }))
    .query(({ input }) => previewService.getPorts(input.sandboxId)),
})
