import { EventEmitter } from 'node:events';
import type {
  LifecycleEvent,
  ResizeEvent,
  TabCreatedEvent,
  TabChangeEvent,
  TabMovedEvent,
} from './types';

export type BusEvents = {
  'tab:created': [TabCreatedEvent];
  'tab:change': [TabChangeEvent];
  'tab:moved': [TabMovedEvent];
  'navigation:lifecycle': [LifecycleEvent];
  'window:resize': [ResizeEvent];
  'overlay:change': [{ overlayId: string; windowId: string }];
};

export class EventBus {
  private ee = new EventEmitter();

  constructor() {
    this.ee.setMaxListeners(1000);
  }

  emit<K extends keyof BusEvents>(event: K, ...args: BusEvents[K]): void {
    this.ee.emit(event, ...args);
  }

  on<K extends keyof BusEvents>(
    event: K,
    listener: (...args: BusEvents[K]) => void,
  ): () => void {
    this.ee.on(event, listener as (...args: unknown[]) => void);
    return () => this.ee.off(event, listener as (...args: unknown[]) => void);
  }
}
