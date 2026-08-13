# Spec 004: Post-v0.3.0 Hardening Batch (v0.3.1)

| Field | Value |
|---|---|
| **Status** | Implemented (released in v0.3.1; verdicts in `specs/_reviews/_pr14..16-*.md`) |
| **Target version** | `0.3.1` |
| **Scope** | This fork only (`@nexquark/pi-subagent-fragments`) |
| **Upstream base** | `vanillagreencom/vstack` (unchanged since spec 003) |
| **PRs** | pending (R2/R3 via sub-tmux, TDD) |
| **v2 reserved** | § 10 of spec 003 — cross-pane broadcast / per-segment mutation / auto-rollback |

---

## 1. Background and Goal

v0.3.0 (spec 003) shipped runtime prompt injection. This batch collects
small post-release hardening items agreed with the user, plus the
**process contract**: every new requirement must be described in a spec
(this file) before/when implemented, and bugs/findings must be tracked
explicitly (the "Open findings" section below is that tracker, alongside
the local review files in `specs/_reviews/`).

Two process decisions were confirmed by the user:

1. **Per-minor-version local install.** Every completed minor version is
   installed on this machine via `npm pack` + `npm install -g` of a local
   tarball (never `npm publish`). Documented in README (house rule,
   commit `0a0e2ab`).
2. **`specs/_reviews/` stays untracked.** Review/verdict files never get
   committed; the archived spec carries the consolidated review history.
   Documented in DEVELOPMENT.md (commit `14eb5f1`).

## 2. Requirements

### R1 — `/agents:new|start`: everything except `<name>` is optional (empty-task launch)

**Contract**: `/agents:new <name>` and `/agents:start <name>` with no
sources and no flags are valid; the agent starts with an **empty task**
and decides its own next action.

**Current state** (verified, implementation already correct):
- Parser: `parseAdhocArgs("foo")` → `{ name: "foo", userSources: [] }` —
  no task-required check (`extensions/subagent/agents-command.ts:517`),
  covered by test L1 (`tests/adhoc-slash.test.ts:49`, "empty pi").
- Pane lane: `queuePersistentPaneTask` does not validate task non-empty;
  `buildDelegation` writes a delegation file with an empty task segment
  (`extensions/subagent/pane.ts:934`).
- Bg lane: `runSingleAgent` has no empty-task check; empty task runs as a
  normal one-shot.

**Gaps**: handler-level end-to-end test locking the contract (that
name-only invocation dispatches an empty task without error, in both
pane and bg lanes).

**Status**: Implemented (behavior + tests landed @ `7c7bfdd`).

### R2 — File-lock diagnostics (contention root-cause visibility)

**Problem**: `FileLockTimeoutError` reports only "Timed out acquiring
file lock for X after 45s". `owner.json` records pid/host/acquiredAt but
is never read on timeout, so shared-worktree contention (the transient
15 fail / 14 error runs) is diagnosed by guessing.

**Design**:
1. On timeout, read `lockDir/owner.json` and include holder info in the
   error message (`held by pid <pid> on <host> since <ts>`); fall back
   to the current message when owner.json is missing (backward compat).
2. Retry backoff: replace fixed jitter with exponential backoff
   (base `retryMs`, doubling, cap ~`retryMs*32`, plus random jitter).
   Defaults unchanged (`staleMs` 30s, `timeoutMs` 45s); public signatures
   unchanged.

**Tests**: `extensions/subagent/__tests__/file-lock.test.ts` — holder
info appears in timeout error (accelerated via
`setFileLockOptionsForTests`); backoff behavior; `isFileLockTimeoutError`
compat.

**Status**: Implemented @ `1f1c24e`.

### R3 — Inject hook typing + friendly file-source error

**R3a (PR 11 F1)**: `registerInjectionHook`'s
`pi.on("before_agent_start", (event: any, ctx: any) => …)` uses `any`;
an upstream API rename would not fail at compile time. Type the params
with the pi-coding-agent exported types (`BeforeAgentStartEvent` /
`ExtensionContext` — verify exact export names against
`@earendil-works/pi-coding-agent`).

**R3b (PR 12 F1)**: `runToolInject`'s file-source `readFileSync` throws a
bare ENOENT; the slash-handler side has a friendly
"must be a regular file" error. Wrap as
`inject: file source "<path>" not found` (with resolved path), matching
the slash-side style.

**Tests**: typecheck for R3a (compile layer); execute-capture test for
R3b asserting the friendly error.

**Status**: Implemented @ `a07aa22`.

### R4 — E2E coverage for spec 002 and spec 003

