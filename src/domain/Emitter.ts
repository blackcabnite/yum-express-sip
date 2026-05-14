// Emitter — typed pub/sub for layer boundaries.
//
// Each layer (Transport, RealtimeSession, CallSession) exposes its own
// Emitter<Events>. Listeners are type-safe per event name. ~40 lines.

export type Listener<T> = (payload: T) => void;
export type Unsubscribe = () => void;

export class Emitter<Events> {
  private listeners: { [K in keyof Events]?: Set<Listener<Events[K]>> } = {};

  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): Unsubscribe {
    let set = this.listeners[event];
    if (!set) {
      set = new Set();
      this.listeners[event] = set;
    }
    set.add(fn);
    return () => {
      this.listeners[event]?.delete(fn);
    };
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners[event];
    if (!set) return;
    // Snapshot so unsubscribes mid-iteration don't break us.
    for (const fn of Array.from(set)) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[Emitter] handler for "${String(event)}" threw:`, err);
      }
    }
  }

  clear(): void {
    this.listeners = {};
  }
}
