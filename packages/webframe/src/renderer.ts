// Type-only exports for renderer-side code (chrome, overlay, tab preload consumers).
// This module intentionally has no runtime surface.
export type { AppRouter } from './router';
export type {
  Rect,
  Slot,
  Anchor,
  TabRecord,
  HistoryEntry,
  WindowInfo,
  OverlayInfo,
  Caller,
  LifecyclePhase,
  LifecycleEvent,
  TabChangeEvent,
  TabMovedEvent,
  ResizeEvent,
} from './types';

/**
 * Shape of the `window.webframe` object exposed by webframe's preload scripts.
 * Consumers can augment their global Window type to reference this.
 */
export type WebframeGlobal = {
  trpc: WebframeTrpcClient;
  identity: () => Promise<import('./types').Caller>;
};

/**
 * A minimal typed client shape matching what webframe's preload exposes.
 * It mirrors (a subset of) tRPC's client proxy, typed against AppRouter.
 */
// We keep this deliberately loose at the type level — the runtime client is a
// hand-rolled proxy, not the full @trpc/client. Consumers who want strict types
// can cast to `CreateTRPCProxyClient<AppRouter>` from '@trpc/client'.
export type WebframeTrpcClient = unknown;
