# Team Charter — `pi-subagent-fragments`

This charter governs how the three coordinating agents
(`sub-meta`, `sub-tmux`, `review-subagent-tmux`) collaborate on
specs and PRs in this fork. It exists so role boundaries, file
ownership, and communication contracts are explicit before work
starts — not negotiated mid-PR.

The charter is owned by `sub-meta`. Amendments go through a spec
review round (see § 4).

## 1. Roles

### 1.1 `sub-tmux` — **设计 + 开发 + TDD 测试实施**

A spec author and TDD implementer in one role. TDD couples
test-writing with implementation, so splitting them across agents
breaks the red → green → refactor cycle. `sub-tmux` owns the full
cycle per acceptance criterion.

Deliverables:

- `specs/00X-<name>.md` — design spec (file:line citations into
  this fork required; see `review-subagent-tmux` checklist §1).
- `tests/adhoc-*.test.ts`, `tests/<feature>-*.test.ts` — TDD test
  files. **Red before green.** Every acceptance criterion in spec §5
  must have at least one failing test written before the
  implementation commit that addresses it.
- `extensions/subagent/*.ts` — implementation. No code commit
  before the matching test exists and fails for the documented
  reason.

Constraints:

- `sub-tmux` does NOT move spec status, archive specs, or bump
  versions. That is `review-subagent-tmux`'s gate.
- `sub-tmux` does NOT edit `specs/README.md` directly; status
  transitions are owned by `sub-meta` (see § 1.3).

### 1.2 `review-subagent-tmux` — **验证 + 部署**

Spec and PR reviewer. Owns the verdict gate and the post-merge
release path.

Deliverables:

- `specs/_reviews/00X-<round>.md` — verdict file per review round
  (round = 1, 2, 3, …). Verdict ∈ {`Approve`, `Approve with
  comments`, `Request changes`, `Block`}.
- `specs/archive/00X-<name>.vN.md` — frozen spec after merge.
- `CHANGELOG.md` entry on each release.
- `package.json` version bump on each release.
- `npm publish` after the version bump. **Currently gated `[POST-V0.2.0]` per § 5 step 8** — v0.2.0 releases skip publish.
- **Coordination gate**: holds step 8 until `sub-meta` reports one of three smoke messages per § 5 step 7 — `[meta] smoke passed for vN.M.P` (proceed), `[meta] smoke failed (blocker)` (halt), `[meta] smoke failed (follow-up)` (reviewer arbitrates proceed vs file follow-up).
- Merge commits (squash per PR series as defined in spec §6).

Constraints:

- Read-only mandate. `review-subagent-tmux` does NOT edit code,
  specs, or `specs/README.md`.
- Verdict files are append-only; never rewrite history. Earlier
  rounds stay in `specs/_reviews/` for the audit trail.
- Deployment decisions require an `Approve` or `Approve with
  comments` verdict on the latest round. `Request changes` and
  `Block` do not trigger deploy.
- **Single source of truth for cross-surface mutations**: when a
  feature ships via both a slash command and a tool param (or any
  two surfaces), the implementation MUST go through a single
  shared helper. Reviewer audits for divergence; divergent
  implementations are Findings.
- **Flaky tests must be filed as Findings**: if `bun test` shows
  a test passing on most runs but failing intermittently, the
  next release is blocked until a Finding is filed in
  `specs/_reviews/` with the test name, line, and observed
  flakiness rate. Reviewer flags the Finding on the next review
  round; sub-tmux owns the fix.

### 1.3 `sub-meta` — **统筹 (coordinator)**

Architect and contract owner. Does not write feature code.

Deliverables:

- `tests/__contracts__/00X.md` — test contract matrix per spec:
  one row per acceptance criterion in spec §5, mapping it to the
  test file + test case that covers it. **(sub-tmux owns per
  § 2; sub-meta reads via `.ai-state/tdd-log.jsonl` for status
  reporting and does NOT write to this file.)**
- `specs/README.md` — status index. Updates after every status
  transition.
- Dispute resolution when `sub-tmux` and `review-subagent-tmux`
  disagree on whether a verdict blocks a release.
- **Local install smoke test** (per § 5 step 7) — verifies the
  merged release end-to-end before publish (step 8) can proceed.
  Reports one of three states via intercom: `[meta] smoke passed
  for vN.M.P` (green, gate clears), `[meta] smoke failed (blocker)`
  for vN.M.P (red, halts step 8), `[meta] smoke failed (follow-up)`
  for vN.M.P (amber, reviewer arbitrates).
