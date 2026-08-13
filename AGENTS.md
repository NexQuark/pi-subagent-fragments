# pi-agents-tmux agent notes

- Activity broker publication lives in `extensions/subagent/activity.ts` and uses `globalThis[Symbol.for("vstack.pi.activity")]` when `pi-session-bridge` is loaded.
- Keep broker emission fail-open: subagent dispatch, steering, completion, and result retrieval must not depend on activity publish success.
- Lifecycle mapping is `subagents:*` → `agent.*`; update README and DEVELOPMENT.md when adding or renaming activity event types.
- The `bg|pane` lane badge renders from `SingleResult.kind`, stamped at dispatch. Never re-derive the lane from `taskId`/`paneId`: `taskId` records whether a task was queued, so a pane dispatch refused before queueing carries none and would mislabel as `bg`. Every new `SingleResult` construction site sets `kind`; pre-dispatch refusals also set `refused: true` so the row reads `refused` instead of claiming a run failed.
- `delegate_subagent` (issue #228) is intentionally narrow: single-mode only, authorized via `PI_SUBAGENT_CHILD_AGENT`, allowlist comes from the caller agent's `allowed-subagents:` frontmatter, pane targets rejected. Do not silently grow its schema or short-circuit the allowlist — that defeats the dev-agent-without-orchestration design. Bg one-shot runner exports `PI_SUBAGENT_CHILD_AGENT` (and `PI_SUBAGENT_CHILD_COLOR`) for authorization; only persistent pane launchers export `PI_SUBAGENT_CHILD_PANE=1`. Keep bridge env vars and tmux pane-title/inbox behavior pane-only unless tested against `pi-session-bridge`.

## Collaborative development protocol (multi-agent, shared worktree)

This repo is developed by multiple Pi agents (sub-meta / sub-tmux /
review-subagent-tmux) sharing **one git worktree**. The branch & worktree
protocol in [`DEVELOPMENT.md` § "Branch & worktree protocol"](./DEVELOPMENT.md)
**binds every agent session working in this repo** — read it before any
git operation. Non-negotiable highlights:

- **Check `git branch --show-current` before every commit** — a commit made
  while a peer has switched the shared checkout lands on their branch
  (happened three times).
- **Only sub-meta commits to `main`**, and only from a temporary worktree
  (`git worktree add /tmp/… main`); sub-tmux never merges/squashes/pushes
  to main; reviewer is read-only (its only writes are its own untracked
  `specs/_reviews/` verdict files).
- **Reviews, squash merges, suite runs, and e2e runs happen in temporary
  worktrees** — never check out the shared tree's branch mid-task, never
  run a full suite while a peer runs one (file-lock contention → transient
  fails).
- **Never force-update a branch checked out by any worktree**; broadcast
  (intercom) before switching the shared checkout; uncommitted edits
  belong to the checkout owner — coordinate (stash/commit) before
  switching over them.
- **Every new requirement lives in a spec before/during implementation**
  (see `specs/README.md`); bugs/findings are tracked in the current spec's
  "Open findings" table or `specs/_reviews/`. New features go through the
  charter TDD cycle (draft → implement → technical review → reviewer
  verdict → squash to main → release).
