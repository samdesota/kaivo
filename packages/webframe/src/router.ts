import { initTRPC, TRPCError } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import { z } from 'zod';
import type { EventBus } from './bus';
import type { OverlayManager } from './overlay';
import type { HistoryStore } from './stores/types';
import type { TabManager } from './tab';
import type { Caller } from './types';
import { WebframeError } from './types';
import type { WindowManager } from './window';

export type Ctx = { caller: Caller };

const t = initTRPC.context<Ctx>().create();

export const createCallerFactory = t.createCallerFactory;

const rectSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});
const anchorSchema = z.union([
  z.object({ slot: z.string() }),
  z.object({
    edge: z.enum(['top', 'bottom', 'left', 'right']),
    size: z.number(),
  }),
  rectSchema,
]);
const slotSchema = z.object({ name: z.string(), rect: rectSchema });

function tabNotFoundResult(err: unknown) {
  if (err instanceof WebframeError && err.code === 'TAB_NOT_FOUND') {
    return { ok: false as const, code: 'TAB_NOT_FOUND' as const, message: err.message };
  }
  return null;
}

function toTRPCError(err: unknown): never {
  if (err instanceof WebframeError) {
    throw new TRPCError({
      code: err.code === 'WINDOW_NOT_FOUND' || err.code === 'TAB_NOT_FOUND' || err.code === 'OVERLAY_NOT_FOUND' ? 'NOT_FOUND' : 'BAD_REQUEST',
      message: `${err.code}: ${err.message}`,
      cause: err,
    });
  }
  throw err;
}

export type RouterDeps = {
  windows: WindowManager;
  tabs: TabManager;
  overlays: OverlayManager;
  historyStore: HistoryStore;
  bus: EventBus;
};

