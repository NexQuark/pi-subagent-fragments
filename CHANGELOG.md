# Changelog

All notable changes to `@nexquark/pi-subagent-fragments` are documented
here. This is a fork of [`@vanillagreen/pi-agents-tmux`](https://github.com/vanillagreencom/vstack/tree/main/pi-extensions/pi-agents-tmux);
see `UPSTREAM.md` for the sync policy and `specs/` for design history.

## Fork changes

### 0.1.0 — 2026-08-12

Initial fork release. Implemented spec 001 (multi-prompt fragment injection,
static, spawn-time).

Added:

- `extensions/subagent/prompt-compose.ts` — pure helper
  `composeAgentPrompt({body, fragments, mode, separator})` joining a body
  string with zero or more fragment strings. v1 invariant: both `append`
  and `replace` modes produce identical output.
- New frontmatter fields on `AgentConfig`:
  - `systemPromptFragments?: string[]` — paths (relative to the agent
    file's directory) to fragment files whose contents are joined into
    `agent.systemPrompt` at load time.
  - `systemPromptMode?: "append" | "replace"` — accepted, recorded, and
    inert in v1. Unknown values log a warning and fall back to `append`.
- Both kebab-case (`system-prompt-fragments`) and camelCase
  (`systemPromptFragments`) frontmatter keys are accepted.
- Missing fragment paths fail agent load with a clear error that names
  the agent file and the missing path. Empty fragment files are treated
  as empty (no double-separator).
- `pane.ts` and `runner.ts` spawn-time call sites import
  `composeAgentPrompt`. In v1 both sites pass `fragments: []` because
  load-time composition has already folded the fragments into
  `agent.systemPrompt`; the import keeps the join rule in one place so
  a v2 dynamic-loading layer can replace the load-time step without
  touching the spawn sites.
- `specs/001-multi-prompt-injection.md` — full design (background,
  current-state analysis with file:line references, design,
  implementation details, acceptance criteria, five-PR split plan,
  risks, archive path).
- `specs/README.md` — index of specs in this fork with a status
  legend.
- `UPSTREAM.md` — sync policy (sparse-checkout + periodic cherry-pick;
  24h critical-fix fast-track for security / state-corruption fixes) and
  sync history table (currently a single `initial-fork` row at upstream
  commit `faeb65af` / version 2.8.1).
- 19 new test cases across three new test files:
  - `tests/prompt-compose.test.ts` (8 cases) — helper correctness.
  - `tests/agents-fragments.test.ts` (8 cases) — load-time frontmatter
    parsing and fragment resolution.
  - `tests/spawn-prompt-compose.test.ts` (3 cases) — spawn-site
    integration through `writePromptToTempFile`.

Removed:

- `tests/subagent-bridge-id.test.ts` — enforced a cross-package
  contract with `pi-extensions/pi-session-bridge/`, which is not part
  of this standalone fork's sparse-checkout. The contract is orthogonal
  to fragment composition and belongs to upstream vstack as a whole.

Deferred to v2 (see spec § 11):

- Runtime switching of fragments via a `before_agent_start` hook.
- Async / dynamic fragment loader (fragment registry).
- Path-containment sandbox for fragment paths.

Upstream baseline:

- Forked from `vanillagreencom/vstack@faeb65af9319fddf4cb7528c224e259df6f40a24`
  (`pi-agents-tmux` 2.8.1). All 2.8.1 consumer-impacting changes from
  upstream are inherited unchanged.

## Inherited from upstream `@vanillagreen/pi-agents-tmux`

## Consumer-impacting changes

### 2.8.1

- Child spawning no longer trusts `process.argv[1]` as the pi entry (vstack#192). Previously any existing script in `argv[1]` was re-invoked as if it were pi, so a standalone harness/test that imported `runner.ts` directly and dispatched a subagent re-ran the harness recursively — an unbounded fork bomb. Self-re-invocation now requires a pi entry basename (`pi`, `pi.js`, `pi.mjs`, `pi.ts`, `cli.js`, `cli.mjs`, `cli.ts`) AND proven pi package identity: the nearest `package.json` above the realpathed entry must have `name` `@earendil-works/pi-coding-agent`, or its `pi` bin entry (object form, or string form on a package named `pi`) must itself resolve to the realpathed entry script — merely declaring a `pi` bin does not qualify. A missing manifest continues the walk upward; any other manifest read failure (EACCES etc.) rejects immediately. Anything else — including a harness literally named `cli.ts` — falls back to resolving `pi` on PATH. Compiled-binary (`/$bunfs`) and pi dev-mode behavior are unchanged.
- New `PI_SUBAGENT_ENTRY` env var explicitly overrides pi entry resolution for direct-import harnesses/tests: a path to an existing `.ts`/`.js`/`.mjs`/`.cjs` script runs under the current runtime and is resolved to an absolute path against the parent's cwd (children spawn from the delegated agent cwd, where a relative path would not resolve); anything else is used as the pi executable/command itself — separator-bearing forms (e.g. `./bin/pi`) are resolved to absolute paths against the parent's cwd because the OS never PATH-resolves a command containing a separator, while separator-free names stay verbatim for PATH resolution. Spawned children inherit the override in resolved form — the bg runner sets it on the child env and the pane launcher exports it (or unsets a stale tmux-level value when no override is active) — so a delegating child at depth 2 does not re-resolve a relative override from its own cwd.
- New `PI_SUBAGENT_DEPTH` recursion guard, independent of entry resolution: every spawned child (bg one-shot and persistent pane) carries its generation in this env var, and spawning refuses with a loud error once depth would exceed 3. The refusal is raised before `subagents:started` is emitted, so a refused dispatch never announces itself and cannot strand a permanently-"running" task row in the dashboard/task registry. New exports from `extensions/subagent/pane.ts`: `PI_SUBAGENT_ENTRY_ENV`, `PI_SUBAGENT_DEPTH_ENV`, `MAX_SUBAGENT_DEPTH`, `currentSubagentDepth()`, `assertSubagentSpawnDepth()`, `removePromptTempDir()`; `getPiInvocation()` now returns `childDepth` and accepts an optional runtime parameter.
- `/tmp/pi-subagent-*` prompt dirs are now removed recursively/forcefully on child failure and refusal paths, and reclaimed immediately when the prompt write itself fails, instead of only after a clean unlink.
- `PANE_LAUNCHER_VERSION` bumped 9 → 10: live persistent panes recorded by an older version are killed and relaunched once on upgrade so they pick up the new launcher (depth guard + entry export). A pinning test now ties the constant to the launcher template so future template changes cannot ship without a bump.

### 2.8.0

- Pi 0.84.0 parity: the failed-bg-agent transcript flush now rebuilds the partial assistant message from streamed deltas. Pi's JSON/RPC `message_update` became delta-only (`toJsonEvent()` strips the cumulative `message` and `assistantMessageEvent.partial`), so flushing the newest event alone preserved a single delta instead of the answer-so-far — and the task-summary backfill, dashboard activity, and transcript display all read the assistant text from the event's `message`, so they recovered nothing from a bg agent that died mid-answer. The flushed `buffered: true` record now restores the rebuilt message onto the event's `message` field, where those readers already look, and repeats it in a record-level `partialMessage` field for direct inspection; both are omitted when the event still carries its own snapshot. Rebuilt blocks use Pi's own content shapes (`{ type: "text", text }` / `{ type: "thinking", thinking }`). When updates were seen but nothing could be rebuilt, the flush now emits a result diagnostic naming the unrecognized `assistantMessageEvent` types instead of writing an empty forensic record. New exports from `extensions/subagent/transcripts.ts`: `PartialAssistantMessageState`, `PartialAssistantContentBlock`, `createPartialAssistantMessageState()`, `applyPartialAssistantMessage()`, `partialAssistantMessage()`, `partialAssistantMessageDiagnostic()`, `resetPartialAssistantMessage()`.

### 2.7.1

- Bg one-shot tasks now complete promptly after Pi emits `agent_settled`; the runner accepts settlement only after the latest low-level run ends, transfers timeout ownership while shutdown is active, permits continuation cancellation only before termination delivery succeeds, bounds failed termination attempts, and reports forced completion only for a matching signal or exit status.
- Provider rate-limit retry remains scoped to persistent pane children so bg one-shot settlement cannot terminate a child with an advertised retry still pending.
- Dashboard usage parsing now streams transcripts, refreshes terminal tasks through their final transcript update, evicts fingerprints when tasks leave the retained dashboard set, and drains completion usage writes before session shutdown.

### 2.7.0

- Baseline: changelog introduced at this version. Consumer-impacting changes — behavior deltas, new/renamed/removed exports, settings and config changes, protocol/audit-shape changes — are recorded here from this version forward.
