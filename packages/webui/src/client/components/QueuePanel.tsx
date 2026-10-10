import type { ReactElement } from "react";

import type { WebuiQueueItem } from "../../shared/contracts/queue.js";

/**
 * The messages waiting behind a running turn, and whether the queue is held.
 *
 * This was inline in `SessionComposer` and had no test at all, which is how
 * "Waiting messages" and "Remove" ended up inside an otherwise Chinese
 * composer: the list lived in component state, and the webui suite runs in
 * `environment: "node"` with no jsdom, so `renderToStaticMarkup` never runs
 * the effect that fills that state. Pulling the markup out makes it a pure
 * function of its props, which is the only way it can be checked here.
 *
 * The wording matters more than it looks. This panel appears exactly when the
 * user has sent something the runtime is not working on yet, and it is the
 * only place that says so. A heading that reads "Waiting messages" in an
 * otherwise Chinese composer is not a typo, it is the one surface the user
 * looks at to answer "did my message go anywhere?".
 */
export function WebuiQueuePanel({
  items,
  paused,
  onRemove,
}: {
  readonly items: readonly WebuiQueueItem[];
  readonly paused?: boolean;
  readonly onRemove?: (item: WebuiQueueItem) => void;
}): ReactElement | null {
  // Paused with nothing queued still gets the notice: the user hit stop and
  // the answer they need is that the rest is held, not gone. With no items and
  // no pause there is nothing to say, and an empty box would claim a queue
  // exists.
  if (items.length === 0 && !paused) return null;
  return (
    <section className="flex w-full flex-col gap-2" data-webui-queue-paused={paused ? "true" : undefined}>
      {paused ? (
        <span role="status" className="text-text_default_secondary text-size_12">
          队列已暂停
        </span>
      ) : null}
      {items.length > 0 ? (
        <div className="mt-3 flex w-full flex-col gap-2" data-webui-queue="true">
          <strong
            aria-label="排队消息"
            className="text-size_14"
            data-webui-queue-count={items.length}
          >
            排队消息（{items.length}）
          </strong>
          <ul role="list" className="flex w-full flex-col gap-2">
            {items.map((item) => (
              <li
                key={item.itemId}
                data-webui-queue-item={item.itemId}
                className="webui-card flex items-center gap-2 p-spacing_12"
              >
                <span className="min-w-0 flex-1 truncate text-size_14">
                  {item.content || item.itemId}
                </span>
                {/* Only a message the runtime has not picked up can be taken
                    * back out. The button appears on a running or finished row
                    * it would look operable and do nothing. */}
                {item.status === "queued" && onRemove ? (
                  <button
                    type="button"
                    className="webui-button-secondary text-size_12"
                    onClick={() => onRemove(item)}
                    data-webui-remove-queue-item={item.itemId}
                  >
                    移除
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
