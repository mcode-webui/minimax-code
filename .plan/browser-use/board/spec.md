**Parent specification for the WebUI Browser Use programme — not an executable work item.**
The executable work items are the tickets listed under [Ticket board](#ticket-board) at the bottom of
this issue. Each ticket cites this issue as its parent.

Decision authority: [ADR 0019](https://github.com/mcode-webui/minimax-code/blob/main/packages/webui/docs/adr/0019-webui-browser-use-surfaces-and-external-browser-bridge.md)
in the repository (`packages/webui/docs/adr/0019-…md`). ADR 0019 is the sole decision record for
this feature; this issue and the tickets must not restate or reopen its decisions.

Development plan: `.plan/browser-use/browser-use-development-plan.md` in the working checkout. The plan is
workspace material and is deliberately not part of the published source projection.

## Problem Statement

A person using WebUI cannot drive a browser from it. The Agent can run browser tools, but the
person cannot see what the Agent is looking at and cannot take over the same page: the WebUI has an
adoption seam for a host-supplied browser provider, but neither the development server entry nor the
packaged production entry supplies one, there is no browser panel, and Settings has no browser
authorization controls. The person must also fall back on the isolated browser in another surface
where they cannot see or steer the session.

When the Agent works in the user's own already-logged-in Edge or Chrome, the person wants the Agent
to work in that browser — with their existing sessions and sign-in — and wants to watch and steer
the same tab. Today there is no supported way to reach a running Edge or Chrome at all, and the
documented workaround (launching with a remote-debugging port and handing over a CDP endpoint) is
not a product path.

The person also needs a clear answer to "what is the Agent allowed to do in my browser?": today no
browser-surface authorization exists, so there is nothing to grant, revoke, or audit.

## Solution

WebUI gains Browser Use as a host-owned runtime capability with two browser surfaces, both
authorised explicitly and both default-off:

1. **An isolated Chromium** rendered inside a WebUI workspace panel through a live image stream,
   with the person and the Agent operating the same browser session.
2. **The person's own Edge and Chrome**, reached through an installed browser extension that pairs
   with the WebUI over an authenticated loopback WebSocket bridge and controls the browser through
   the extension's debugger capability.

The panel shows the browser as images and forwards pointer, keyboard and text input; it never
iframes the target site. Browser tools and the panel address the same underlying session, so an
Agent action and the visible page state stay aligned. Each Agent run owns its own target
selection, and the panel follows the active run's target.

Four independent authorization switches decide what is allowed: isolated browser, Edge, Chrome, and
a separate **Full CDP access** switch for the provider's complete command set. All four default
off. A separate, per-browser, high-entropy pairing credential authenticates the extension;
turning a browser switch off revokes that credential and the connection immediately.

## User Stories

1. As a WebUI user, I want a browser panel in my workspace, so that I can see the page the Agent is working on.
2. As a WebUI user, I want the panel to show live images of the page rather than an embedded site, so that the panel works for any site the Agent visits.
3. As a WebUI user, I want to click in the panel, so that I can interact with the page the Agent is using.
4. As a WebUI user, I want to type into the panel, so that I can fill in forms alongside the Agent.
5. As a WebUI user, I want my click and the Agent's click to affect the same page, so that the panel and the Agent never disagree about what is on screen.
6. As a WebUI user, I want the panel to follow the Agent run I am looking at, so that I see that run's tab and not another run's tab.
7. As a WebUI user, I want each Agent run to keep its own tab, so that two concurrent runs do not fight over one browser target.
8. As a WebUI user, I want the Agent to re-find elements after it changes tab, so that it never acts on the previous page using a stale reference.
9. As a WebUI user, I want to switch to another authorized tab myself, so that I can steer the Agent to a different page.
10. As a WebUI user, I want to see every tab the extension can reach, with its browser, title, URL and connection state, so that I know what the Agent can choose.
11. As a WebUI user, I want to know which tab belongs to the active Agent run, so that I can tell my run apart from another.
12. As a WebUI user, I want to enable the isolated browser from Settings, so that I can give the Agent a browser of its own.
13. As a WebUI user, I want the isolated browser off by default, so that no browser starts until I ask for one.
14. As a WebUI user, I want the isolated browser to use its own throwaway profile, so that it cannot touch my real browser profile.
15. As a WebUI user, I want the isolated browser's process, profile and streams released when WebUI closes, so that nothing is left running.
16. As a WebUI user, I want to enable Edge and Chrome independently, so that I can use one browser and not the other.
17. As a WebUI user, I want a clear "install the extension" guidance when the extension is missing, so that I know what to do.
18. As a WebUI user, I want the extension to tell me when a permission is missing, so that a blocked tab is not a mystery.
19. As a WebUI user, I want the extension to pair automatically once I enable its browser, so that I am not asked to confirm a second time.
20. As a WebUI user, I want my Edge and Chrome authorizations to survive a restart, so that I do not re-pair every time.
21. As a WebUI user, I want turning a browser switch off to disconnect that browser immediately, so that the Agent loses access at once.
22. As a WebUI user, I want the old pairing credential to be refused after I turn the browser off, so that a stale extension cannot reconnect.
23. As a WebUI user, I want a separate Full CDP access switch, so that the Agent's deeper browser control is my explicit decision.
24. As a WebUI user, I want Full CDP access off by default, so that ordinary browsing is not silently powerful.
25. As a WebUI user, I want the Full CDP switch to describe that it grants diagnostic and internal browser capabilities, so that I know what I am granting.
26. As a WebUI user, I want ordinary browser operations to keep working when I turn Full CDP access off, so that I can narrow the grant without losing the feature.
27. As a WebUI user, I want a command the browser does not support to fail honestly, so that I am not told something worked when it did not.
28. As a WebUI user, I want a dropped extension connection to fail visibly instead of silently switching tabs, so that I can tell the Agent stopped acting.
29. As a WebUI user, I want the Agent's in-flight action to fail explicitly when the connection drops mid-action, so that I am not left with an uncertain result.
30. As a WebUI user, I want the browser connection to recover on its own after a brief drop, so that a transient hiccup does not end the run.
31. As a WebUI user, I want the extension's browser permission to be independent of my WebUI switch, so that granting one does not imply the other.
32. As a WebUI user, I want the extension identity checked at the bridge, so that no other extension can attach to my WebUI.
33. As a WebUI user, I want the WebUI's own origin policy to stay narrow, so that a web page cannot open a socket to my local WebUI.
34. As a WebUI user, I want a stable, readable error for every failure — no browser, no tabs, pairing required, reconnecting, target closed, stream failed, permission missing — so that I can act on it.
35. As a WebUI user, I want the Edge and Chrome builds to come from one shared extension source, so that the two browsers behave identically.
36. As a maintainer, I want the extension source in the public source projection with its own typecheck gate, so that it is reviewed like the rest of the repository.
37. As a maintainer, I want the Full CDP gate to live in the runtime/provider path, so that a client request cannot bypass it.
38. As a maintainer, I want pairing credentials in the operating system's secure store, so that a plaintext fallback can never exist.
39. As a maintainer, I want the browser authorization state to be independent of provider presence, so that "a provider exists" never means "the user authorized it".
40. As a maintainer, I want a capability matrix per browser, so that the documented capabilities match the browsers' real ones.

## Implementation Decisions

These are the decisions the implementation must honour. ADR 0019 holds the rationale; this list is
the operational summary, not a second decision record.

- **Two surfaces, one browser business.** The isolated Chromium and the extension-backed Edge and
  Chrome are both reached through one host-owned provider seam. Browser Use is a runtime capability
  with explicit configuration, not a WebUI plugin.
- **One Browser client business.** It owns browser target state, authorization and connection
  projections, browser commands and the shared target state used by the Agent and the panel.
  Settings and workspace surfaces consume its published contracts; they own no parallel state.
- **Extension as a separate workspace package.** The extension is a separate browser execution
  context with its own manifest, permissions, build target and verification surface, and it imports
  no WebUI client or Node runtime implementation module.
- **Dedicated extension admission path.** The existing WebSocket admission stays narrow and keeps
  rejecting extension origins. A separate authenticated upgrade path admits extensions, ahead of
  the generic handler, and it validates pairing credentials independently of any development-mode
  bypass.
- **Per-browser credential, challenge-response pairing.** Each browser has a distinct high-entropy
  credential. The WebUI side uses the operating system's secure credential store; the extension side
  uses extension local storage. A missing secure store is an explicit pairing failure.
- **Revocation on disable.** Turning a browser switch off revokes the credential, closes the
  sockets and rejects every copy of the old credential; turning it on creates a fresh credential
  and pairs again without a second confirmation.
- **Run-scoped targeting with generations.** Each Agent run owns its target selection. A selection
  carries a generation, so a changed target, a closed tab or a reconnect invalidates the element
  references that belonged to the previous page. Operations against one tab serialize; different
  tabs proceed independently.
- **Bounded reconnect, no uncertain replay.** A disconnect during an operation retries the
  connection within a bounded deadline and a pinned backoff schedule, keeping the exact target. At
  the deadline the operation fails explicitly and is not replayed. Background reconnection continues
  with a capped backoff while the browser switch stays on.
- **Two-mode CDP capability gate.** Ordinary Browser Use runs on a restricted command set. The
  separate Full CDP access switch exposes every command the active provider actually supports. The
  gate lives in the runtime/provider path, so a client request cannot bypass it. A command the
  provider does not support fails as unsupported and never falls back silently.
- **Both composition roots.** The development entry and the packaged production entry must supply
  the provider consistently. Validating only the development path does not prove the shipped path.
- **Panel is an image surface.** The panel consumes the live image stream and forwards validated
  input commands. It does not iframe the target origin, and the local-HTML preview is not
  repurposed as a control surface.

## Testing Decisions

- **Test observable behaviour, not implementation detail.** A test asserts what a user or an Agent
  can observe, never that a testid string exists. When a validator is touched, its message text is
  pinned exactly.
- **Use the highest seam available.** Contract and validator behaviour is covered by unit tests;
  assembled runtime and server behaviour by the application-level suites; the real service,
  dispatcher and loopback socket by the loopback integration suite; the built client by the
  built-client browser suite; a real installed extension by the manual acceptance matrix.
- **Prefer existing seams.** Browser-core's provider-neutral transport and the runtime host's
  browser adapter and tool exposure types are the seams to build on. The WebUI must not import the
  terminal client package.
- **No DOM test framework.** Interaction coverage extracts the transitions into pure functions and
  asserts render branches through static markup rendering.
- **Every new test file is registered.** A new Vitest file must be listed in the repository's
  declared suite groups or it never runs.
- **A fake provider is not acceptance.** The isolated Chromium path must be exercised against the
  real provider, and the packaged production entry must be exercised for the shipped claim.
- **Synthetic and mock peers prove protocol and routing only.** They do not prove browser permission
  prompts, extension installation, real CDP command support, MV3 worker lifetime, or control of an
  authenticated browser. Synthetic pages contain no account data; recorded acceptance states the
  browser version, the operating system, the enabled settings and the observed result.
- **Adversarial coverage is part of the definition of done.** Origin spoofing, non-loopback hosts,
  wrong browser identity, stale credentials, oversized or malformed frames, duplicate connections,
  stale generations, unauthorized operations, both Full CDP gate states, and revocation during an
  in-flight action each have a test.

## Out of Scope

- Silent installation of browser extensions, or any bypass of a browser's own permission prompts.
- Requiring the user to expose a remote-debugging port or to supply a CDP endpoint by hand.
- Native Messaging as the extension transport.
- Cross-device or LAN access to the extension bridge.
- Browser automation features the selected browser-core and runtime contract does not already
  support, unless a new decision is recorded in ADR 0019 first.
- Publishing the extension to the Chrome Web Store or to Edge Add-ons. Store submission is a
  separate release action; the implementation prepares the artifacts and the disclosures only.

## Further Notes

- The development plan that produced this board is workspace material, deliberately outside the
  published source projection. The board and the plan must not drift apart: an amendment belongs in
  the plan first, and the affected tickets are updated to match.
- Research notes captured before implementation, for the implementers:
  [#173 runtime and server seams](https://github.com/mcode-webui/minimax-code/issues/173),
  [#174 browser-core contracts and client conventions](https://github.com/mcode-webui/minimax-code/issues/174),
  [#175 repository plumbing for a new package and gates](https://github.com/mcode-webui/minimax-code/issues/175).
- Ticket 01 is the technical validation work package. It blocks every other ticket, because the
  capability matrix, the bridge protocol, the credential-store feasibility and the reconnect
  contract are what the later tickets are written against.
- If a technical finding requires a product change, ADR 0019 is updated first, then the affected
  tickets are re-scoped.

## Ticket board

| Ticket | Title | Blocked by |
| --- | --- | --- |
| #177 | 01 — Validate the technical contracts and pin the capability matrix | — |
| #178 | 02 — Four independent browser authorization switches, default off | #177 |
| #179 | 03 — Isolated Chromium provider starts under authorization | #177, #178 |
| #180 | 04 — Browser panel shows the isolated Chromium's live page | #179 |
| #181 | 05 — User pointer and keyboard input reach the same isolated page | #180 |
| #182 | 06 — Agent browser operations act on the page the panel shows | #179, #180 |
| #183 | 07 — Target generations invalidate stale element references | #182 |
| #184 | 08 — Full CDP access is a separate gate in the runtime/provider path | #179 |
| #185 | 09 — Extension package, dedicated loopback admission and pairing | #177, #178 |
| #186 | 10 — External browser tabs become targets the panel follows | #180, #185 |
| #187 | 11 — Live page images from the external browser reach the panel | #186 |
| #188 | 12 — User input reaches the external browser tab | #186 |
| #189 | 13 — Agent operations run against an external tab through the bridge | #185, #186 |
| #190 | 14 — Per-browser pairing credential lifecycle | #185 |
| #191 | 15 — Bounded reconnect during an operation, background reconnect while enabled | #190 |
| #192 | 16 — Extension worker termination and restart recover the bridge | #187, #191 |
| #193 | 17 — Edge and Chrome parity, store builds and real-browser acceptance | #188, #189, #192 |
| #194 | 18 — Security hardening, adversarial coverage, packaging review and documentation | #193 |

The blocking edges above are native GitHub issue dependencies, so a ticket is unblocked exactly
when every ticket it names is closed. The research notes are #173, #174 and #175; they are reference
material, not work items, and are deliberately not labelled `ready-for-agent`.
