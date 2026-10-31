// Retired host implementation, declared once and enforced by two different checks.
//
// The two checks have different domains and must not be collapsed into one list:
// `check:source` inspects the files that exist in this repository, while
// `check:standalone` inspects the input graph of the produced bundle. A path
// therefore belongs to exactly one of the two sets below.

// Must not exist as public source at all. Enforced by `check:source`.
export const retiredSourceRoots = [
  "packages/agent-modules/team/",
  "packages/agent-modules/permission/src/confirmation-gateway-client.ts",
  "packages/tui/src/auth/identity.ts",
  "packages/local-runtime/src/messages/queue-serialization.ts",
  "packages/local-runtime/src/workspace-indexing/",
  "packages/local-runtime-v2/src/service/workspace/indexing.ts",
  "packages/local-runtime-v2/src/application/conversation/workspace-snapshot-gate.ts",
  "packages/agent-tools/src/desktop/local-workspace-semantic-search.ts",
  "packages/thrift-gen/",
  "packages/thrift-gen-client/",
  "packages/local-runtime/src/http/",
  "packages/local-runtime-v2/src/http/",
  "packages/protocol/src/generated/",
  "packages/local-runtime-v2/src/service/session-handoff/",
  // The model picker's cascade. It was two popups — a list and a fly-out —
  // with a dismissal listener each, and the fly-out's listener claimed the
  // pointerdown that was meant for a model row, so the row was retracted
  // before the click landed. The picker is one popup with two states now, and
  // the pieces below are not coming back: a second popup is what made the
  // picker feel broken.
  "packages/webui/src/client/features/models/ui/ModelSettingsFlyout.tsx",
  "packages/webui/src/client/features/models/ui/ModelDraftEditor.tsx",
  "packages/webui/src/client/features/models/ui/ModelMenu.tsx",
  "packages/webui/src/client/features/models/projection/model-picker-cascade.ts",
  "packages/webui/src/client/features/models/projection/model-picker-hover.ts",
  "packages/webui/src/client/features/models/projection/model-favorites.ts",
  "packages/webui/src/client/features/models/projection/model-picker-search.ts",
  "packages/webui/src/client/features/models/bindings/use-model-picker-interaction.ts",
  // The composer's brain. The thinking level moved into the picker, where the
  // model it belongs to is on screen: a second control for the same state is
  // a second thing to disagree with the first.
  "packages/webui/src/client/features/composer/ui/ThinkingTrigger.tsx",
];

// May exist as public source, but must never be reachable from the standalone
// build. Enforced by `check:standalone`.
export const nonBundledSources = [
  "packages/local-runtime/src/services/cu/native.ts",
];

// Anything retired from the source tree must also stay out of the build graph, so
// the boundary check enforces both sets. Declaring the union here keeps a path
// that later becomes publishable from silently losing its bundle restriction.
export const retiredBuildInputs = [
  ...retiredSourceRoots,
  ...nonBundledSources,
];
