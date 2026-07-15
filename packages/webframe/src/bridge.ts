import { ipcMain, type WebContents } from 'electron';
import type { Unsubscribable } from '@trpc/server/observable';
import type { AppCaller, AppRouter } from './router';
import type { Caller } from './types';

export const RPC_CHANNEL = 'webframe/rpc';
export const SUB_START_CHANNEL = 'webframe/sub-start';
export const SUB_STOP_CHANNEL = 'webframe/sub-stop';
export const SUB_EVENT_CHANNEL = 'webframe/sub';

type RPCOp = {
  path: string;
  type: 'query' | 'mutation';
  input?: unknown;
};

type SubStartOp = {
  subId: string;
  path: string;
  input?: unknown;
};

type SubStopOp = { subId: string };

type SubEnvelope =
  | { subId: string; type: 'data'; data: unknown }
  | { subId: string; type: 'error'; error: { code?: string; message: string } }
  | { subId: string; type: 'complete' };

type SerializedError = { code?: string; message: string; stack?: string };

type TrpcCaller = AppCaller;

export class CallerRegistry {
  private map = new Map<number, Caller>();

  registerChrome(wcId: number, windowId: string) {
    this.map.set(wcId, { kind: 'chrome', windowId });
  }
  registerOverlay(wcId: number, overlayId: string, windowId: string) {
    this.map.set(wcId, { kind: 'overlay', overlayId, windowId });
  }
  registerTab(wcId: number, tabId: string) {
    this.map.set(wcId, { kind: 'tab', tabId });
  }
  unregister(wcId: number) {
    this.map.delete(wcId);
  }
  get(wcId: number): Caller {
    return this.map.get(wcId) ?? { kind: 'main' };
  }
}

function traverse(caller: TrpcCaller, path: string): unknown {
  return path.split('.').reduce<unknown>((obj, key) => {
    if (obj == null) return undefined;
    if (typeof obj !== 'object' && typeof obj !== 'function') return undefined;
    return (obj as Record<string, unknown>)[key];
  }, caller);
}

type BridgeDeps = {
  router: AppRouter;
  createCaller: (ctx: { caller: Caller }) => TrpcCaller;
  registry: CallerRegistry;
  logger: { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
};

/**
 * The bridge owns per-WebContents subscription state so that subscription
 * teardown happens automatically on renderer destruction.
 */
export class Bridge {
  private subs = new Map<WebContents, Map<string, Unsubscribable>>();
  private disposed = false;

  constructor(private deps: BridgeDeps) {
    ipcMain.handle(RPC_CHANNEL, (event, op: RPCOp) => this.handleRPC(event.sender, op));
    ipcMain.handle(SUB_START_CHANNEL, (event, op: SubStartOp) =>
      this.handleSubStart(event.sender, op),
    );
    ipcMain.handle(SUB_STOP_CHANNEL, (event, op: SubStopOp) =>
      this.handleSubStop(event.sender, op),
    );
  }

  callerForWebContents(wc: WebContents): Caller {
    return this.deps.registry.get(wc.id);
  }

  /** For subscription count queries (test helper). */
  subCount(wcId: number): number {
    for (const [wc, m] of this.subs) {
      if (wc.id === wcId) return m.size;
    }
    return 0;
  }

  private createCaller(caller: Caller): TrpcCaller {
    return this.deps.createCaller({ caller });
  }

  private async handleRPC(sender: WebContents, op: RPCOp) {
    const caller = this.createCaller(this.callerForWebContents(sender));
    const fn = traverse(caller, op.path);
    if (typeof fn !== 'function') {
      throw new Error(`webframe/rpc: procedure '${op.path}' not found`);
    }
    try {
      return await (fn as (i: unknown) => Promise<unknown>).call(null, op.input);
    } catch (err) {
      throw rpcError(op, serializeError(err));
    }
  }

  private async handleSubStart(sender: WebContents, op: SubStartOp): Promise<{ ok: true }> {
    const caller = this.createCaller(this.callerForWebContents(sender));
    const fn = traverse(caller, op.path);
    if (typeof fn !== 'function') {
      throw new Error(`webframe/sub: procedure '${op.path}' not found`);
    }
    let result: unknown;
    try {
      result = (fn as (i: unknown) => unknown).call(null, op.input);
      // tRPC v11 subscription callers return Promise<Observable>.
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        result = await (result as Promise<unknown>);
      }
    } catch (err) {
      sendSub(sender, {
        subId: op.subId,
        type: 'error',
        error: serializeError(err),
      });
      return { ok: true };
    }
    if (!result || typeof (result as { subscribe?: unknown }).subscribe !== 'function') {
      sendSub(sender, {
        subId: op.subId,
        type: 'error',
        error: { message: `'${op.path}' is not a subscription` },
      });
      return { ok: true };
    }
    const subscription = (result as {
      subscribe: (o: {
        next: (data: unknown) => void;
        error: (err: unknown) => void;
        complete: () => void;
      }) => Unsubscribable;
    }).subscribe({
      next: (data) => sendSub(sender, { subId: op.subId, type: 'data', data }),
      error: (err) =>
        sendSub(sender, { subId: op.subId, type: 'error', error: serializeError(err) }),
      complete: () => sendSub(sender, { subId: op.subId, type: 'complete' }),
    });

    let perSender = this.subs.get(sender);
    if (!perSender) {
      perSender = new Map();
      this.subs.set(sender, perSender);
      const cleanup = () => {
        const m = this.subs.get(sender);
        if (!m) return;
        for (const s of m.values()) {
          try {
            s.unsubscribe();
          } catch {
            // ignore
          }
        }
        this.subs.delete(sender);
      };
      sender.once('destroyed', cleanup);
    }
    perSender.set(op.subId, subscription);
    return { ok: true };
  }

  private handleSubStop(sender: WebContents, op: SubStopOp): { ok: true } {
    const perSender = this.subs.get(sender);
    const sub = perSender?.get(op.subId);
    if (sub) {
      try {
        sub.unsubscribe();
      } catch {
        // ignore
      }
      perSender!.delete(op.subId);
    }
    return { ok: true };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const perSender of this.subs.values()) {
      for (const s of perSender.values()) {
        try {
          s.unsubscribe();
        } catch {
          // ignore
        }
      }
    }
    this.subs.clear();
    ipcMain.removeHandler(RPC_CHANNEL);
    ipcMain.removeHandler(SUB_START_CHANNEL);
    ipcMain.removeHandler(SUB_STOP_CHANNEL);
  }
}

function sendSub(sender: WebContents, env: SubEnvelope) {
  try {
    if (!sender.isDestroyed()) sender.send(SUB_EVENT_CHANNEL, env);
  } catch {
    // ignore
  }
}

function serializeError(err: unknown): SerializedError {
  if (err && typeof err === 'object') {
    const e = err as { code?: string; message?: string; stack?: string; cause?: unknown };
    return {
      code: e.code,
      message: e.message ?? String(err),
      stack: e.stack,
    };
  }
  return { message: String(err) };
}

function rpcError(op: RPCOp, error: SerializedError): Error {
  const code = error.code ? `${error.code}: ` : '';
  const message = `webframe/rpc ${op.type} ${op.path} failed: ${code}${error.message}; input=${stringifyForLog(op.input)}`;
  const out = new Error(message);
  out.stack = error.stack ?? out.stack;
  Object.assign(out, { code: error.code, rpcPath: op.path, rpcType: op.type, rpcInput: op.input });
  return out;
}

function stringifyForLog(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (!json) return String(value);
    return json.length > 1000 ? `${json.slice(0, 1000)}...` : json;
  } catch {
    return '[unserializable]';
  }
}
