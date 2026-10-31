# Mini App Client API

The Host injects `window.mcode` into the managed Mini App's main page through Electron preload.
Check that the required method exists before calling it: older Hosts, ordinary Browser tabs, and
standalone browsers do not provide this bridge. Client APIs are separate from Node's
`start(context)`; see [runtime-api.md](runtime-api.md) for that context.

No npm SDK, HTTP bridge, Session ID, or plugin ID is needed, and a model is optional. A declaration file only
describes the injected values; it does not create the bridge or grant permissions.

## Type-checking setup

For TypeScript or checked JavaScript, copy [client-api.ts](client-api.ts) beside the Client source,
for example at `miniapp/client/client-api.ts`. Include it in the Client's TypeScript configuration;
its `Window` declaration makes the optional `window.mcode` property known to the compiler. Plain
HTML/JavaScript pages that do not use type checking can call the bridge without copying this file.

TypeScript may also load the declarations with a type-only import:

```ts
import type { McodeClientAPI } from './client-api.js';

const host: McodeClientAPI | undefined = window.mcode;
```

Checked JavaScript can use a JSDoc type reference:

```js
/** @typedef {import('./client-api.js').McodeClientAPI} McodeClientAPI */
```

Both references are for type checking only. Do not load `client-api.ts` with a script tag or add a
runtime import of `client-api.js`. Keep the `.ts` filename because Electron dependency packaging
filters out `.d.ts` assets. Node code continues to use `miniapp-api.ts`, not the Client
declarations.

## `miniapp.message.append(text)`

Use `window.mcode.miniapp.message.append(text)` from a user-activated Client button. The Host shows
its own confirmation dialog with the plugin, target conversation, and text. On confirmation, the
text is appended to that conversation's chat input. The user can edit it and must press the chat
input's Send button to start an Agent turn.

This bridge only appends to the unsent draft after confirmation. Mini Apps cannot insert, edit, or
delete sent chat messages or rewrite the Agent's conversation context. The `message` namespace does
not grant access to chat history.

### Button example

```js
/**
 * @param {string} text
 * @param {HTMLButtonElement} button
 * @param {HTMLElement} status
 */
async function askAgent(text, button, status) {
  const message = window.mcode?.miniapp?.message;
  if (!message?.append) {
    status.textContent = 'This Host does not support adding text to the chat input.';
    return;
  }
  button.disabled = true;
  try {
    await message.append(text);
    status.textContent = 'Added to the chat input. Review it there and press Send.';
  } catch (error) {
    const code = error && typeof error === 'object' && 'message' in error ? error.message : '';
    if (code === 'user_cancelled') {
      status.textContent = 'Cancelled. Nothing was added.';
    } else if (code === 'result_unknown') {
      status.textContent =
        'Check the chat input before trying again; the text may already be there.';
    } else {
      status.textContent = 'Could not add the text. Check the conversation and try again.';
    }
  } finally {
    button.disabled = false;
  }
}
```

Localize these example labels for the page. Make the destination clear in the button label, such as
“Ask Agent”; never claim that the Agent has started just because this promise succeeded.

### Behavior and errors

- `text` is a string of plain text, at most 100,000 UTF-16 code units per call. Spaces, tabs, and
  newlines are accepted and appended literally; include any desired separating newline in `text`.
  HTML-looking text stays text. An empty string also requires confirmation and leaves the draft
  unchanged when confirmed.
- The append preserves existing draft text, rich-text nodes, references, and attachments.
- Every call requires confirmation. There is no remembered grant or automatic submission. Valid
  calls are confirmed in order, not rejected merely because another request is pending. Cancelling
  one call does not cancel the next one. The example disables only its initiating button to avoid
  accidental duplicate actions; other calls can still be made.
- Main checks the managed page, main frame, and actual origin when accepting a request. The origin
  comes from Electron, not a field the page supplies. A site loaded after navigating away from the
  Mini App cannot use its identity to request an append.
- A valid Mini App still needs an explicit destination. Without a target conversation or Host
  receiver, the call rejects with `target_unavailable`; the Host does not create a conversation or
  fall back to the current conversation or the home draft. This also applies to a future standalone
  Mini App page without a destination.
- Once accepted, the Host handles the captured text and fixed destination. It does not repeatedly
  check the Mini App's visibility or runtime while waiting for confirmation, and does not perform
  another Main authorization after confirmation.
- The Host updates the draft through its existing draft interface, whether or not the input is
  mounted. Read-only or unavailable conversations cannot be targeted.
