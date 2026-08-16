# Charter v2 — Candidates

**Status**: Draft (candidates for next _charter-N review round)
**Owner**: sub-meta (drafts) → review-subagent-tmux (verdict)
**Base**: `docs/team-charter.md` v1 (current Implemented state)
**Source**: synthesis of options analysis (2026-08-16)

This file collects the boundary-sharpen amendments proposed after the
three-agent workflow review. Each candidate is self-contained and
either land-able standalone or withdrawable without affecting others.

---

## C1. Resolve `tests/__contracts__/00X.md` ownership conflict

### Problem
charter v1 has an internal contradiction:

- **§2 directory table** says `tests/__contracts__/00X.md` is owned by `sub-meta`.
- **§3.2 handoff table row 5** says `sub-tmux` writes to it.
- **§1.3 deliverables** lists `tests/__contracts__/00X.md` as a sub-meta deliverable.
- **§4 step 1** says `sub-meta` adds the initial row when the spec is approved.

Three different writers (sub-meta, sub-tmux, both) for the same file → silent
ownership conflicts, especially when sub-tmux needs to flip a row's status
during TDD.

### Resolution (parity with spec body ownership)
`tests/__contracts__/00X.md` is owned by **sub-tmux** — same pattern as
`specs/00X-*.md` (sub-tmux writes body, sub-meta only updates `specs/README.md`
index). This removes the contradiction and consolidates "TDD engineer
manages their contract matrix".

### Proposed diff

**§1.3 deliverables** — update row:
```diff
- `tests/__contracts__/00X.md` — test contract matrix per spec
+ `tests/__contracts__/00X.md` — (sub-tmux owns per §2; sub-meta monitors
+   via `.ai-state/tdd-log.jsonl` and reads for status reporting)
```

**§2 directory table** — replace row:
```diff
- | `tests/__contracts__/00X.md` | `sub-meta` | Acceptance ↔ test matrix per spec |
+ | `tests/__contracts__/00X.md` | `sub-tmux` | Acceptance ↔ test matrix. sub-tmux adds rows when spec is approved (`[dev] spec <id> contract matrix ready`), updates status column (`red` → `green`) per TDD cycle. |
```

**§3.2 handoff table row 5** — update receivers:
```diff
- | `sub-tmux` | `review-subagent-tmux` | `tests/__contracts__/00X.md` | new acceptance criterion, intercom `[dev] ... contract row added` |
+ | `sub-tmux` | `sub-meta` + `review-subagent-tmux` | `tests/__contracts__/00X.md` | new row added OR status flipped, intercom `[dev] spec <id> contract row added` or `[dev] spec <id> §<Y> green — row flipped` |
```

**§4 step 1** — rewrite:
```diff
- 1. **`sub-meta` pre-step**: when the spec is approved, `sub-meta`
-    adds a row to `tests/__contracts__/00X.md` mapping the
-    acceptance criterion to a placeholder test file + case name.
-    Intercom `[meta] spec 00X contract row N added`.
+ 1. **`sub-tmux` pre-step**: when sub-meta announces the spec is Approved,
+    `sub-tmux` adds rows to `tests/__contracts__/00X.md` mapping each
+    acceptance criterion in spec §5 to a placeholder test file + case name.
+    All rows start at `status: red`. Intercom `[dev] spec <id> contract matrix
+    ready — N rows, all red`.
```

### Acceptance criteria
- [ ] §2 explicit ownership (sub-tmux) matches §3.2 receivers (sub-meta + reviewer)
- [ ] §1.3 deliverables row reflects sub-tmux ownership
- [ ] Stat flip during TDD is unblocked (sub-tmux writes row status, no sub-meta ack needed)

---

## C2. Hotfix path for halted releases

### Problem
charter §5 spec describes a clean release path (steps 1-10). When sub-meta's
smoke test fails (step 7), the path forward is undefined:

- No branch convention for the fix.
- No ownership of the branch-creation step.
- No arbitration rule for "two consecutive hotfix cycles still fail".

This gap was observed in practice (e.g. spec 002/003/004 cycles where smoke
runs occasionally surfaced UX issues that needed a fix release).

### Resolution
Add a new sub-step **§5 step 6.7.1 (Hotfix path)** describing the fix loop.

### Proposed diff

Insert after the current §5 step 7 prose:

```markdown
### 5.1.1 Hotfix path (when smoke fails)

When sub-meta's smoke report is `[meta] smoke failed (blocker) for vN.M.P`:

1. Halt the release protocol. Mark `release_halted: true` in the round notes.
2. **`review-subagent-tmux` creates the hotfix branch**: `git checkout -b
   hotfix/v<N.M.P> main` in a temp worktree. (You own hotfix branches — sub-tmux
   does NOT create them.)
3. **Notify sub-tmux** with the full smoke failure log:
   ```
   [review] spec <id> release halted — smoke blocker — branch hotfix/v<N.M.P> ready
   - smoke failure log: <paste or path>
   - branch: hotfix/v<N.M.P>
   - awaiting [dev] hotfix ready
   ```
4. **sub-tmux writes the fix** on the hotfix branch (single commit or one-per-bug).
   Commit format: `hotfix v<N.M.P> — <fix description>`.
5. sub-tmux notifies: `[dev] hotfix ready — branch hotfix/v<N.M.P>, <sha>`.
6. **`review-subagent-tmux` re-runs the full suite** on the hotfix branch
   (charter §5 step 2 in the hotfix branch).
7. If green: notify sub-meta to re-run smoke on the hotfix branch.
8. If sub-meta's re-run is green: proceed to step 8 (publish).
9. If two consecutive hotfix cycles still fail: escalate to sub-meta for arbitration.

When sub-meta's smoke report is `[meta] smoke failed (follow-up) for vN.M.P`:

1. `review-subagent-tmux` arbitrates (per §1.2): proceed with follow-up vs hold-and-fix.
2. If proceed: log the follow-up in CHANGELOG.md "Known issues" section.
3. If hold-and-fix: same as block path above.
```

