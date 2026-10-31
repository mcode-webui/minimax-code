# Domain docs

How the engineering skills should consume this repo's domain documentation when exploring the
codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repository root — the project's single glossary. Read the entries that
  cover the area you are about to touch.
- **`packages/webui/docs/adr/`** — the architecture decision log. Read the decisions that touch your
  area; ADR 0016 and ADR 0017 describe the client as it stands, and [`../README.md`](../README.md)
  lists the four records that have been retired.
- **`packages/webui/docs/README.md`** — the index of this package's current technical documentation:
  architecture, client, runtime, design, verification, gaps and reference material.

If a file does not exist, **proceed silently**. Don't flag its absence; don't suggest creating it
upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and
`/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

This repository is single-context:

```
/
├── AGENTS.md                        ← agent rules
├── CONTRIBUTING.md                  ← contributor workflows and the skills index
├── CONTEXT.md                       ← the glossary — the only domain-language file
└── packages/webui/docs/
    ├── README.md                    ← index and reading order
    ├── adr/                         ← the decision log
    ├── agents/                      ← this directory: issue tracker, triage labels, domain docs
    ├── architecture/  client/  runtime/  design/  verification/
    └── reference/                   ← generated and machine-read lists
```

The log's numbering is the decision order: the highest number is the newest. A decision that is
partly amended or remains relevant as history can record that status in its own `Status:` line. Retire
a decision that is no longer in force, as described in [`../README.md`](../README.md).

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test
name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly
avoids — each entry lists them under _Avoid_.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language
the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR 0004 (the WebUI owns its WebSocket transport, loopback-only), but worth reopening because…_

A contradiction with a decision in force is a reason to write a new ADR that supersedes it, not a
reason to leave the old one standing.
