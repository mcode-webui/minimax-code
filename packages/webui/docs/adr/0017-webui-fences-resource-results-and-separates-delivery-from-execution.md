# WebUI makes temporal ownership explicit across reads, delivery and settlement

**Status:** Accepted and implemented.

The current generic query helper fences by request key while writing an independently named result field; distinct keys can both remain current and overwrite one selected answer. View-registered event routes also suppress a goal commit when no session handler exists. Adopt resource-keyed owners or explicitly fenced selected slots, with permanent application-installed domain routes and independent owner incarnations. A result may commit only to its own live identity/generation; an invalidation is repaired only by a result covering its freshness revision.

Session interest consists of selected-view, secondary-consumer, delivery-attempt and command-settlement leases. Navigation releases only its own view lease. Accepted delivery and mutation/invalidation obligations retain their rights until completion, supersession, explicit detach or recorded failure; purge/application disposal revoke browser commit rights. Delivery detach never implicitly aborts host execution. Dormant construction and explicit start/dispose make these lifetimes testable without React; disposed instances cannot restart.

The alternatives were a generic global cache/event bus, view-lifetime controllers and indiscriminate background attachment. They obscure identity or introduce new ordering/replay obligations. Small shared request mechanics plus explicit business policy are sufficient. Keep the existing wire topology and public stream semantics, including acknowledgement being acceptance rather than a subscription barrier.

The rules described here — the resource-keyed owners and selected slots, the permanent domain routes, the four interest leases, the generation/incarnation/freshness fences and the separate Composer field transitions — are implemented; how they work today is in [`../client/ownership.md`](../client/ownership.md). Network service still receives client requests and returns responses/streams: only redundant in-process identity forwarding was deleted, retaining validation, optional-capability errors, receiver binding, projections and harness adaptation.