- `.ai-state/lessons.md` — append-only lessons learned log, per
  § 5 step 5.1.2 schema. Sub-meta appends after each release or
  non-trivial learning; reviewer may reference in verdict
  rationales. `.ai-state/` is gitignored.
- `.ai-state/{bootstrap.yaml, dispatches.jsonl, verdicts.jsonl,
  tdd-log.jsonl, current-task.json}` — coordination state files.
  Sub-meta owns writes; gitignored.

Constraints:

- `sub-meta` does NOT write spec text or implementation code.
- `sub-meta` does NOT unilaterally move spec status from
  `Implemented` back to `Draft`. That requires a fresh review
  round by `review-subagent-tmux`.
- **Status state-machine invariant**: `specs/README.md` and
  `specs/00X-*.md` frontmatter `Status` field MUST agree after
  each transition. The most recent edit wins as the source of
  truth for the next reader. If they disagree, the agent who
  performed the most recent edit is responsible for fixing the
  other file in the same commit.
- **Smoke test failure discipline**: when a smoke test fails,
  suspend all non-coordination tasks (pending TDD monitoring,
  new spec dispatch, charter amendment drafting). Return to
  coordination only after the smoke test resolves (passed,
  accepted follow-up, or aborted). Reason: smoke test debugging
  and dispatch share context; mixing them causes context bloat
  and degrades both workstreams.
- **Process-meta-work isolation**: Draft documents (charter
  amendments, future spec drafts before Approved), coordination
  directories (`.ai-state/`), and config-for-coordination
  (`.gitignore` entries for sub-meta state) belong on feature
  branches with explicit review paths, not on `main` directly.
  Even when tests pass locally, do not merge Draft process work
  to a released line without going through the review round.

## 2. Directories and ownership

| Path | Owner | Purpose |
|---|---|---|
| `specs/00X-*.md` | `sub-tmux` | Active spec drafts / approved specs |
| `specs/archive/00X-*.md` | `review-subagent-tmux` | Frozen post-merge specs |
| `specs/_reviews/00X-<round>.md` | `review-subagent-tmux` | Verdict files, append-only |
| `specs/README.md` | `sub-meta` | Status index |
| `tests/__contracts__/00X.md` | `sub-tmux` | Acceptance ↔ test matrix. sub-tmux adds rows when the spec is Approved (`[dev] spec <id> contract matrix ready`) and flips `red` → `green` per TDD cycle. sub-meta reads only (via `.ai-state/tdd-log.jsonl`). |
| `hotfix/v<N.M.P>` branches | `review-subagent-tmux` | Created when smoke gate fails (`§ 5 step 6.7.1`); sub-tmux commits fixes but does not create the branch. |
| `.ai-state/` | `sub-meta` | Coordination state (gitignored). sub-meta writes; sub-tmux and reviewer read for context. |
| `tests/*.test.ts` | `sub-tmux` | TDD tests (red, then green) |
| `extensions/subagent/*.ts` | `sub-tmux` | Implementation |
| `CHANGELOG.md` | `review-subagent-tmux` | Release notes |
| `package.json` (version field) | `review-subagent-tmux` | Version bump on release |
| `docs/team-charter.md` (and any future `_charter-N.md` if split out) | `sub-meta` | Durable team contract (per § 6); amendable via `_charter-N.md` verdict rounds. |
| `docs/*.md` (other) | each writer owns their own files | Transient process / decision-aid space. Per-agent writes only; cross-writes require intercom handoff. Resolved decisions fold into `specs/00X-*.md` § N.M sub-section or `specs/_decisions/` archive; transient files deleted post-decision. |

Cross-ownership requires handoff via intercom (see § 3).

## 3. Communication contract

Two channels only: **intercom** for live coordination, **files** for
durable handoffs.

### 3.1 Intercom message prefixes

Every intercom message starts with one of:

- `[meta]` — from `sub-meta`
- `[dev]` — from `sub-tmux`
- `[review]` — from `review-subagent-tmux`

Then a context tag, then the body:

```
[dev] spec 002 §3.3 ready for review
[review] spec 002 [verdict: Approve with comments] round 1
[meta] spec 002 status → Approved; README updated
```

Context tags: `spec 00X §Y`, `PR N`, `tests/__contracts__/00X.md`.

### 3.2 File handoffs (durable)

