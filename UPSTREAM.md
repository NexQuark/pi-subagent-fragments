# Upstream Sync

This fork tracks
[`vanillagreencom/vstack`](https://github.com/vanillagreencom/vstack)
specifically the
[`pi-extensions/pi-agents-tmux/`](https://github.com/vanillagreencom/vstack/tree/main/pi-extensions/pi-agents-tmux)
subdirectory. Sync happens via cherry-pick from `vstack:main`.

## Sync policy

- **Routine**: every 1–2 weeks, fetch upstream, inspect commits under
  `pi-extensions/pi-agents-tmux/`, cherry-pick non-conflicting fixes into
  `main` via a throwaway `sync/upstream-<version>` branch.
- **Critical-fix fast-track**: out-of-band cherry-pick within 24h for
  upstream commits touching pane state corruption, session loss, or
  control channel leakage. Marked `status: critical-fast-track` below.
- **Do not auto-merge**. Manual inspection only.

## Sync history

| upstream-version | upstream-commit                          | synced-date | status                | notes |
|------------------|------------------------------------------|-------------|-----------------------|-------|
| 2.8.1            | `faeb65af9319fddf4cb7528c224e259df6f40a24` | 2026-08-12  | `initial-fork`        | First import of pi-agents-tmux into this fork; baseline for cherry-pick. All fork modifications live on `feature/fragments`. |

## Status legend

- `initial-fork` — base commit establishing the fork from a known upstream SHA.
- `clean` — cherry-pick applied without conflict.
- `conflict` — cherry-pick hit conflicts; deferred or rebased manually.
- `skipped` — intentional skip (e.g., feature not needed in fork).
- `critical-fast-track` — out-of-band security or correctness fix synced within 24h.

## Conflict escalation

If conflict rate exceeds 30% over a release window, or upstream introduces
shared `workspace` packages that pi-agents-tmux depends on, escalate by
forking all of `vanillagreencom/vstack` and submitting fork changes only
under `pi-extensions/pi-agents-tmux/`.