- The call ends when the confirmed append completes. Later editing, composition, voice input, undo,
  length handling, sending, and clearing remain the chat input's responsibility; this API does not
  wait for or coordinate those flows.
- The returned `Promise<void>` waits for the user's decision without an automatic confirmation
  timeout and resolves only after the Host completes the confirmed append. It is not an Agent reply,
  a persistent business result, or a guarantee that the draft has reached disk. A missing reply when
  the Host document ends can return `result_unknown`; never automatically repeat the append.

Cancellation or failure rejects with an `Error` whose `message` is one of `user_cancelled`,
`invalid_request`, `text_too_large`, `not_allowed`, `target_unavailable`, or `result_unknown`.
Errors contain no chat history or existing draft content.

### Business results are separate

If the Agent should update a table, card, or other business object, provide the requested MCP tools
as described in [mcp.md](mcp.md). Use stable business IDs in the request and tools; let the page
read the resulting business state through its own Node service. Users may edit, combine, or delete
the appended instructions, so a draft append is not a reliable request-to-turn correlation ID.

The bridge does not expose raw IPC or Node capabilities. Keep third-party scripts out of the trusted
main document: code running there, including a same-origin frame that can reach its parent, shares
the page's trust. Cross-origin frames cannot invoke the Host bridge as themselves.

## `miniapp.agent`

`window.mcode.miniapp.agent` runs Agent turns for the page and returns their final reply; Node code
uses `context.agent` from [runtime-api.md](runtime-api.md) instead. Calls reject with
`not_permitted` unless the manifest declares `agentAccess: ["session.run"]`; the Host resolves the
plugin from the tab, never from the call. A new session uses the agent of the chat session the Mini
App is open in, with its full capabilities (files, shell, Skills, and MCP including this Mini App's
own); Node-initiated runs, and pages not opened from a session, use the primary Agent unless `agent`
is passed (see `agents()` below); continuing a session keeps its agent. The Agent works in the project directory of that chat when the chat has
one; otherwise, and for Node-initiated runs, it works in this Mini App's own Agent directory; a
continued session keeps its directory. A new session takes the model and thinking level of the chat
it was created from (the runtime default when the chat has none or the session is Node-created), and
keeps them. `run` / `answer` may pass `model` to switch the session's model first; the Host
validates it the way the composer validates a new session's model (the model must be one the user can
see in `models()`) and rejects an unusable one with `invalid_request` / `INVALID_ARGUMENTS`. A model
whose BYOK credentials are missing is accepted here, and the turn then ends with `status: 'error'`.
Results and `turn.started` carry the model the turn was dispatched with. Up to `agentConcurrency`
runs (default 4) per Mini App run at once, one per session; further `run` / `answer` calls wait in
order, up to four times that many.

For business prompt construction and per-call UI state, follow
[agent-interaction.md](agent-interaction.md). The methods and events below define the Host contract.

### Interaction

The Mini App renders the Agent's interaction itself, or lets the Host do it with `open`. Two
interactions block a turn, and each maps to one event and one reply:

- `permission.requested` → `reply`: a tool call waits for approval. Decide it with `allowOnce` or
  `deny`; there is no `allowAlways`, because a Mini App does not write the user's global rules.
- `question.requested` → `answer`: the turn paused on a questionnaire (`ask_user`, a feature enable,
  or a Plan review). `request` is the same questionnaire the Host chat renders; the answer starts
  the continuation turn, which you observe like `run`.

A permission request waits only while someone can answer it: (a) the run that owns the session
passed `onEvent` (page or Node), or (b) the session is currently shown in a chat side panel through
`open`. Otherwise it is denied, and the model is told that nobody can
answer it and should continue without the tool. Where the session was created does not count: a
session started from a chat does not wait on its own. Closing the side panel tab ends (b); from then
on the page or Node code must handle `permission.requested` itself or call `open` again. A
questionnaire nobody listens to ends the turn with `result.pendingQuestion`; continue with `answer`.
A page that passes `onEvent` must handle `permission.requested` itself (or `open` the session so the
user can answer in the side panel); an unhandled request waits until `cancel` or the page closes.
A page that passes no `onEvent` is judged by (b) alone. There is no timeout: a waiting run is
released by cancel or abort, process exit, or republish.

