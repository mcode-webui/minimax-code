# Shared WebUI event corpus

The `@mavis/local-runtime-v2` maintainers own this corpus. Add a fixture by recording one harness `SessionStreamFrame` shape and documenting the expected client projection outcome in the same JSON file. When the harness event protocol changes, update this corpus and the WebUI projection tests in the same review cycle; the corpus standardises input data, while each client keeps its own reducer implementation.

Usage is intentionally not represented by a fixture here. The shared global-event registry has no usage-bearing wire event (in particular, there is no `turn.finished` event). Both clients derive usage from completed message arrays, so usage coverage belongs in the projection test's message fixture rather than in a fabricated event frame.