`e2e/e2e-001.mjs` covers spec 001 only. Add:
- **e2e-002**: ad-hoc pane launch surface on the real installed package
  (`parseAdhocArgs` full grammar + `synthesizeAdhocAgent` +
  `writeLauncher`, mirroring e2e-001's driver pattern).
- **e2e-003**: `before_agent_start` hook truly fires in a real pi child
  (one-shot consume + 2nd-turn no re-inject), which the mock-pi unit
  harness cannot prove.

**Status**: Implemented (e2e-002 `b4b05b4`, e2e-003 `3cb4372`).

### R6 — Running agent instance cap (default 40, configurable)

**Contract** (user-confirmed 2026-08-13): cap the number of **running agent
instances** (not the predefined inventory). When the threshold is reached,
`/agents:new` / `/agents:start` refuse to launch another instance and return
a friendly error; management operations stay unrestricted; predefined agent
count is unrestricted.

**Scope of the count**: running instances = live panes + running/queued bg
one-shots (pane registry live entries + task registry queued/running
records). Counted at dispatch time in the `new`/`start` handler (both pane
and `--no-pane` lanes).

**Default / config**: `maxAgents` via `settingNumber("maxAgents", 40)`
(settings `vstack.extensionManager.config["@nexquark/pi-subagent-fragments"].maxAgents`);
`<= 0` = unlimited (backward compat with current behavior).

**Over-limit error** (must contain, per user): the current instance count
and resource summary (N running: M panes, K bg), plus the two remediations —
end idle agents (`/agents:stop <name>`) or raise the value
(`maxAgents` config path).

**Unrestricted** (explicit): management ops (`stop`/`status`/`attach`/
`send`/`trace`/`toggle`) never blocked; predefined agent definitions never
capped; ad-hoc synthesized agents count as instances (they occupy a pane/
bg lane) but are not capped at definition time.

**Tests**: unit — guard blocks new/start over cap (both lanes), count
excludes stopped/dead instances, config override (`0` = unlimited / N
applies), friendly error text carries count + remediation; management ops
unblocked at cap.

**Status**: Implemented (red `cc23a0b`, green `c4193f4` on `feat/instance-cap`).

### R5 — Documentation updates (mostly landed)

| Item | Commit |
|---|---|
| README: local tarball install house rule | `0a0e2ab` |
| README: ad-hoc full worked example (4 source types × flags) | `14eb5f1` |
| README: name-only contract + minimal form | `9865c0c` |
| README: inject section (PR 13) | `c357ea6` |
| `docs/adhoc-syntax-compare.md`: DECISION RECORD marker (option (c) implemented) | `14eb5f1` |
| DEVELOPMENT.md: `specs/_reviews/` untracked note | `14eb5f1` |
| package.json: `bun run smoke` (v020 + v030, verified green) | `14eb5f1` |

**Status**: Implemented.

## 3. Open findings / bug tracker

| ID | Origin | Description | Disposition |
|----|--------|-------------|-------------|
| F-01 | PR 12 F1 | `runToolInject` file source throws bare ENOENT | Closed — fixed `a07aa22` (R3b friendly error) |
| F-02 | PR 11 F1 | inject hook params typed `any` | Closed — fixed `a07aa22` (R3a typed hook) |
| F-03 | PR 12 F2 | tool-side inject does not require live pane (deliberate, wider semantics) | Closed — by design, documented (README) |
| F-04 | F3 review | inject combined with agent/task/tasks/chain silently ignored | Closed — fixed `0e1f455` (standalone-only guard) |
| F-05 | post-F3 runs | Transient 15 fail / 14 error under shared-worktree parallel test runs (file-lock contention) | Open — mitigated by R2 diagnostics; monitor |
| F-06 | spec 003 §10 | Cross-pane broadcast / per-segment mutation / auto-rollback | Deferred (v2 reserved) |

Older review findings are recorded in `specs/_reviews/_pr{6..13}-*.md`
(local, untracked by user decision); terminal findings migrate into this
table when they need action tracking.

## 4. Implementation steps

1. R2 + R3 + R1 tests — sub-tmux TDD, one or two PRs → technical review
   (sub-meta) → reviewer verdict → squash to `main`.
2. R4 — e2e-002/003 as a separate round.
3. Release v0.3.1 per charter §5 (bump + archive this spec → `specs/archive/004-*.v1.md` + local tarball install + smoke).

## 5. Acceptance criteria

- [ ] R1: handler-level tests lock name-only empty-task dispatch (pane + bg).
- [ ] R2: timeout errors carry holder info; backoff in place; suite green.
- [ ] R3: hook params typed; friendly ENOENT; suite green.
- [x] R4: e2e-002 and e2e-003 pass against the installed package.
- [x] R6: new/start blocked over instance cap (both lanes) with friendly error; config override; management ops unblocked.
- [ ] Spec 004 archived with Status Implemented at v0.3.1; README index updated.

## 6. Revision history

| Version | Date | Change |
|---------|------|--------|
| v1.0 | 2026-08-13 | Initial draft — R1-R5 + open findings tracker |
| v1.1 | 2026-08-13 | R6 added (running agent instance cap, default 40, configurable) — user-confirmed scope (instances, not inventory; management/predefined unrestricted) |
