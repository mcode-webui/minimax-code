# Session creation and submission

Every way a session can be created — ordinary send, goal, installed plugin, session rail — reaches
the same application use case (`client/application/task-session-workflows.ts`). The use case decides
the workspace rule, the created identity, the guarded adoption and the committed navigation, so no
surface decides these for itself. Its outcome names the target and whether the caller should select
it; a submission while the same home is already creating is refused as `busy` with the input left
untouched.

## The vocabulary

`client/features/turn/contracts/submission.ts` is the authority. One submission is one intent
classified by one decision and closed by one completion.

- **Intent** — what the user asked for, before any decision: `{message, attachmentCount, sessionId?}`.
- **Decision** — what admission concluded: `dispatching`, `queued`, `needs-session`,
  `creation-failed`, `busy`, `unsupported`, `failed`. `busy` covers both reasons a live target
  refuses input: a creation already in flight for this home, and a turn already running with nowhere
  to queue it.
- **Completion** — how it ended, and **never a rejection**: `dispatched {sessionId, created}`,
  `queued {sessionId}`, or one of the refusals `busy {reason: creating|turn-live}`,
  `unsupported {missing: create-session|transport}`, `needs-session`,
  `creation-failed {error}`, `failed {error}`. A refusal is a value so the caller can report it and
  keep going; a rejected promise would make the refusal path the exception path.
- **Adoption transfer** (`client/application/session-store.ts`): `transferred`, `target-exists`,
  `purged`, `stale-source`. A destination that already has state wins; a purged destination is never
  resurrected; a superseded source incarnation is refused as `stale-source`.

`client/features/turn/application/composer-submission.ts` derives the decision from the completion so
the two cannot disagree, and returns the submission's record; callers consume the transition that
comes with it.

## What the adoption guarantees

The transfer is the reason late results cannot corrupt a new selection: state only moves onto a
destination that is still the live one. The rules the use case holds:

1. The workspace rule is decided once, from the creation origin and the current selection — never by
   the surface that asked.
2. Creation is single-flight per home incarnation; a second submission during a creation is refused
   as busy and its input is left untouched.
3. The created session is selected only while the navigation claim that started the creation is
   still current.
4. A destination with its own state wins over the carried-over state; the carried state is dropped,
   not merged.
5. A purged destination is never written to, so a deleted session cannot be resurrected by a late
   result.
6. A source whose incarnation has been superseded is refused (`stale-source`) rather than retargeted.
7. Home→session adoption moves the draft, the input history and the goal read together.
8. A failed creation leaves the draft and the history intact.

Submission-side field behaviour per Composer field is in [`composer.md`](composer.md).