```js
/** @typedef {import('./client-api.js').MiniAppAgentQuestionnaire} MiniAppAgentQuestionnaire */
/** @typedef {import('./client-api.js').MiniAppAgentQuestionAnswer} MiniAppAgentQuestionAnswer */

let activeSummaryId = '';

/**
 * @param {string} text
 * @param {HTMLElement} output
 * @param {(request: MiniAppAgentQuestionnaire) => Promise<MiniAppAgentQuestionAnswer[]>} askUser
 *   Renders the questionnaire in this page and resolves with one answer per step.
 * @param {(toolName: string, reason: string) => Promise<boolean>} confirmTool
 *   Asks the user in this page whether the tool may run once.
 */
async function summarizeWithAgent(text, output, askUser, confirmTool) {
  const agent = window.mcode?.miniapp?.agent;
  if (!agent) {
    output.textContent = 'This Host does not support the Agent API.';
    return;
  }
  activeSummaryId = `summary-${Date.now()}`;
  let streamed = '';
  /** @param {import('./client-api.js').MiniAppAgentRunEvent} event */
  const onEvent = (event) => {
    if (event.type === 'permission.requested') {
      // The run waits for this decision; the event names the session even on its first run.
      void confirmTool(event.toolName, event.reason)
        .then((allowed) =>
          agent.reply({
            sessionId: event.sessionId,
            requestId: event.requestId,
            decision: allowed ? 'allowOnce' : 'deny',
          }),
        )
        .catch(() => {}); // request_not_found: the run was cancelled meanwhile.
      return;
    }
    // Show the reply as it streams; ignore event types this page does not use.
    if (event.type !== 'text.delta') return;
    streamed += event.text;
    output.textContent = streamed;
  };
  try {
    let result = await agent.run({ text, requestId: activeSummaryId }, { onEvent });
    // The turn paused on a questionnaire. Answer only after the run resolves: until then it
    // holds the session's single-run slot.
    while (result.pendingQuestion) {
      const answers = await askUser(result.pendingQuestion.request);
      streamed = '';
      result = await agent.answer(
        {
          sessionId: result.sessionId,
          questionId: result.pendingQuestion.requestId,
          answers,
          requestId: activeSummaryId,
        },
        { onEvent },
      );
    }
    output.textContent = result.text ?? `Agent ended: ${result.status}`;
  } catch (error) {
    const code = error && typeof error === 'object' && 'message' in error ? error.message : '';
    output.textContent =
      code === 'result_unknown' ? 'Result unknown; check before asking again.' : `Failed: ${code}`;
  } finally {
    activeSummaryId = '';
  }
}

function stopSummary() {
  if (activeSummaryId) window.mcode?.miniapp?.agent?.cancel(activeSummaryId);
}
```

- `run({ text, sessionId?, model?, agent?, requestId? }, { onEvent? })` resolves with
  `{ sessionId, turnId, model?, status, text?, error?, pendingQuestion? }` when the turn ends. Pass
  `sessionId` back to continue that conversation. `text` is at most 100,000 UTF-16 code units.
  `model` is `{ providerId, modelId, variant?, thinking?: { effort } }`, taken from `models()`
  (`variant: ''` means thinking is off; it is a real value and is preserved, so pass it back as is);
  `model` in the result is the one the turn was dispatched with. `agent` is accepted only when
  starting a session (see `agents()`).
- `requestId` is optional; supply one when the page may need `cancel(requestId)`. Reusing an id that
  is still running rejects with `busy`. `cancel` on an unknown or finished id does nothing; a
  cancelled run resolves with `status: 'aborted'` only when the Host confirmed the abort. Otherwise
  it rejects with `cancelled` (nothing ran) or `result_unknown` (the abort was not confirmed).
- `reply({ sessionId, requestId, decision })` decides a `permission.requested` while its run is
  still waiting; `requestId` is the event's and `decision` is `allowOnce` or `deny`.
- `answer({ sessionId, questionId, answers, model?, requestId? }, { onEvent? })` answers the questionnaire
  `questionId` (the `requestId` of `question.requested` or `result.pendingQuestion`; both carry the
  questionnaire as `request`). `answers` holds one
  `{ stepId, selectedOptionIds, selectedOther, otherText?, skipped? }` per step; `requestId` is your
  id for `cancel`, as in `run`. It resolves like `run`; when the answer was recorded but the
  continuation turn was not observed, it rejects with `result_unknown`. Call it after the paused
  `run` resolves: that run still holds the session's single-run slot while `question.requested` is
  delivered, so an earlier `answer` rejects with `busy`. `answer({ model })` switches the session's
  model before the questionnaire lookup, so a `request_not_found` answer still leaves the model
  switched.
