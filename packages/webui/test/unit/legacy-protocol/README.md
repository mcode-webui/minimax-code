# Frozen protocol baseline

The `webui-operation-wire-compatibility` suite compares the production operation
registry against the **pre-refactor implementation itself**, not against a
re-implementation of it. Everything in this directory is a byte-for-byte copy of
the original baseline commit:

```
source revision: 89907fb3 (docs(webui): add capability gaps documentation and update public source list)
```

`89907fb3` is the tree the refactor branched from: it is an ancestor of the
contract-separation merge `f92d0aaa`, and its `packages/webui/src/server/...`
files are identical to that merge's first parent, so it is the last state that
served the wire protocol before typed bindings replaced the forwarding handlers.

## Why the whole implementation is copied

An earlier revision of the suite reconstructed the baseline validators by hand.
That oracle was wrong in a way its own tests could not see: it approximated
`archiveSession` validation, special-cased the memory operations and accepted
every other body verbatim, so it answered `version` with `body: null`,
`archiveSession` with `archived: "yes"` and `getSession` with `{}` in a response
frame while the real baseline validator rejected all three with `invalid_body`.

Freezing the real modules removes that class of drift: the operation roster comes
from the frozen `createOperationRegistry`, the accept/reject decision comes from
the frozen descriptor validators, and the frames come from the frozen dispatcher.
The production binding tables no longer supply the corpus; they are only checked
*against* it.

The layout mirrors `packages/webui/src/`, so every intra-tree import specifier
(`../envelope.js`, `../port.js`, `./names.js`, `../terminal.js`,
`../commands/runner.js`, `../projections/index.js`) resolves unchanged. The
frozen tree is not compiled into the browser or server bundle: it is reachable
only from the test suite.

Nothing under `src/` imports this directory, and the suite is the only consumer.
When the wire contract is meant to change, this directory must not be edited —
the new behaviour is a deliberate divergence the comparison is designed to
surface, and it is recorded in the suite's expectations instead.

## Files

Blob id is `git rev-parse 89907fb3:<source path>` (first 12 digits), so any file
here can be re-verified against the baseline rather than trusted.

| Frozen path | Baseline source | Blob |
| --- | --- | --- |
| `client/contracts.ts` | `packages/webui/src/client/contracts.ts` | `c7d88ad19dfb` |
| `client/projection/message-parts.ts` | `packages/webui/src/client/projection/message-parts.ts` | `cdb2b58b2c38` |
| `server/commands/descriptors.ts` | `packages/webui/src/server/commands/descriptors.ts` | `c23ca48804f5` |
| `server/commands/runner.ts` | `packages/webui/src/server/commands/runner.ts` | `fe26c8dde975` |
| `server/envelope.ts` | `packages/webui/src/server/envelope.ts` | `ab55d0cd89e5` |
| `server/operation/agent-memory.ts` | `packages/webui/src/server/operation/agent-memory.ts` | `ce2790632cce` |
| `server/operation/common.ts` | `packages/webui/src/server/operation/common.ts` | `af3cab8b182a` |
| `server/operation/goal.ts` | `packages/webui/src/server/operation/goal.ts` | `9235668fcaa3` |
| `server/operation/interaction.ts` | `packages/webui/src/server/operation/interaction.ts` | `1d1251d09b3d` |
| `server/operation/memory-settings.ts` | `packages/webui/src/server/operation/memory-settings.ts` | `f5d297e2196f` |
| `server/operation/messages.ts` | `packages/webui/src/server/operation/messages.ts` | `a57f0ecf0de2` |
| `server/operation/names.ts` | `packages/webui/src/server/operation/names.ts` | `5080ad0a0db9` |
| `server/operation/operation-contract.ts` | `packages/webui/src/server/operation/operation-contract.ts` | `e1e25b8e8aa0` |
| `server/operation/operation-dispatch.ts` | `packages/webui/src/server/operation/operation-dispatch.ts` | `3d975f344b9c` |
| `server/operation/operation-handlers.ts` | `packages/webui/src/server/operation/operation-handlers.ts` | `1d88429aae5f` |
| `server/operation/operations.ts` | `packages/webui/src/server/operation/operations.ts` | `e05544049846` |
| `server/operation/permission-mode.ts` | `packages/webui/src/server/operation/permission-mode.ts` | `8592ea2ee168` |
| `server/operation/personalization.ts` | `packages/webui/src/server/operation/personalization.ts` | `55cbe1bb389e` |
| `server/operation/plugin-management.ts` | `packages/webui/src/server/operation/plugin-management.ts` | `bc3c44fecfc7` |
| `server/operation/provider.ts` | `packages/webui/src/server/operation/provider.ts` | `6a3f521f446f` |
| `server/operation/questionnaire.ts` | `packages/webui/src/server/operation/questionnaire.ts` | `53691f9a6bdd` |
| `server/operation/queue.ts` | `packages/webui/src/server/operation/queue.ts` | `ad0b7b28ba5a` |
| `server/operation/session.ts` | `packages/webui/src/server/operation/session.ts` | `41be07bb7ee7` |
| `server/operation/user-profile.ts` | `packages/webui/src/server/operation/user-profile.ts` | `69bc72a7013f` |
| `server/operation/workspace.ts` | `packages/webui/src/server/operation/workspace.ts` | `04aa24f5c9d9` |
| `server/port.ts` | `packages/webui/src/server/port.ts` | `1897348628c9` |
| `server/profile-files.ts` | `packages/webui/src/server/profile-files.ts` | `ed5c8dbc5e0e` |
| `server/projections/compaction.ts` | `packages/webui/src/server/projections/compaction.ts` | `df97e51f7b67` |
| `server/projections/context-snapshot.ts` | `packages/webui/src/server/projections/context-snapshot.ts` | `8b195a80fd48` |
| `server/projections/index.ts` | `packages/webui/src/server/projections/index.ts` | `858b50edee9b` |
| `server/projections/permissions.ts` | `packages/webui/src/server/projections/permissions.ts` | `13b90b7c2864` |
| `server/projections/usage.ts` | `packages/webui/src/server/projections/usage.ts` | `455817174ac3` |
| `server/terminal.ts` | `packages/webui/src/server/terminal.ts` | `14017c1e42f1` |
| `shared/plugin-management.ts` | `packages/webui/src/shared/plugin-management.ts` | `d0204c4097c5` |
