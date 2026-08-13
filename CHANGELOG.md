# Changelog

All notable changes to `@nexquark/pi-subagent-fragments` are documented
here. This is a fork of [`@vanillagreen/pi-agents-tmux`](https://github.com/vanillagreencom/vstack/tree/main/pi-extensions/pi-agents-tmux);
see `UPSTREAM.md` for the sync policy and `specs/` for design history.

## Fork changes

### 0.4.0 — 2026-08-13

Implemented spec 005 (structured tool prompting — retire APPEND_SYSTEM.md):

- **Per-tool structured prompting (R1)** — all seven tools
(`subagent`, `delegate_subagent`, `steer_subagent`,
`get_subagent_result`, `wait_for_subagent_idle`, `stop_subagent`,
`complete_subagent`) carry `promptSnippet` + curated `promptGuidelines`.
Pi appends the guidelines only while the tool is active and applies them
to child agents too — no global APPEND_SYSTEM.md text, no main/child
asymmetry, no unconditional token cost.
- **APPEND_SYSTEM.md channel retired (R2)** — removed `pi.appendSystem`,
`scripts/append-system.mjs`, and the `postinstall`/`preuninstall` hooks;
local `~/.pi/agent/APPEND_SYSTEM.md` block cleaned. No new installs write
it.
- **Optional usage skill (R3)** — the full calling rules ship as
`skills/subagent-usage/SKILL.md` (Pi frontmatter + complete rules), are
packaged but **never auto-installed**; README documents manual install
into the user skills dir.
- **Docs (R4)** — README: simplified install command (no more
`--allow-scripts`), new "Structured tool prompting & optional skill"
section; orphan `instructions.md` dropped (N1).

### 0.3.1 — 2026-08-13

Implemented spec 004 (post-v0.3.0 hardening batch):

- **Running agent instance cap (R6)** — `/agents:new`/`/agents:start` refuse
to launch once `maxAgents` (default 40, configurable via
`vstack.extensionManager.config["@nexquark/pi-subagent-fragments"].maxAgents`;
`<= 0` = unlimited) running instances are met. Count = live panes +
queued/running bg one-shots; dead/terminal excluded; friendly error with
count + resource breakdown + both remediations. Management ops and
predefined inventory never capped.
- **File-lock diagnostics (R2)** — `FileLockTimeoutError` carries the
holder (`held by pid … on … since …`) from owner.json; exponential retry
backoff (doubling, capped 32×).
- **Inject hook typing + friendly ENOENT (R3)** — hook handler typed with
`BeforeAgentStartEvent`/`ExtensionContext`/`BeforeAgentStartEventResult`
(no `any`); `runToolInject` file sources error with resolved path and
ENOENT distinction.
- **Name-only ad-hoc contract (R1)** — `/agents:new|start <name>` with no
sources is valid (empty task); handler-level tests lock it.
- **E2E (R4)** — `e2e/e2e-002.mjs` (ad-hoc full grammar → synthesize →
launcher) and `e2e/e2e-003.mjs` (real pi child fires the fork's
`before_agent_start` hook: one-shot consume, on-apply history, 2nd-turn
no re-inject).

### 0.3.0 — 2026-08-12

Implemented spec 003 (runtime prompt injection). Adds `/agents:inject` and
the `subagent` tool `inject` param for mutating a running agent's system
prompt without a restart — the extension's `before_agent_start` hook
applies a one-shot pending injection at the target's next turn and records
applied versions in a per-agent history (FIFO cap 10). Core design in
`specs/003-prompt-inject.md`; PRs 10-13, reviewed under the charter TDD
cycle (verdicts in `specs/_reviews/`).

Added:

- `/agents:inject <name> [--replace|--append|--add] [<system-source>...]`
  with R2 sources (`#<path>` must-exist file, `#"..."` file-or-inline,
  bare inline). Mutations (`replace`/`append`/`add`) require a live pane
  session (OQ4); `--history` and `--rollback [N]` operate on the history
  file only.
- `--append` / `--add` are aliases in v1 (OQ3/A2): both compose against
  the agent's **real current prompt** (`event.systemPrompt`) at apply time
  — never launch config, which lacks the pane-time fragment composition
  (reviewer F2). `--replace` installs the given sources verbatim.
- `--rollback N` (N >= 1, explicit guard) reverts to the version N prompts
  ago; `--history` prints a markdown table (`# | mode | bytes |
  timestamp`). `--cwd` is the source-resolution root only (OQ5), never a
  chdir for the running agent.
- `subagent` tool `inject` param: `{name, mode?, sources?:
  {kind:'file'|'string', value}[], rollback?, history?, cwd?}` — a
  standalone action (no dispatch) writing the same injection state via the
  shared `runToolInject` helper (single source of truth with the slash
  handler). Tool-side mutation does NOT require a live pane.
- Hook side (`registerInjectionHook`, keyed by
  `ctx.sessionManager.getSessionName()`): reads the `inject/<agent>.json`
  state file, composes against the real current prompt, installs the
  result, pushes the applied version to history **on apply**, and unlinks
  the state one-shot — a second turn does not re-inject (A5). Chains
  cleanly beside the existing agent-list `before_agent_start` handler.
- `prompt-inject.ts`: `composeInjection` (pure), `injectStatePathFor` /
  `promptHistoryPathFor` (A3 single shared path helpers),
  `writeInjectionState` / `readInjectionState` /
  `consumeInjectionState` (one-shot consumed marker),
  `installPendingInjection`, `registerInjectionHook`, `runToolInject`;
  `prompt-history.ts`: `PromptHistory` FIFO cap 10, 1-indexed
  newest-first `get(n)`.

### 0.2.0 — 2026-08-12

Implemented spec 002 (ad-hoc pane agent launch). Adds the `agents:new` and
`agents:start` ad-hoc slash commands for launching an agent that is NOT in
the inventory, with an R2 source grammar and explicit pane/bg dispatch
control. Core design in `specs/002-adhoc-pane-agent.md` (through v1.8);
PRs 6-8, reviewed under the charter TDD cycle (verdicts in `specs/_reviews/`).

Added:

- `agents:new <name>` / `agents:start <name>` ad-hoc dispatch when the name
  is not in the agent inventory. An ad-hoc agent is synthesized on the fly
  (`synthesizeAdhocAgent`) and dispatched, instead of erroring on an unknown
  name.
- R2 source grammar for ad-hoc arguments, parsed by `parseAdhocArgs` +
  quote-aware `tokenizeArgs` in `extensions/subagent/agents-command.ts`:
  `#<path>` / `#"..."` (file path, inline-quoted), `@...` (path-or-text),
  `"..."` (inline text), 8 flags, and `--` separator for passthrough.
- Pane/bg dispatch control:
  - `--no-pane` forces a background dispatch (`runSingleAgent`) regardless
    of tmux; on a tmux-less host ad-hoc dispatch falls back to bg with a
    one-time "tmux not available" warning (C1).
  - `--new-pane` forces a fresh persistent pane (stop-then-create) rather
    than reusing a live one (C2).
  - `--pane-direction` / `--pane-size` / `--pane-target` configure the
    tmux split via the new `buildTmuxSplitArgs` helper + `paneDirection` /
    `paneSize` / `paneTarget` params on `ensurePersistentPane`,
    `queuePersistentPaneTask`, and `runPersistentPaneAgent` (C4b).
- `--model` / `--cwd` / `--replace` are parsed and threaded into the
  ad-hoc agent config / dispatch (passthrough args are appended to the
  launcher argv via `shellQuote` — D8).
- C4a tmux split retry: when a `split-window` reports a missing size, the
  retry drops the `-p`/size tokens and re-runs, via the pure
  `applyC4aRetry(args)` helper in `agents.ts`.
- Shared pure helpers in `extensions/subagent/agents.ts`:
  `resolveAdhocPane(tmux, noPane)` (= `noPane ? false : tmux`, the single
  source of truth for `--no-pane`/tmux-fallback routing) and
  `shouldAdhocFallbackToBg`. `resolveForceNewPane(command, newPaneFlag)`
  (= `command === 'new' || newPaneFlag`) in `agents-command.ts`.
- New handler-level test harness `tests/adhoc-handler.test.ts`: invokes the
  real `agentsHandler` via `registerAgentsCommands` + a mock pi, with
  `setSingleAgentSpawnForTests` (runner) and `setPaneExecCaptureForTests`
  (pane) seams, so dispatch paths run without spawning real processes. This
  closes the "parsed-but-not-wired" false-confidence class that pure-helper
  tests missed.
- Test files: `tests/adhoc-slash.test.ts` (R2 grammar, L1-L15, C2),
  `tests/adhoc-bugfix.test.ts` (C1 warn scope, cycle 3),
  `tests/pane-resilience.test.ts` (C4a mock tmux retry),
  `tests/adhoc-handler.test.ts` (C1/C2/C4b handler-level).
- `extensions/subagent/agents-command.ts` — ad-hoc branch in the
  `agents:new`/`agents:start` handler, with `parseAdhocArgs` and the
  `AdhocParsedArgs` / `AdhocSystemSource` / `AdhocUserSource` types.
- `specs/002-adhoc-pane-agent.md` — full design (grammar, dispatch
  semantics, acceptance criteria, PR 6→7→8→9 split, risks, revision
  history through v1.8).

Fixed:

- `--no-pane` is no longer inverted (was `pane: fallbackToBg ? false : true`,
  which dropped the parsed `noPane` signal and forced a pane).
- `--no-pane` genuinely routes to the bg lane — the handler previously set
  `pane: false` cosmetically but still called `queuePersistentPaneTask`
  (which threw `ensureTmux` on a tmux-less host). It now branches on
  `wantPane`: pane lane → `queuePersistentPaneTask`; bg lane →
  `runSingleAgent` (reused, not copied).
- The "tmux not available" warning now fires only when `$TMUX` is actually
  unset (was firing on tmux hosts passing explicit `--no-pane`).

Removed:

- `tests/subagent-bridge-id.test.ts` — enforced a cross-package contract
  with `pi-extensions/pi-session-bridge/`, which is not part of this
  standalone fork's sparse-checkout. The file had a module-resolve error
  and was already excluded from suite runs; the 0.2.0 squash dropped it so
  the main-branch suite runs clean.

Suite status (0.2.0, excluding the removed untracked file):
406 pass / 0 fail / 0 todo / 728 expect / 41 files.

Known follow-ups (PR 9 docs scope, non-blocking for v0.2.0):

- README R2 grammar + C4b user docs (`--pane-direction` / `--pane-size` /
  `--pane-target`) + `--replace` / `--model` / `--cwd` examples (sub-tmux).
- Reinforce the C2 handler-level test to prove stop-then-create against a
  pre-existing pane (PR8-F8 in `_pr8-3.md`).

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