- `open(sessionId)` shows that session as a tab in the side panel of the chat the Mini App is open
  in. The user can read the conversation there and answer its permission and question cards, so a
  page may let the Host handle the interaction by opening the tab instead of rendering
  `permission.requested` and `question.requested` itself. Permission requests wait for the tab only
  while it stays open; after the user closes it, handle the events yourself or call `open` again.
  When the Host window reloads or closes, the Host reports its tabs closed for you. The tab is not
  remembered across a runtime restart or the deletion of the host chat; call `open` again then.
  `open` is idempotent, so retrying after `runtime_unavailable` or `result_unknown` is safe. Any
  session this Mini App owns can be opened, whichever chat created it; it rejects with
  `session_not_found` otherwise, and with `not_permitted` when the Mini App is not open inside a
  chat.
- `models()` returns the available model catalog `models[]`, the runtime `default`, and the optional
  `host` selection when opened from a chat (the default when the chat has none). `default` and
  `host` are selections ready to pass as `model` to `run` / `answer`. To select a catalog entry
  `option`, construct `{ providerId: option.providerId, modelId: option.modelId }` and add a
  selected `variant` if needed. If the model supports thinking and the user selects an effort from
  `option.thinking.efforts`, pass `thinking: { effort }`. The catalog's
  `thinking: { efforts, default? }` describes capabilities; the request takes
  `thinking: { effort }`. Preserve `variant: ''`: it explicitly turns thinking off. `models()`
  rejects with `invalid_request` / `INVALID_ARGUMENTS` when the runtime has no usable default model.
- `agents()` lists the agents the user has configured (`name`, `displayName`, `primary`).
  `create({ agent })` or a first `run({ agent })` starts the session as that agent instead of the
  chat's; `name` must come from this list, and the alias `main` is rejected. A session never changes
  its agent, so continuing with `agent` is `invalid_request` — create a new session to hand work to
  another agent. The plugin directory follows the chosen agent; the project directory and model are
  unaffected.
- `create({ agent? })` creates a session bound to this chat when the Mini App is open in a chat
  (agent, project directory, model); from a tab without a host chat it creates with the plugin
  directory and the runtime default model. It runs no turn and returns its `sessionId`; hand it to your Node code to continue the
  session there. It takes no run slot. If the call hits the Host's 60 s deadline it rejects with
  `runtime_unavailable` although the session may already exist.
- `onEvent` receives progress events `{ type, sessionId, turnId, ... }`. Every event except
  `run.queued` names its session, so `reply` works before the `run` that created the session
  returns. Ignore any `type` you do not know; new types may be added.
  - `run.queued` — all run slots are taken, so the call waits; `position` is its 1-based place in
    line. Sent once, before the turn starts: it has no `turnId`, and carries `sessionId` only when
    the call continues a session.
  - `turn.started` — the Agent began the turn; `model` is the model it was dispatched with.
  - `text.delta` — `text` is the next piece of the reply as it streams.
  - `message.committed` — `text` is one complete assistant message; a turn can have several.
  - `tool.started` — the Agent called the tool `name`.
  - `tool.finished` — that tool returned; `ok` is `false` when it failed.
  - `permission.requested` — the tool `toolName` waits for `reply`; carries `requestId`, `reason`,
    and `toolInput?`. When the Agent delegated to a child session, the child's asks arrive here with
    the child's own `sessionId` and `turnId`; `reply` with those and do not filter events by the
    root turn, or the run waits forever.
  - `question.requested` — sent just before `turn.finished` when the turn paused; carries
    `requestId`, `mode` (`questionnaire`, `feature-enable`, or `plan`), and `request`, whose `steps`
    each have an `id`, a `question`, `selectionMode`, and `options`; `request.modePayload` holds the
    Plan review Markdown.
  - `turn.finished` — always last; carries the same `status`, `text?`, and `error?` as the result.
- Reloading or closing the page cancels its active runs. Too many concurrent runs reject with
  `busy`.
- Failures reject with an `Error` whose `message` is `invalid_request`, `not_permitted`, `busy`,
  `session_not_found`, `runtime_unavailable`, `cancelled`, `result_unknown`, or `request_not_found`
  (the permission request or questionnaire is unknown or already settled). After `result_unknown`
  the turn may already have run; never repeat it automatically. It also covers a turn that ended
  (its `turn.finished` was delivered) when the Host could not tell whether a question is pending.
  `runtime_unavailable` means nothing was started; retry later. A page left over from a Mini App
  process that has since restarted also gets it.

## `miniapp.window` (proposed)

**Proposed:** this namespace's shape may still change. Feature-detect with
`window.mcode?.miniapp?.window` before use; do not assume it is present or stable long-term.

