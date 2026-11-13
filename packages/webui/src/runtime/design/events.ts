import type { WebuiRuntimeEvent } from "../../shared/contracts/stream.js";

/** One subscribed event channel per application; no browser polling for open commands. */
export function createDesignEvents() {
  const listeners = new Set<(event: WebuiRuntimeEvent) => void>();
  return {
    publish(type: "design.open" | "design.changed", payload: Record<string, unknown>) {
      const event: WebuiRuntimeEvent = { type, payload, timestamp: Date.now(), source: "webui-design" };
      for (const listener of listeners) listener(event);
    },
    watch(signal?: AbortSignal): AsyncIterable<WebuiRuntimeEvent> {
      return { [Symbol.asyncIterator]() {
        const pending: WebuiRuntimeEvent[] = [];
        let waiting: ((result: IteratorResult<WebuiRuntimeEvent>) => void) | undefined;
        let closed = signal?.aborted === true;
        const listener = (event: WebuiRuntimeEvent) => {
          if (waiting) { const resolve = waiting; waiting = undefined; resolve({ done: false, value: event }); }
          else pending.push(event);
        };
        const close = () => { closed = true; listeners.delete(listener); signal?.removeEventListener("abort", close); waiting?.({ done: true, value: undefined }); waiting = undefined; };
        if (!closed) { listeners.add(listener); signal?.addEventListener("abort", close, { once: true }); }
        return {
          next(): Promise<IteratorResult<WebuiRuntimeEvent>> {
            if (closed) return Promise.resolve({ done: true, value: undefined });
            if (pending.length) return Promise.resolve({ done: false, value: pending.shift()! });
            return new Promise((resolve) => { waiting = resolve; });
          },
          return() { close(); return Promise.resolve({ done: true as const, value: undefined }); },
        };
      } };
    },
  };
}

export function mergeDesignEvents(host: AsyncIterable<WebuiRuntimeEvent>, design: AsyncIterable<WebuiRuntimeEvent>, signal?: AbortSignal): AsyncIterable<WebuiRuntimeEvent> {
  return { async *[Symbol.asyncIterator]() {
    const iterators = [host[Symbol.asyncIterator](), design[Symbol.asyncIterator]()];
    const next = (index: number) => iterators[index].next().then((result) => ({ index, result }));
    const pending = new Map(iterators.map((_, index) => [index, next(index)]));
    try {
      while (pending.size && !signal?.aborted) {
        const { index, result } = await Promise.race(pending.values());
        if (result.done) { pending.delete(index); continue; }
        pending.set(index, next(index));
        yield result.value;
      }
    } finally {
      await Promise.allSettled(iterators.map((iterator) => iterator.return?.()));
    }
  } };
}
