# Session And Communication

Use this doc for session lifecycle, history, status semantics, rotation, and how delegated work
reports back. Session operations go through the native `mavis` tool.

## Session Operations

```text
mavis({ command: "session list", args: { agent_name: "me", limit: 20 } })
mavis({ command: "session get", args: { session_id: "<sessionId>" } })
mavis({ command: "session messages", args: { session_id: "<sessionId>", limit: 20 } })
mavis({ command: "session send", args: { session_id: "<sessionId>", content: "<message>" } })
mavis({ command: "session send", args: { session_id: "<sessionId>", content: "<message>", sync: true } })
mavis({ command: "session update", args: { session_id: "<sessionId>", title: "<title>" } })
mavis({ command: "session delete", args: { session_id: "<sessionId>" } })
```

- `session list` also accepts `parent_session_id` (list children of a session) and
  `archive_filter: "Unarchived" | "Archived"`, plus `cursor` / `limit` pagination.
- `session update` accepts `title` and `archived`.
- `session messages` returns role, timestamp, message ID, content preview, tool calls; use `before`
  with the returned cursor to page backwards.
- `session send` delivers one message to an existing unarchived local session. It trims the content
  and returns as soon as the message is admitted, reporting what the target did with it: `started`
  or `activated` (a new Turn is running), `queued` (it runs after the current Turn, with the queue
  position), or `steered` / `duplicate` (merged into the Turn already running). A busy target never
  fails — it queues or merges.
- `session send` accepts two optional switches:
  - `sync: true` waits for the admitted Turn to finish and returns its assistant text. A merged
    message (`steered` / `duplicate`) has no completion of its own, so it still answers with the
    admission and says so in `note`; read the outcome with `session messages`.
  - `force_steer: true` always merges into the running Turn. Without it, routing follows the desktop
    composer send preference (queue by default, steer when the user switched it).
- Decide on `sync` before sending. Once a message is admitted, sending it again does not wait for
  it — it delivers a second message and makes the target do the work twice. Read the reply of an
  acknowledged message with `session messages` instead.
- `session send` is not restricted by session topology: a task child, an ordinary branch, a root
  session, or another agent's local session are all valid targets as long as the id resolves and the
  session is not archived. Sending to your own session merges into or queues behind the turn making
  the call. Inspect uncertain outcomes with `session get` or `session messages`; do not replay a
  mutation automatically.
- Call `mavis({ command: "session help" })` for the full arg reference.

## Rotation

Rotation archives the current session and starts a fresh one seeded with a handoff summary.

- Rotation is **user- or trigger-initiated** — the user presses the rotate button in the app UI, or
  an external automation calls `POST /api/agent/:name/session/:sessionId/request-rotation`.
- Either way, the runtime injects a rotation turn into the owning session: that session writes a
  concise handoff (Goal / Progress / Modified Files / Key Decisions / Open Questions / Next Steps)
  and the runtime completes the swap.
- There is no tool command to rotate; if the user asks to reset the conversation, point them to the
  rotate action in the app UI.

## Session Status Semantics

Five states (`SessionStatus` as exposed by the local-runtime session API). Status is a state label.
In particular, `finished` means idle after a turn, **not closed**. A finished session can still
receive new messages and resume work. The table describes the existing generic communication
delivery; `session send` follows the same queue/steer admission documented above.

| Status        | Set by                    | Process alive?                            | Send                                         |
| ------------- | ------------------------- | ----------------------------------------- | -------------------------------------------- |
| `started`     | bridge before each turn   | yes                                       | accepted (queued / preempts per source-lock) |
| `finished`    | bridge on terminal event  | yes                                       | accepted                                     |
| `interrupted` | runtime-restart recovery  | yes                                       | accepted                                     |
| `aborted`     | abort request (UI / API)  | yes (abort = interrupt request, not kill) | accepted                                     |
| `error`       | bridge on `session.error` | maybe                                     | likely fails — check logs                    |

`aborted` vs `interrupted`: same effect, different trigger (user vs recovery).

## Delegation and Result Reporting

- Delegate parallelizable or context-heavy subwork to **sub-agent tasks** (the task tool). The
  result comes back as the task result, which carries both a `task_id` and, once the child exists,
  its `session_id`.
- Two entry points continue the same delegation, and they are not interchangeable:
  - `task_append({ task_id, content })` is asynchronous. It returns an admission acknowledgement
    (`activated` / `steered` / `duplicate`) with a `task_id`, not a result; read the work later with
    `task_output(task_id)` once `<background-task-finished>` wakes the conversation.
  - `mavis({ command: "session send", args: { session_id, content } })` targets any reachable
    session, not just your own task children. It is asynchronous by default and returns the same
    kind of admission acknowledgement; add `sync: true` when the reply itself blocks your next
    decision, and it then returns that Turn's assistant text.
- Prefer `task_append` for a task you own, and `session send` for a session you do not own or when
  you need the reply with `sync: true`. Create a new task only for independent work that needs a
  fresh context.
- Local direct task children return their result normally. The runtime delivers foreground results,
  background completion, `session send` completion (when `sync: true` was requested), and
  `task_append` results; the child does not
  send a second report to its parent. Cloud `communicate` and the existing local `team-plan:` path
  retain their current behavior.
- Large payload rule: do not inline large blobs in task prompts or results. Write them to a
  scratchpad file and pass only the path + a short summary.

## Use This Doc When

- you need session history, lifecycle, or status semantics
- you need to explain or trigger rotation
- you need to structure delegated work and its result reporting