export function createRouter(deps: RouterDeps) {
  const { windows, tabs, overlays, historyStore, bus } = deps;

  return t.router({
    windows: t.router({
      list: t.procedure.query(() => windows.listInfo()),
      get: t.procedure
        .input(z.object({ windowId: z.string() }))
        .query(({ input }) => {
          const w = windows.get(input.windowId);
          if (!w) throw new TRPCError({ code: 'NOT_FOUND', message: 'WINDOW_NOT_FOUND' });
          return windows.toInfo(w);
        }),
      setSlots: t.procedure
        .input(z.object({ windowId: z.string(), slots: z.array(slotSchema) }))
        .mutation(({ input }) => {
          try {
            windows.setSlots(input.windowId, input.slots);
            return { ok: true as const };
          } catch (e) {
            toTRPCError(e);
          }
        }),
      onResize: t.procedure
        .input(z.object({ windowId: z.string().optional() }))
        .subscription(({ input }) =>
          observable<{ windowId: string; w: number; h: number }>((emit) => {
            const off = bus.on('window:resize', (ev) => {
              if (input.windowId && ev.windowId !== input.windowId) return;
              emit.next(ev);
            });
            return () => off();
          }),
        ),
    }),

    tabs: t.router({
      create: t.procedure
        .input(
          z.object({
            url: z.string(),
            windowId: z.string().optional(),
            placement: anchorSchema.optional(),
            active: z.boolean().optional().default(false),
            ownerKey: z.string().optional(),
            stateStoreKey: z.string().optional(),
          }),
        )
        .mutation(async ({ input }) => {
          try {
            return await tabs.create(input);
          } catch (e) {
            toTRPCError(e);
          }
        }),
      close: t.procedure
        .input(z.object({ tabId: z.string() }))
        .mutation(async ({ input }) => {
          try {
            await tabs.close(input.tabId);
            return { ok: true as const };
          } catch (e) {
            const notFound = tabNotFoundResult(e);
            if (notFound) return notFound;
            toTRPCError(e);
          }
        }),
      move: t.procedure
        .input(
          z.object({
            tabId: z.string(),
            windowId: z.string(),
            placement: anchorSchema,
          }),
        )
        .mutation(({ input }) => {
          try {
            tabs.move(input.tabId, input.windowId, input.placement);
            return { ok: true as const };
          } catch (e) {
            const notFound = tabNotFoundResult(e);
            if (notFound) return notFound;
            toTRPCError(e);
          }
        }),
      detach: t.procedure
        .input(z.object({ tabId: z.string() }))
        .mutation(async ({ input }) => {
          try {
            await tabs.detach(input.tabId);
            return { ok: true as const };
          } catch (e) {
            const notFound = tabNotFoundResult(e);
            if (notFound) return notFound;
            toTRPCError(e);
          }
        }),
      setActive: t.procedure
        .input(z.object({ tabId: z.string(), windowId: z.string() }))
        .mutation(({ input }) => {
          try {
            tabs.setActive(input.tabId, input.windowId);
            return { ok: true as const };
          } catch (e) {
            const notFound = tabNotFoundResult(e);
            if (notFound) return notFound;
            toTRPCError(e);
          }
        }),
      list: t.procedure
        .input(z.object({ windowId: z.string().optional() }).optional())
        .query(({ input }) => tabs.listRecords(input?.windowId)),
      get: t.procedure
        .input(z.object({ tabId: z.string() }))
        .query(({ input }) => {
          const tab = tabs.get(input.tabId);
          if (!tab) return null;
          return { ...tab.record };
        }),
      onChange: t.procedure
        .input(z.object({ tabId: z.string().optional() }).optional())
        .subscription(({ input }) =>
          observable<{ tabId: string; patch: Record<string, unknown> }>((emit) => {
            const off = bus.on('tab:change', (ev) => {
              if (input?.tabId && ev.tabId !== input.tabId) return;
              emit.next(ev);
            });
            return () => off();
          }),
        ),
      onCreated: t.procedure
        .input(z.object({ windowId: z.string().optional() }).optional())
        .subscription(({ input }) =>
          observable<{
            tab: { id: string; ownerKey?: string; url: string; title: string; favicon?: string; createdAt: number; lastVisitedAt: number; stateStoreKey?: string; presentation?: 'embedded' | 'popup'; openerTabId?: string };
            windowId: string | null;
            openerTabId: string | null;
          }>((emit) => {
            const off = bus.on('tab:created', (ev) => {
              if (input?.windowId && ev.windowId !== input.windowId) return;
              emit.next(ev);
            });
            return () => off();
          }),
        ),
      onMoved: t.procedure.subscription(() =>
        observable<{
          tabId: string;
          from: { windowId: string } | null;
          to: { windowId: string } | null;
        }>((emit) => {
          const off = bus.on('tab:moved', (ev) => emit.next(ev));
          return () => off();
        }),
      ),
    }),

    navigation: t.router({
      goto: t.procedure
        .input(z.object({ tabId: z.string(), url: z.string() }))
        .mutation(async ({ input }) => {
          try {
            await tabs.navigate(input.tabId, input.url);
            return { ok: true as const };
          } catch (e) {
            const notFound = tabNotFoundResult(e);
            if (notFound) return notFound;
            toTRPCError(e);
          }
        }),
      back: t.procedure
        .input(z.object({ tabId: z.string() }))
        .mutation(({ input }) => {
          try {
            tabs.back(input.tabId);
            return { ok: true as const };
          } catch (e) {
            const notFound = tabNotFoundResult(e);
            if (notFound) return notFound;
            toTRPCError(e);
          }
        }),
      forward: t.procedure
        .input(z.object({ tabId: z.string() }))
        .mutation(({ input }) => {
          try {
            tabs.forward(input.tabId);
            return { ok: true as const };
          } catch (e) {
            const notFound = tabNotFoundResult(e);
            if (notFound) return notFound;
            toTRPCError(e);
          }
        }),
      reload: t.procedure
        .input(
          z.object({
            tabId: z.string(),
            ignoreCache: z.boolean().optional().default(false),
          }),
        )
        .mutation(({ input }) => {
          try {
            tabs.reload(input.tabId, input.ignoreCache);
            return { ok: true as const };
          } catch (e) {
            const notFound = tabNotFoundResult(e);
            if (notFound) return notFound;
            toTRPCError(e);
          }
        }),
      stop: t.procedure
        .input(z.object({ tabId: z.string() }))
        .mutation(({ input }) => {
          try {
            tabs.stopLoading(input.tabId);
            return { ok: true as const };
          } catch (e) {
            const notFound = tabNotFoundResult(e);
            if (notFound) return notFound;
            toTRPCError(e);
          }
        }),
      onLifecycle: t.procedure
        .input(z.object({ tabId: z.string().optional() }).optional())
        .subscription(({ input }) =>
          observable<{
            tabId: string;
            phase: 'loading' | 'loaded' | 'failed' | 'crashed';
            url?: string;
            error?: string;
          }>((emit) => {
            const off = bus.on('navigation:lifecycle', (ev) => {
              if (input?.tabId && ev.tabId !== input.tabId) return;
              emit.next(ev);
            });
            return () => off();
          }),
        ),
    }),

    overlays: t.router({
      create: t.procedure
        .input(
          z.object({
            windowId: z.string(),
            placement: anchorSchema,
            url: z.string(),
            transparent: z.boolean().optional().default(false),
            clickThrough: z.boolean().optional().default(false),
            preload: z.string().optional(),
          }),
        )
        .mutation(({ input }) => {
          try {
            return overlays.create(input);
          } catch (e) {
            toTRPCError(e);
          }
        }),
      createDetached: t.procedure
        .input(
          z.object({
            url: z.string(),
            transparent: z.boolean().optional().default(false),
            clickThrough: z.boolean().optional().default(false),
            preload: z.string().optional(),
          }),
        )
        .mutation(({ input }) => {
          try {
            return overlays.createDetached(input);
          } catch (e) {
            toTRPCError(e);
          }
        }),
      attach: t.procedure
        .input(z.object({ overlayId: z.string(), windowId: z.string(), placement: anchorSchema }))
        .mutation(({ input }) => {
          try {
            return overlays.attach(input.overlayId, input.windowId, input.placement);
          } catch (e) {
            toTRPCError(e);
          }
        }),
      detach: t.procedure
        .input(z.object({ overlayId: z.string() }))
        .mutation(({ input }) => {
          try {
            return overlays.detach(input.overlayId);
          } catch (e) {
            toTRPCError(e);
          }
        }),
      close: t.procedure
        .input(z.object({ overlayId: z.string() }))
        .mutation(({ input }) => {
          try {
            overlays.close(input.overlayId);
            return { ok: true as const };
          } catch (e) {
            toTRPCError(e);
          }
        }),
      move: t.procedure
        .input(z.object({ overlayId: z.string(), placement: anchorSchema }))
        .mutation(({ input }) => {
          try {
            overlays.move(input.overlayId, input.placement);
            return { ok: true as const };
          } catch (e) {
            toTRPCError(e);
          }
        }),
      setZ: t.procedure
        .input(z.object({ overlayId: z.string(), index: z.number() }))
        .mutation(({ input }) => {
          try {
            overlays.setZ(input.overlayId, input.index);
            return { ok: true as const };
          } catch (e) {
            toTRPCError(e);
          }
        }),
      list: t.procedure
        .input(z.object({ windowId: z.string().optional() }).optional())
        .query(({ input }) => overlays.listInfo(input?.windowId)),
    }),

    history: t.router({
      query: t.procedure
        .input(
          z.object({
            tabId: z.string().optional(),
            limit: z.number().optional(),
            since: z.number().optional(),
            search: z.string().optional(),
          }),
        )
        .query(({ input }) => historyStore.query(input)),
      delete: t.procedure
        .input(z.object({ entryIds: z.array(z.string()) }))
        .mutation(async ({ input }) => {
          await historyStore.delete(input.entryIds);
          return { ok: true as const };
        }),
      clear: t.procedure
        .input(z.object({ tabId: z.string().optional() }))
        .mutation(async ({ input }) => {
          if (input.tabId) await historyStore.deleteFor(input.tabId);
          else await historyStore.delete([]); // no-op for memory-based; consumers may implement differently
          return { ok: true as const };
        }),
    }),

    _debug: t.router({
      whoami: t.procedure.query(({ ctx }) => ctx.caller),
    }),
  });
}

export type AppRouter = ReturnType<typeof createRouter>;

// tRPC v11's server-side caller type isn't easily extracted via public types.
// Consumers who want precise types on renderer-side RPC calls should use
// `CreateTRPCProxyClient<AppRouter>` from `@trpc/client`. For main-process
// callers we keep the type loose; runtime behavior is fully typed via
// `inferRouterInputs<AppRouter>` / `inferRouterOutputs<AppRouter>`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AppCaller = any;