| From | To | File | Trigger |
|---|---|---|---|
| `sub-tmux` | `review-subagent-tmux` | `specs/00X-*.md` | spec lands, intercom `[dev] ... ready for review` |
| `review-subagent-tmux` | `sub-meta` | `specs/_reviews/00X-<round>.md` | verdict returned, intercom `[review] [verdict: ...]` |
| `sub-meta` | all | `specs/README.md` | status transition, intercom `[meta] spec 00X status → X` |
| `sub-tmux` | `sub-meta` + `review-subagent-tmux` | `tests/__contracts__/00X.md` | new row added OR status flipped, intercom `[dev] spec <id> contract row added` or `[dev] spec <id> §<Y> green — row flipped` |
| `review-subagent-tmux` | all | `CHANGELOG.md` + `package.json` | release, intercom `[review] released vN.M.P` |

### 3.3 Verdict semantics

| Verdict | Effect on spec status | Effect on release |
|---|---|---|
| `Approve` | Draft → Approved | Cleared to merge + release |
| `Approve with comments` | Draft → Approved; comments tracked in `specs/_reviews/00X-<round>.md` | Cleared to merge + release; comments may be follow-up issues |
| `Request changes` | stays Draft; sub-tmux iterates and re-requests review | blocked |
| `Block` | stays Draft; spec needs redesign round | blocked |

Two consecutive `Request changes` rounds on the same spec line
escalate to `sub-meta` for contract arbitration before the third
round.

## 4. TDD cycle per acceptance criterion

For each row in spec §5:

1. **`sub-tmux` pre-step**: when `sub-meta` announces the spec is
   Approved, `sub-tmux` adds rows to `tests/__contracts__/00X.md`
   mapping each acceptance criterion in spec §5 to a placeholder
   test file + case name. All rows start at `status: red`.
   Intercom `[dev] spec <id> contract matrix ready — N rows, all red`.
2. **`sub-tmux` red**: writes the test file (or extends an
   existing one) with the failing case. Runs `bun test <path>` and
   confirms the failure is for the documented reason.
3. **`sub-tmux` green**: implements the minimum code to make the
   test pass. No extra behavior. Flips the contract row to
   `green`; intercom `[dev] spec <id> §<Y> green — row flipped`.
4. **`sub-tmux` refactor**: cleans up while keeping the test
   green. Commit per cycle, message format
   `spec 00X §Y.{red|green|refactor}`.
5. **`review-subagent-tmux` audit** (on PR review): checks the
   PR's test commits against the corresponding
   `tests/__contracts__/00X.md` row. Missing red commits,
   reordered commits, or un-flipped row status are findings.

## 5. Release protocol

Owned by `review-subagent-tmux` (steps 1–6, 8–10) and `sub-meta`
(step 7). Triggered by an `Approve` (or `Approve with comments`)
verdict on the spec.

1. **Pre-merge divergence check (sub-meta owns, before any merge)**:
   - `git fetch origin`.
   - `git rev-list --left-right --count <branch>...origin/main` —
     capture ahead/behind numbers.
   - `git diff --name-status <branch>...origin/main` — capture
     file-level divergence.
   - Intercom to reviewer (or to user if single-session): `[meta]
     pre-merge check: ahead=X behind=Y divergent files=[...] —
     confirm?` with the numbers and the file list.
   - **Do not proceed to step 1 if the branch is behind `origin/main`
     by any non-zero number, without explicit go-ahead.** Local tests
     passing ≠ merge is safe; other branch's new work can break
     your changes via 3-way conflict.

2. Verify all PRs in spec §6 are merged to the feature branch.
3. Run the full test suite: `bun test ./tests
   ./extensions/subagent/__tests__`. All must pass. **The number of
   files in this run MUST equal or exceed the count of test files
   in `origin/main`**; if the synced branch has fewer files, the
   rebase (or merge) is incomplete — stop and re-sync.
4. Update `CHANGELOG.md` with the spec's title + PR list.
5. Bump `package.json` version to the spec's target version.
6. Merge feature branch → main (squash per spec §6 PR plan).
7. Archive spec: `specs/00X-<name>.md` →
   `specs/archive/00X-<name>.vN.md`. Update the **archived
   copy's** frontmatter `Status` field to `Implemented` (this is
   the `Approved → Implemented` transition; per § 2 directory
   ownership, `review-subagent-tmux` owns this edit, not
   `sub-meta`).
8. **Local install smoke test (sub-meta owns)**:
   - `npm install` (or `npm pack` + install) against merged main.
   - Open a Pi session; `/reload` to pick up the new extension.
   - Exercise one representative end-to-end flow for the released
     feature area (sub-meta picks the flow per release; flows for
     spec 002 would naturally include ad-hoc pane + `/agents:show`).
   - **Three-state report** (sub-meta → reviewer via intercom):
     - `[meta] smoke passed for vN.M.P` — green; gate clears; reviewer proceeds to step 9.
     - `[meta] smoke failed (blocker) for vN.M.P` — red; gate holds; reviewer arbitrates blocker vs fix-and-retry before any step 9 (see step 8.1 hotfix path).
     - `[meta] smoke failed (follow-up) for vN.M.P` — amber; reviewer arbitrates proceed-with-follow-up vs hold-and-fix.