`window.mcode.miniapp.window` is a handle for this Mini App's own window: whether it is inline in
the File Panel or popped out, and — only when popped out — its position, size, and a few Electron
window flags. It is a separate namespace from `message`; both are injected together.

```ts
const handle = window.mcode?.miniapp?.window;
if (handle) {
  const state = await handle.getState();
  console.log(handle.id, state.mode); // 'inline' | 'window'
  await handle.update({ mode: 'window', width: 900, height: 650 }); // from a user gesture
  handle.onDidChangeState((next) => console.log(next.mode));
}
```

### Behavior and errors

- `id` is a stable opaque string, unrelated to any Session or launch identifier. It does not change
  when the page pops out or returns to the File Panel.
- `getState()` resolves `{ mode: 'inline' }` while the page sits in the File Panel, or
  `{ mode: 'window', window: {...} }` with the current geometry and flags while popped out.
- `update(patch)` accepts a partial patch of `mode`, `width`, `height`, `x`, `y`, `visible`,
  `resizable`, `alwaysOnTop`, `clickThrough`, and `skipTaskbar`. Every field is optional and omitted
  fields are left unchanged. `frame`, `transparent`, `minWidth`, and `minHeight` can only be
  declared in the manifest's `surface.window`; a runtime patch that includes them always rejects.
  `x`/`y` are screen coordinates of the window's content area, not its outer frame.
- Changing `mode`, or calling `focus()`, requires the call to originate from a user gesture (an
  event handler where `navigator.userActivation.isActive` is still true, such as a synchronous click
  handler). Without one, both reject with `not_permitted` before any Host round trip.
- Multiple `update()` calls made within the same animation frame are merged (later fields win) into
  a single Host round trip; every caller in that frame shares that frame's single outcome —
  including a shared rejection when the merged patch is rejected. A patch that changes `mode` is
  sent immediately instead, so it does not lose its user-gesture window.
- `x`/`y` are rejected with `not_permitted` when the resulting window would not overlap any current
  display. `width`/`height` are rejected with `not_permitted` when the manifest declared or the
  window is currently `resizable: false`. `alwaysOnTop: true` and `clickThrough: true` are rejected
  with `not_permitted` unless the manifest's `surface.window` already declares that field `true`;
  see [package-contract.md](package-contract.md).
- `onDidChangeState(listener)` calls `listener` with the current state after a successful `update()`
  and periodically while the state changes for another reason (for example, the user dragging or
  closing the popped-out window). It returns `{ dispose() }`; call `dispose()` to stop listening,
  such as on `pagehide`.
- Rejections are an `Error` whose `message` is one of `inline_mode`, `not_permitted`, `busy`,
  `result_unknown`, or `invalid_request`. `inline_mode` means the page is inline and the patch
  included a field other than `mode`. `busy` means a `mode` switch for this page is already in
  flight. `result_unknown` covers a Host-side failure or a missing reply; the actual window state at
  that point is unconfirmed. `invalid_request` covers a non-object patch, an unrecognized field, a
  wrong-typed value, a non-finite number, a `width`/`height` at or below `0` or above `10000`, or an
  `x`/`y` beyond ±100000.

### Pitfalls

| Setting or call              | Pitfall                                                                                                                                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frame: false`               | Removes the OS title bar and its built-in drag region; without an app-defined drag region (a CSS `-webkit-app-region: drag` area) the user cannot move the window.                                                                                       |
| `transparent: true`          | Only removes the window's own background; the page's own DOM background must also be transparent (for example, a transparent `<body>`) or it will paint over the transparency.                                                                           |
| `transparent: true` | Host disables the native shadow for transparent windows (`hasShadow: false`) to avoid a gray outline around their rectangular bounds. For shadows, use CSS `box-shadow` and leave transparent padding around the content. |
| Content-driven window size | Window size stays fixed as content grows. Use `html, body { height: 100%; overflow: hidden }` and scroll inside an area such as `main { flex: 1; min-height: 0; overflow: auto }`. For a larger window, use `update({ height })`. |
| `clickThrough: true`         | Turn it on only for the specific state where the page wants to be visible but not intercept clicks (for example, a translucent overlay with margins); leaving it on the rest of the time makes the whole window unclickable, including its own controls. |
| `update({ visible: false })` | Hides the window, but the page's JavaScript keeps running; it is not equivalent to closing the page or pausing timers, network requests, or media.                                                                                                       |
| Window title                 | Always follows the manifest's `displayName` (or `pluginId`); it cannot be changed at runtime through this handle.                                                                                                                                        |