Also update **§2 directory table** to add the new branch territory:
```diff
+ | `hotfix/v<N.M.P>` branches | `review-subagent-tmux` | Created when smoke fails; sub-tmux commits fixes but does not create the branch. |
```

### Acceptance criteria
- [ ] Smoke blocker has a defined resolution loop
- [ ] Hotfix branch ownership is explicit (review-subagent-tmux creates)
- [ ] Escalation rule prevents infinite hotfix cycles

---

## C3. Smoke-test failure suspension rule

### Problem
When sub-meta is responsible for the smoke test (charter §5 step 7), they
are simultaneously responsible for dispatching sub-tmux's next spec,
monitoring TDD progress, and writing `.ai-state/`. Debugging a smoke
failure consumes context aggressively; mixing it with coordination work
degrades both.

### Resolution
Add a hard rule in sub-meta's charter section: **suspend all non-coordination
tasks when a smoke test fails; return to coordination only after resolution**.

### Proposed diff

Append to **§1.3 sub-meta**:

```markdown
- **Smoke test failure discipline**: when a smoke test fails, suspend all
  non-coordination tasks (pending TDD monitoring, new spec dispatch, charter
  amendment drafting). Return to coordination only after the smoke test
  resolves (passed, accepted follow-up, or aborted). Reason: smoke test
  debugging and dispatch share context; mixing them causes context bloat
  and degrades both workstreams.
```

### Acceptance criteria
- [ ] Sub-meta's charter section explicitly states the suspension rule
- [ ] The rule is also referenced in the prompt-derived sub-meta.md (already done)

---

## C4. Lessons-learned schema

### Problem
Current `.ai-state/lessons.md` schema is unspecified → agents either skip it
or write free-form entries that don't aggregate. Cross-release learning
is lost.

### Resolution
Add a §5.1.2 (Lessons schema) with a fixed template.

### Proposed diff

Append to §5:

```markdown
### 5.1.2 Lessons schema

After each release (or when a non-trivial learning happens), sub-meta appends
one entry to `.ai-state/lessons.md` using the schema:

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

This file is append-only. sub-meta uses it as input when proposing charter
amendments. Reviewer may reference it in verdict rationales.
```

### Acceptance criteria
- [ ] Schema is fixed and grep-able
- [ ] Used as input for charter amendment proposals
- [ ] Append-only invariant is enforceable

---

## C5. (Optional) Status state-machine single source of truth

### Problem
Spec status (Draft → Approved → Implemented) is updated in two places:
- `specs/README.md` index (sub-meta owns)
- `specs/00X-*.md` frontmatter `Status` field (split ownership — sub-meta for
  Draft → Approved, review-subagent-tmux for Approved → Implemented post-archive)

The split is documented but causes "which file is the source of truth?" debates
when something looks inconsistent.

### Resolution (lightweight)
Add a single sentence to §1.3 and §1.2 clarifying that the source of truth
for each spec's status is whichever file was most recently updated. Both
edits must be done together; if the index says Approved but the spec file
still says Draft, that's a bug (either in the editor or in the
synchronization).

### Proposed diff

Append to **§1.3**:
```markdown
- **Status state-machine invariant**: `specs/README.md` and
  `specs/00X-*.md` frontmatter `Status` field MUST agree after each
  transition. The most recent edit wins as the source of truth for
  the next reader. If they disagree, the agent who performed the
  most recent edit is responsible for fixing the other file.
```

Append to **§1.2**:
```markdown
- **Status state-machine invariant**: when archiving a spec (post-merge
  `Approved → Implemented`), the archived copy's frontmatter `Status` field
  is updated in the same commit as the `mv`. The pre-archive file retains
  `Approved` until the move.
```

### Acceptance criteria
- [ ] README and spec frontmatter status always agree post-transition
- [ ] No re-litigation of "who owns the Approved → Implemented edit"

---

## Summary

| # | Candidate | Severity | Standalone? | Risk |
|---|---|---|---|---|
| C1 | Resolve `tests/__contracts__/00X.md` ownership | HIGH (silent conflict) | Yes | Low |
| C2 | Hotfix path for halted releases | HIGH (uncovered territory) | Yes | Low |
| C3 | Smoke-test failure suspension rule | MED | Yes | Low |
| C4 | Lessons-learned schema | MED | Yes | Low |
| C5 | Status state-machine single source of truth | LOW | Yes | Low |

**Recommendation**: bundle C1+C2+C3+C4 in one review round (all sharpen
existing boundaries). C5 can land separately or with the bundle.

**Next step**: trigger a `_charter-3.md` review round with this file as
the diff base. Round must end in `Approve` or `Approve with comments`
before merging.

---

## Open questions

- **[OPEN]** Should C5 be bundled with C1-C4 or land separately? Bundle is
  cheaper, but C5 is a low-severity cleanup while C1-C4 are driven by
  real ambiguity. sub-tmux should weigh in.
- **[OPEN]** Is the hotfix branch name `hotfix/v<N.M.P>` consistent with
  the existing version v0.2.0-or-later convention? (Yes, per charter §5
  step 8 which already uses `vN.M.P` for the publish gate.)
- **[OPEN]** Should sub-meta's smoke failure suspension rule also be a
  prompt-engineering invariant (e.g. embedded in sub-meta.md's HARD
  RULES)? Already done in v2 prompts — confirm.