9. **`npm publish` [POST-V0.2.0]** — currently gated OFF. For
   v0.2.0 releases, this step is skipped. To enable for a future
   release, amend § 5 step 9 to remove the `[POST-V0.2.0]` gate.
   When enabled: `npm publish` against the version bumped in
   step 5. **Smoke surface required**: a `smoke/smoke-v<N.M.P>.mjs`
   script must exist that exercises the new release surface;
   reviewer audits this before allowing step 9 to fire.
10. Intercom `[review] released vN.M.P — spec 00X archived`.
11. `sub-meta` updates `specs/README.md` status to `Implemented`.

### 5.1.1 Hotfix path (when smoke fails)

When `sub-meta`'s smoke report is `[meta] smoke failed (blocker) for vN.M.P`:

1. Halt the release protocol. Mark `release_halted: true` in
   reviewer's round notes.
2. **`review-subagent-tmux` creates the hotfix branch**:
   `git checkout -b hotfix/v<N.M.P> main` in a temp worktree.
3. Notify `sub-tmux` with the full smoke failure log:
   `[review] spec <id> release halted — smoke blocker — branch
   hotfix/v<N.M.P> ready`.
4. `sub-tmux` writes the fix on the hotfix branch (single commit
   or one-per-bug). Commit format: `hotfix v<N.M.P> — <fix description>`.
5. `sub-tmux` notifies: `[dev] hotfix ready — branch hotfix/v<N.M.P>, <sha>`.
6. `review-subagent-tmux` re-runs the full suite on the hotfix
   branch (`§ 5 step 3`).
7. If green: notify `sub-meta` to re-run smoke on the hotfix branch.
8. If `sub-meta`'s re-run is green: proceed to step 9 (publish).
9. If two consecutive hotfix cycles still fail: escalate to
   `sub-meta` for arbitration.

When `sub-meta`'s smoke report is `[meta] smoke failed (follow-up) for vN.M.P`:

1. `review-subagent-tmux` arbitrates (per § 1.2): proceed with
   follow-up vs hold-and-fix.
2. If proceed: log the follow-up in `CHANGELOG.md` "Known issues"
   section.
3. If hold-and-fix: same as block path above.

### 5.1.2 Lessons schema

After each release (or when a non-trivial learning happens),
`sub-meta` appends one entry to `.ai-state/lessons.md` using the
schema:

```markdown
## YYYY-MM-DD — spec <id> v<M.m.p> [optional tag]

### What worked
- (concrete, observable, reusable)

### What didn't work
- (concrete, observable, anti-pattern)

### Pattern to repeat
- (description, when to apply)

### Anti-pattern to avoid
- (description, what to do instead)

### Charter amendment proposal
- (new finding IDs to bring to next charter review round, or NONE)
```

This file is append-only. Sub-meta uses it as input when proposing
charter amendments. Reviewer may reference entries in verdict
rationales.

### 5.2 Rollback path

`npm unpublish <pkg>@<ver>` within npm's current unpublish window
(verify via `npm help unpublish` at rollback time) is the rollback
primitive if step 9 ever fires and the release turns out broken.
Combined with `npm deprecate <pkg>@<ver>` as a soft-revoke.
Reviewer + sub-meta jointly file a blocker; new fix PR; re-run
steps 1–9. For `[POST-V0.2.0]`-gated releases (v0.2.0 included),
no rollback path needed because no publish happened.

## 6. Charter amendments

This charter is itself a spec-like document. Changes require:

- `sub-meta` drafts the diff.
- `review-subagent-tmux` reviews for conflict with existing
  contracts.
- Round ends in `Approve` or `Approve with comments` before
  merge.

Verdict file location for charter amendments:
`specs/_reviews/_charter-<round>.md`.

## 7. Open questions

- Spec 002 §10 reserves v2 features. When those land, the TDD
  cycle in § 4 will need to be extended to parallel/chain
  acceptance criteria; this charter will be amended then.
- The `tests/__contracts__/` directory does not yet exist. Its
  creation is `sub-meta`'s first deliverable under this charter.
- `[POST-V0.2.0]` gate (C2-F5) is single-version. Future
  per-version publish-gate flips will require charter amendments.
  A header-driven `Publish: yes|no` field in `package.json` (or
  equivalent) would be cleaner than version-suffixed gates;
  deferred to a later charter round.