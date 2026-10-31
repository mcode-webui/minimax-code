// The Models provider editor's React edge, published as a public module.
//
// One editor per Usage page visit, hosted *above* the
// `sourceTab === "custom"` conditional so switching source tabs does not
// discard a draft and so the editor's memory of "this draft was tested"
// survives the panel unmounting. The component that calls this hook
// therefore owns the lifetime: it disposes on its own unmount, which is
// leaving the Usage category or unmounting Settings.
//
// The commands are read through a live facade rather than captured, because
// the composition builds the workflow's command object per render and an
// editor that captured one instance would drive a stale closure after the
// first re-render.
//
// The settings business mounts this hook from its "用量与模型" page; the
// models business's own consumers (the test suite, the application owner
// that builds the editor when the page is mounted) reach for the
// `createWebuiProviderEditor` factory and its types directly through the
// application sibling. Neither business owns the React edge, so neither
// may re-implement the hook, and both move here to the publication marker.
//
// This module is `.public` because the settings business needs the provider
// editor hook to render and re-render its usage page. The `.public` suffix
// is a publication marker; the live-facade discipline, the
// unmount-disposes rule, and the memoization are unchanged.

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import {
  createWebuiProviderEditor,
  type WebuiProviderEditor,
  type WebuiProviderEditorCommands,
  type WebuiProviderEditorSnapshot,
} from "../application/provider-editor.js";

export interface WebuiProviderEditorHandle {
  readonly editor: WebuiProviderEditor;
  readonly snapshot: WebuiProviderEditorSnapshot;
}

export function useWebuiProviderEditor(
  commands: WebuiProviderEditorCommands,
): WebuiProviderEditorHandle {
  const commandsRef = useRef(commands);
  commandsRef.current = commands;

  const editor = useMemo(() => {
    const live: WebuiProviderEditorCommands = {
      get canManageProviders() {
        return commandsRef.current.canManageProviders;
      },
      revealApiKey: (providerId) => commandsRef.current.revealApiKey(providerId),
      createProvider: (body) => commandsRef.current.createProvider(body),
      updateProvider: (body) => commandsRef.current.updateProvider(body),
      deleteProvider: (providerId) => commandsRef.current.deleteProvider(providerId),
      discoverCandidate: (body) => commandsRef.current.discoverCandidate(body),
      saveCandidate: (body) => commandsRef.current.saveCandidate(body),
      testCandidate: (body) => commandsRef.current.testCandidate(body),
    };
    return createWebuiProviderEditor({ commands: live });
  }, []);

  const snapshot = useSyncExternalStore(
    editor.subscribe,
    editor.getSnapshot,
    editor.getSnapshot,
  );

  useEffect(() => () => editor.dispose(), [editor]);

  return { editor, snapshot };
}
