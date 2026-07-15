import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Extension, ServiceWorkerInfo, Session } from 'electron';
import { WebframeError } from './types';

export type ExtensionInput =
  | string
  | {
      path: string;
      allowFileAccess?: boolean;
    };

export type LoadedExtensionInfo = {
  id: string;
  name: string;
  path: string;
};

export type ExtensionDiagnosticEvent =
  | { type: 'extension-loaded'; extension: LoadedExtensionInfo }
  | { type: 'extension-ready'; extension: LoadedExtensionInfo }
  | { type: 'service-worker-registration-completed'; scope: string }
  | { type: 'service-worker-console-message'; level: number; message: string; sourceUrl: string; lineNumber: number }
  | { type: 'extension-load-failed'; path: string; error: string };

export type ExtensionDiagnostics = {
  loaded: LoadedExtensionInfo[];
  events: ExtensionDiagnosticEvent[];
};

export type ExtensionDebugInfo = ExtensionDiagnostics & {
  serviceWorkers: Record<number, ServiceWorkerInfo>;
};

export function createExtensionDiagnostics(): ExtensionDiagnostics {
  return { loaded: [], events: [] };
}

type NormalizedExtension = {
  path: string;
  allowFileAccess?: boolean;
};

function normalizeExtension(input: ExtensionInput): NormalizedExtension {
  if (typeof input === 'string') return { path: input };
  return input;
}

export async function loadWebframeExtensions(opts: {
  session: Session;
  sessionSource: string | Session;
  extensions?: ExtensionInput[];
  diagnostics?: ExtensionDiagnostics;
  logger?: { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
}): Promise<LoadedExtensionInfo[]> {
  const inputs = opts.extensions ?? [];
  if (inputs.length === 0) return [];

  const diagnostics = opts.diagnostics ?? createExtensionDiagnostics();
  installExtensionDiagnostics(opts.session, diagnostics, opts.logger);

  if (typeof opts.sessionSource === 'string' && !opts.sessionSource.startsWith('persist:')) {
    throw new WebframeError(
      'EXTENSIONS_REQUIRE_PERSISTENT_SESSION',
      'extensions require a persistent Electron session partition',
    );
  }

  if (typeof opts.session.isPersistent === 'function' && !opts.session.isPersistent()) {
    throw new WebframeError(
      'EXTENSIONS_REQUIRE_PERSISTENT_SESSION',
      'extensions require a persistent Electron session',
    );
  }

  if (typeof opts.session.loadExtension !== 'function') {
    throw new WebframeError(
      'EXTENSIONS_UNSUPPORTED_SESSION',
      'selected Electron session does not support extension loading',
    );
  }

  const loaded: LoadedExtensionInfo[] = [];
  for (const input of inputs) {
    const ext = normalizeExtension(input);
    if (!path.isAbsolute(ext.path)) {
      throw new WebframeError('EXTENSION_PATH_INVALID', `extension path must be absolute: ${ext.path}`);
    }
    const stat = await fs.stat(ext.path).catch(() => null);
    if (!stat?.isDirectory()) {
      throw new WebframeError('EXTENSION_PATH_INVALID', `extension path must be an existing directory: ${ext.path}`);
    }

    let result: Extension;
    try {
      result = await opts.session.loadExtension(
        ext.path,
        ext.allowFileAccess === undefined ? undefined : { allowFileAccess: ext.allowFileAccess },
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      diagnostics.events.push({ type: 'extension-load-failed', path: ext.path, error: message });
      opts.logger?.error('extension load failed', { path: ext.path, error: message });
      throw e;
    }
    loaded.push({ id: result.id, name: result.name, path: result.path });
  }

  diagnostics.loaded = loaded;
  return loaded;
}

export function collectExtensionDebugInfo(
  session: Session,
  diagnostics: ExtensionDiagnostics,
): ExtensionDebugInfo {
  return {
    loaded: diagnostics.loaded.map((ext) => ({ ...ext })),
    events: diagnostics.events.map((event) => ({ ...event })),
    serviceWorkers: session.serviceWorkers?.getAllRunning?.() ?? {},
  };
}

function installExtensionDiagnostics(
  session: Session,
  diagnostics: ExtensionDiagnostics,
  logger?: { warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void },
): void {
  const marker = session as Session & { __webframeExtensionDiagnosticsInstalled?: boolean };
  if (marker.__webframeExtensionDiagnosticsInstalled) return;
  marker.__webframeExtensionDiagnosticsInstalled = true;

  if (typeof session.on !== 'function') return;

  session.on('extension-loaded', (_event, extension) => {
    const info = toLoadedExtensionInfo(extension);
    diagnostics.events.push({ type: 'extension-loaded', extension: info });
    logger?.warn('extension loaded', info);
  });
  session.on('extension-ready', (_event, extension) => {
    const info = toLoadedExtensionInfo(extension);
    diagnostics.events.push({ type: 'extension-ready', extension: info });
    logger?.warn('extension ready', info);
  });
  session.serviceWorkers?.on?.('registration-completed', (_event, details) => {
    diagnostics.events.push({
      type: 'service-worker-registration-completed',
      scope: details.scope,
    });
    logger?.warn('extension service worker registered', details);
  });
  session.serviceWorkers?.on?.('console-message', (_event, details) => {
    diagnostics.events.push({
      type: 'service-worker-console-message',
      level: details.level,
      message: details.message,
      sourceUrl: details.sourceUrl,
      lineNumber: details.lineNumber,
    });
    const scope = (details as { scope?: string }).scope;
    if (scope?.startsWith('chrome-extension://') || details.sourceUrl?.startsWith?.('chrome-extension://')) {
      const levelName = ['verbose', 'info', 'warn', 'error'][details.level] ?? String(details.level);
      logger?.warn('extension service worker console', {
        level: levelName,
        message: details.message,
        sourceUrl: details.sourceUrl,
        lineNumber: details.lineNumber,
        scope,
      });
    }
  });
}

function toLoadedExtensionInfo(extension: Extension): LoadedExtensionInfo {
  return { id: extension.id, name: extension.name, path: extension.path };
}
