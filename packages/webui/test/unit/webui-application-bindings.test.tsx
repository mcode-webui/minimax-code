// Smoke tests for the React bindings (plan §7.2).
//
// The bindings are the only place the application layer is allowed to touch
// React. These cases prove the two properties the ticket cares about from the
// component side: a component reads the application snapshot through the hook
// (it holds no store writer and no map of its own), and rendering components
// never opens another process-event channel — the coordinator remains the
// channel's sole consumer.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { createWebuiApplication } from "../../src/client/application/create-application.js";
import type { WebuiProcessEventChannel } from "../../src/client/application/event-channel.js";
import type { WebuiRuntimeEvent } from "../../src/shared/contracts/stream.js";
import type { WebuiClientSessionResumer } from "../../src/client/contracts/execution-port.js";
import {
  WebuiApplicationProvider,
  useWebuiApplicationSnapshot,
} from "../../src/client/bindings/application-context.js";
import {
  useWebuiSessionSending,
  useWebuiSessionStream,
} from "../../src/client/bindings/use-session-state.js";

function makeChannel() {
  const listeners = new Set<(event: WebuiRuntimeEvent) => void>();
  const channel: WebuiProcessEventChannel = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { channel, listenerCount: () => listeners.size };
}

function makeApplication() {
  const fake = makeChannel();
  const application = createWebuiApplication({
    openEventChannel: () => fake.channel,
    turns: {
      resumeSession: (async () => {}) as unknown as WebuiClientSessionResumer,
    },
  });
  return { application, channel: fake };
}

function Consumer({ sessionId }: { readonly sessionId: string }) {
  const snapshot = useWebuiApplicationSnapshot();
  const sending = useWebuiSessionSending(sessionId);
  const stream = useWebuiSessionStream(sessionId);
  return (
    <span>
      {`sessions:${snapshot.sessions.size} sending:${String(sending)} messages:${stream.messages.length}`}
    </span>
  );
}

describe("the React bindings", () => {
  it("reads the application snapshot through the hook", () => {
    const { application } = makeApplication();
    application.store.updateSession("s1", (current) => ({
      ...current,
      sending: true,
      stream: {
        ...current.stream,
        messages: [{ id: "m1", answer: "hi", thinking: "" }],
      },
    }));

    const html = renderToStaticMarkup(
      <WebuiApplicationProvider application={application}>
        <Consumer sessionId="s1" />
      </WebuiApplicationProvider>,
    );

    expect(html).toContain("sessions:1");
    expect(html).toContain("sending:true");
    expect(html).toContain("messages:1");
  });

  it("renders components without opening another channel", () => {
    const { application, channel } = makeApplication();
    expect(channel.listenerCount()).toBe(1);
    for (let i = 0; i < 3; i += 1) {
      renderToStaticMarkup(
        <WebuiApplicationProvider application={application}>
          <Consumer sessionId="s1" />
        </WebuiApplicationProvider>,
      );
    }
    // Still exactly one: components subscribe to the application snapshot, not
    // to the raw process-event channel.
    expect(channel.listenerCount()).toBe(1);
  });
});
