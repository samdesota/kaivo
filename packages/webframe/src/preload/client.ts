import type { IpcRenderer } from 'electron';

type SubEnvelope =
  | { subId: string; type: 'data'; data: unknown }
  | { subId: string; type: 'error'; error: { code?: string; message: string } }
  | { subId: string; type: 'complete' };

type SubCallbacks = {
  onData?: (d: unknown) => void;
  onError?: (e: { code?: string; message: string }) => void;
  onComplete?: () => void;
};

/**
 * Build a concrete, non-Proxy object matching the AppRouter shape. We avoid
 * Proxy because `contextBridge.exposeInMainWorld` cannot transfer Proxy
 * objects across the isolated-world boundary. The shape below mirrors the
 * router defined in src/router.ts and must be kept in sync with it.
 */
export function createWebframeClient(ipcRenderer: IpcRenderer): unknown {
  const subCallbacks = new Map<string, SubCallbacks>();

  ipcRenderer.on('webframe/sub', (_evt, env: SubEnvelope) => {
    const cb = subCallbacks.get(env.subId);
    if (!cb) return;
    if (env.type === 'data') cb.onData?.(env.data);
    else if (env.type === 'error') cb.onError?.(env.error);
    else if (env.type === 'complete') cb.onComplete?.();
  });

  let subCounter = 0;

  const q = (path: string) => ({
    query: (input?: unknown) =>
      ipcRenderer.invoke('webframe/rpc', { path, type: 'query', input }),
  });
  const m = (path: string) => ({
    mutate: (input?: unknown) =>
      ipcRenderer.invoke('webframe/rpc', { path, type: 'mutation', input }),
  });
  const s = (path: string) => ({
    subscribe: (input: unknown, opts: SubCallbacks) => {
      const subId = `sub-${++subCounter}`;
      subCallbacks.set(subId, opts);
      void ipcRenderer.invoke('webframe/sub-start', { subId, path, input });
      return {
        unsubscribe: () => {
          subCallbacks.delete(subId);
          void ipcRenderer.invoke('webframe/sub-stop', { subId });
        },
      };
    },
  });

  return {
    windows: {
      list: q('windows.list'),
      get: q('windows.get'),
      setSlots: m('windows.setSlots'),
      onResize: s('windows.onResize'),
    },
    tabs: {
      create: m('tabs.create'),
      close: m('tabs.close'),
      move: m('tabs.move'),
      detach: m('tabs.detach'),
      setActive: m('tabs.setActive'),
      list: q('tabs.list'),
      get: q('tabs.get'),
      onChange: s('tabs.onChange'),
      onCreated: s('tabs.onCreated'),
      onMoved: s('tabs.onMoved'),
    },
    navigation: {
      goto: m('navigation.goto'),
      back: m('navigation.back'),
      forward: m('navigation.forward'),
      reload: m('navigation.reload'),
      stop: m('navigation.stop'),
      onLifecycle: s('navigation.onLifecycle'),
    },
    overlays: {
      create: m('overlays.create'),
      createDetached: m('overlays.createDetached'),
      attach: m('overlays.attach'),
      detach: m('overlays.detach'),
      close: m('overlays.close'),
      move: m('overlays.move'),
      setZ: m('overlays.setZ'),
      list: q('overlays.list'),
    },
    history: {
      query: q('history.query'),
      delete: m('history.delete'),
      clear: m('history.clear'),
    },
    _debug: {
      whoami: q('_debug.whoami'),
    },
  };
}
