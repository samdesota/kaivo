export type Rect = { x: number; y: number; w: number; h: number };

export type Slot = { name: string; rect: Rect };

export type Anchor =
  | { slot: string }
  | { edge: 'top' | 'bottom' | 'left' | 'right'; size: number }
  | Rect;

export type TabRecord = {
  id: string;
  ownerKey?: string;
  url: string;
  title: string;
  favicon?: string;
  createdAt: number;
  lastVisitedAt: number;
  stateStoreKey?: string;
  presentation?: 'embedded' | 'popup';
  openerTabId?: string;
};

export type HistoryEntry = {
  id: string;
  tabId: string;
  url: string;
  title: string;
  visitedAt: number;
};

export type WindowInfo = {
  id: string;
  bounds: Rect;
  slots: Slot[];
  tabIds: string[];
  overlayIds: string[];
};

export type OverlayInfo = {
  id: string;
  windowId: string | null;
  url: string;
  placement: Anchor | null;
  zIndex: number;
};

export type Caller =
  | { kind: 'main' }
  | { kind: 'chrome'; windowId: string }
  | { kind: 'overlay'; overlayId: string; windowId: string }
  | { kind: 'tab'; tabId: string };

export type LifecyclePhase = 'loading' | 'loaded' | 'failed' | 'crashed';

export type LifecycleEvent = {
  tabId: string;
  phase: LifecyclePhase;
  url?: string;
  error?: string;
};

export type TabChangeEvent = {
  tabId: string;
  patch: Partial<TabRecord>;
};

export type TabMovedEvent = {
  tabId: string;
  from: { windowId: string } | null;
  to: { windowId: string } | null;
};

export type TabCreatedEvent = {
  tab: TabRecord;
  windowId: string | null;
  openerTabId: string | null;
};

export type ResizeEvent = {
  windowId: string;
  w: number;
  h: number;
};

export class WebframeError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'WebframeError';
  }
}
