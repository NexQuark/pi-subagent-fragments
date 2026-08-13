# Specifications

This directory contains design specifications for `pi-subagent-fragments`
features. Each spec is numbered and tracks the corresponding implementation
PRs.

## Index

| ID  | Title                                  | Status     | Implementation |
|-----|----------------------------------------|------------|----------------|
| 001 | Multi-prompt fragment injection (static, spawn-time) | Implemented | `feature/fragments` (v0.1.0) |
| 002 | Ad-hoc pane agent launch + call-time prompt assembly | Implemented | PR 6-9 (v0.2.0) — archived |
| 003 | Runtime prompt injection (`/agents:inject` + `subagent.inject`) | Implemented | PR 10-13 (v0.3.0) — archived |
| 004 | Post-v0.3.0 hardening batch (v0.3.1): name-only ad-hoc contract, file-lock diagnostics, inject typing + ENOENT, e2e 002/003, instance cap | Implemented | A3/A1/R1/R4/R6 (v0.3.1) — archived |
| 005 | Structured tool prompting — retire APPEND_SYSTEM.md; tool rules → promptSnippet/promptGuidelines; optional skill | Implemented | feat/tool-prompting (v0.4.0) — archived |

## Status legend

- **Draft** — author writing; not yet ready for implementation.
- **Approved** — accepted; implementation in progress.
- **Implemented** — code merged; spec frozen.
- **Superseded** — replaced by a later spec; kept for history.

## Per-spec sections (typical structure)

Each spec follows roughly:

1. Background and goal
2. Current state analysis (with file:line citations into this fork's
   `extensions/subagent/`)
3. Design
4. Implementation details
5. Acceptance criteria
6. Implementation steps (per PR)
8. Spec after-completion archive path
9. _(extensions)_ — feature-specific design, e.g. dynamic switching, security
10. Revision history