// A turn's stream writer, built from the store writer that owns the record.
//
// The sink is built **inside** this factory from the writer's own `setStream`, so
// the generation fence travels with the writer instead of being a convention the
// caller has to honour, and the home→session migration rebuilds the whole writer
// rather than swapping a field.

import { buildWebuiStreamLoopSink } from "./stream-loop-sink.js";
import type { WebuiTurnCommandWriter } from "../contracts/turn-command-views.js";
import type { WebuiStreamState } from "../projection/stream-state.js";
import { createWebuiTurnLifecycleCommands } from "./turn-lifecycle-commands.js";

export function createWebuiTurnCommands(writer: {
  readonly kind: "session" | "home";
  readonly setStream: (
    update: (current: WebuiStreamState) => WebuiStreamState,
  ) => void;
  readonly setSending: (sending: boolean) => void;
  readonly migrateToSession?: (sessionId: string) => {
    readonly kind: "session";
    readonly setStream: (
      update: (current: WebuiStreamState) => WebuiStreamState,
    ) => void;
    readonly setSending: (sending: boolean) => void;
  };
}): WebuiTurnCommandWriter {
  const lifecycle = createWebuiTurnLifecycleCommands({
    setStream: writer.setStream,
    setSending: writer.setSending,
  });
  return {
    kind: writer.kind,
    // The attempt's sink, built from this writer's own `setStream`: the fence
    // travels with the writer instead of being a convention the caller honours.
    createSink: (options) => buildWebuiStreamLoopSink(writer.setStream, undefined, options),
    resetStreamForTurn: lifecycle.resetStreamForTurn,
    setStreamRefusal: lifecycle.setStreamRefusal,
    setTurnSending: lifecycle.setTurnSending,
    ...(writer.migrateToSession
      ? {
          migrateToSession: (sessionId: string) =>
            createWebuiTurnCommands(writer.migrateToSession!(sessionId)),
        }
      : {}),
  };
}
