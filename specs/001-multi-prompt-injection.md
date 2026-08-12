# Spec 001: Multi-Prompt Fragment Injection (Static, Spawn-Time)

| Field | Value |
|---|---|
| **Status** | Approved (entering implementation) |
| **Target version** | `0.1.0` |
| **Scope** | This fork only (`@nexquark/pi-subagent-fragments`) |
| **Upstream base** | `vanillagreencom/vstack@faeb65af` (`pi-agents-tmux` 2.8.1) |
| **PRs** | PR 1–5 on `feature/fragments` (see § 6) |
| **v2 reserved** | § 11 — Runtime switching deferred |

---

## 1. Background and Goal

`pi-agents-tmux` (the upstream this fork tracks) models each agent as a
single `systemPrompt: string` field on `AgentConfig`. The string is sourced
from the markdown body of the agent file, written to a temp file, and
passed verbatim as a single `--append-system-prompt` argument when the
agent's pane or one-shot subprocess is spawned. There is no way to compose
the system prompt from multiple declared fragments — every agent file must
inline its entire prompt body.

This is fine for simple agents, but two common patterns hurt:

1. **Shared conventions** that should apply to many agents (e.g., "always
   respond in the project's preferred tone and format", "always refuse to
   modify files outside this directory") must be **copy-pasted into each
   agent's body**. Drift is inevitable.
2. **Layered prompts** (e.g., a base role + a project-specific overlay +
   an experimental A/B prompt) require editing multiple agent files in
   lockstep, again encouraging drift.

**Goal of this spec (v1)**: let an agent's frontmatter declare an array of
fragment file paths in addition to its body. At spawn time, the fragments
are joined with the body in a deterministic order into a single prompt
string, which is then passed to the existing `--append-system-prompt`
mechanism unchanged. No new spawn flag, no new CLI surface — only new
frontmatter fields and a new join function.

**Non-goal (v1)**: mutating the system prompt after spawn. See § 11
(Deferred features, v2).

---

## 2. Current State Analysis

### 2.1 Agent definition

`extensions/subagent/agents.ts`:

- **L36** — `AgentConfig.systemPrompt: string` — single string field, no
  fragment concept.
- **L167** — `systemPrompt: body,` — body is the markdown content
  following frontmatter, parsed by
  `parseFrontmatter<Record<string, unknown>>(content)` and split into
  `frontmatter` + `body`.

`AgentConfig` interface (L22–L48) currently exposes:
`name`, `description`, `color?`, `denyTools?`, `allowedSubagents?`,
`model?`, `effort?`, `pane`, `systemPrompt`, `source`, `filePath`.

No `systemPromptFragments` field exists. No `systemPromptMode` exists.

### 2.2 Prompt materialization at spawn time

`extensions/subagent/pane.ts` (pane spawn):

- **L508** — `export async function writePromptToTempFile(agentName, prompt)`
  — helper that writes `prompt` to a temp file and returns its path.
- **L555** — `const promptFile = path.join(promptsDir, \`${safeName}.md\`);`
  — persistent prompt file inside the session's `prompts/` dir.
- **L558** — `await atomicWriteFile(promptFile, agent.systemPrompt);`
  — writes the raw string to disk.
- **L560** — `const args = [..., "--append-system-prompt", promptFile];`
  — passes the file path to the spawned `pi` subprocess.

`extensions/subagent/runner.ts` (one-shot spawn):

- **L21** — `writePromptToTempFile,` imported from `./pane.js`.
- **L631–L636** — guarded by `if (agent.systemPrompt.trim())`:
  ```
  const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
  tmpPromptPath = tmp.filePath;
  args.push("--append-system-prompt", tmpPromptPath);
  ```
- **L974–L977** — temp file is `unlinkSync`'d after the run completes.

Both call sites treat `agent.systemPrompt` as a single pre-formed string.
The `writePromptToTempFile` helper accepts that string verbatim and
returns a `{ dir, filePath }` pair.

### 2.3 What is missing

- A way for the agent file to declare **additional prompt fragments**
  beyond its body.
- A way to control the **join order** when a body and multiple fragments
  coexist.
- A way to control **override semantics** (e.g., body may want to append
  *after* a fragment, or a fragment may want to *replace* the body).

---

## 3. Design

### 3.1 New frontmatter fields

```yaml
---
name: reviewer
description: ...
systemPromptMode: append      # optional, default
systemPromptFragments:        # optional
  - ./fragments/reviewer-base.md
  - ./fragments/project-overlay.md
---

You are the reviewer agent. Your job is to ...
```

- **`systemPromptFragments?: string[]`** — paths to additional markdown
  files whose contents are joined with the body at spawn time.
- **`systemPromptMode?: "append" | "replace"`** — how the fragments are
  combined with the body.
  - `"append"` (default): `fragments[0] + sep + fragments[1] + ... + sep + body`.
  - `"replace"`: `fragments[0] + sep + fragments[1] + ... + sep + body`,
    but the first fragment is conceptually treated as **replacing** the
    body — semantically the same as append for v1, but the mode is
    captured for clarity and to leave room for v2 semantics. See § 11.
- Fragment paths are resolved **relative to the agent file's directory**.
  Absolute paths are allowed but rejected if they escape the agent file's
  directory after normalization (defense against prompt-file injection from
  arbitrary filesystem locations).

### 3.2 Join rule

The final prompt is assembled by a single pure helper:

```
function composeAgentPrompt(input: {
  body: string;
  fragments: string[];
  mode: "append" | "replace";
  separator?: string;   // default "\n\n---\n\n"
}): string
```

The helper returns the joined string. It does **no I/O** — fragment
loading is done by the caller so this helper is trivially unit-testable
in isolation.

For v1, both modes produce identical joining. The mode is recorded in
metadata so v2 can differentiate behavior (e.g., `replace` may eventually
mean "first fragment is the canonical role; body is appended after").

### 3.3 I/O and lifecycle

`agents.ts` becomes responsible for **reading each fragment path** during
agent parsing and storing the **resolved, joined string** in
`AgentConfig.systemPrompt`. After parsing, the rest of the system is
unaware that fragments existed — `pane.ts` and `runner.ts` see a single
`systemPrompt` string exactly as before.

This means:

- No changes to `pane.ts:558` or `runner.ts:632` call sites are required
  for the v1 happy path. _But_ — see § 4.3 for a deliberate refactor that
  shares the join logic.
- No changes to the spawned `pi` subprocess CLI surface.

### 3.4 Fragment file reading

- Read each fragment path with `fs.readFileSync` (matches the existing
  pattern in `loadAgentsFromDir`).
- Encoding: UTF-8.
- Missing fragment file → **fail agent load with a clear error**
  naming the agent and the missing path. Do not silently skip.
- Empty fragment file → treat as empty string; do not error.
- Fragment file is not a regular file (e.g., directory, symlink loop) →
  fail agent load.

### 3.5 Safety: path containment

Fragment resolution is symmetric to the existing source block's `filePath`:

- `filePath` for an agent discovered under `/agents/reviewer.md` is
  `/agents/reviewer.md`.
- A fragment declared as `../shared/base.md` resolves to
  `/shared/base.md`.
- `path.resolve(agentDir, fragmentPath)` is used.
- The resolved path is **not** required to live under the agent file's
  directory — common-case fragments may legitimately live in a sibling
  `fragments/` directory. **Path-escape protection is intentionally
  minimal in v1**: absolute paths are allowed (useful for
  `~/.pi/agent/fragments/`), and only symlink loops / non-existent paths
  are rejected. Tighter containment belongs in v2.

---

## 4. Implementation Details

### 4.1 `extensions/subagent/agents.ts`

#### 4.1.1 Extend `AgentConfig`

Add fields:

```ts
systemPromptFragments?: string[];
systemPromptMode?: SystemPromptMode;  // = "append" | "replace"
```

#### 4.1.2 Parse new frontmatter keys

In the loop body of `loadAgentsFromDir` (around L120–L170), after
`parseFrontmatter`, parse:

- `parseToolList`-style parser for `systemPromptFragments` (string
  comma-separated or YAML list).
- `asString`-style parser for `systemPromptMode`, validated against
  `["append", "replace"]`. Unknown values fall back to `"append"` and
  emit a one-time `console.warn`.

#### 4.1.3 Materialize the joined string

After constructing the `AgentConfig` object (L143–L172), **before**
pushing it into the `agents` array, call:

```ts
const resolvedFragments = (systemPromptFragments ?? []).map((p) =>
  fs.readFileSync(path.resolve(path.dirname(filePath), p), "utf-8"),
);

const composed = composeAgentPrompt({
  body,
  fragments: resolvedFragments,
  mode: systemPromptMode ?? "append",
});

agents.push({
  ...rest,
  systemPrompt: composed,
  // Retain fragments list for diagnostics (e.g., `/agents show`)
  systemPromptFragments,
  systemPromptMode: systemPromptMode ?? "append",
});
```

#### 4.1.4 Frontmatter aliases

Accept `system-prompt-fragments` / `systemPromptFragments` and
`system-prompt-mode` / `systemPromptMode` interchangeably (YAML + TOML
keys; the vstack fork normalizes snake/kebab/camelCase for some fields
already — match that convention).

### 4.2 New file: `extensions/subagent/prompt-compose.ts`

```ts
export type SystemPromptMode = "append" | "replace";

export const DEFAULT_PROMPT_SEPARATOR = "\n\n---\n\n";

export interface ComposeAgentPromptInput {
  body: string;
  fragments: string[];
  mode: SystemPromptMode;
  separator?: string;
}

export function composeAgentPrompt(input: ComposeAgentPromptInput): string {
  const sep = input.separator ?? DEFAULT_PROMPT_SEPARATOR;
  const parts = [...input.fragments, input.body]
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // Both modes produce identical output for v1.
  return parts.join(sep);
}
```

Rationale for a separate file:

- Single source of truth for the join rule.
- Trivially testable in isolation (no fs, no async, no globals).
- Future v2 changes (runtime switching, mode-aware ordering) land in
  one place rather than two call sites.

### 4.3 Share the helper across call sites

Although v1 does not strictly require touching `pane.ts` or `runner.ts`
(because `systemPrompt` is already the joined string), refactor both
spawn-time call sites to import `composeAgentPrompt` so that the join
rule has **one definition** even if v2 changes the semantics:

- `pane.ts:558` — replace `await atomicWriteFile(promptFile, agent.systemPrompt)`
  with `await atomicWriteFile(promptFile, composeAgentPrompt({ body: agent.systemPrompt, fragments: [], mode: agent.systemPromptMode }))`.
  This is a no-op for v1 (fragments is empty because they were already
  joined into `agent.systemPrompt`), but it ensures future changes don't
  drift between the two call sites.
- `runner.ts:631–L636` — analogous change.
- `writePromptToTempFile` in `pane.ts:508` continues to accept a single
  string; it does not need to know about fragments.

### 4.4 Agent browser / `/agents show`

The `systemPromptFragments` and `systemPromptMode` fields are already
exposed in the `AgentConfig` shape used by `browser/agents-tab.ts:128`
(reads `agent.systemPrompt.trim()`). v1 adds:

- Show the fragment list (with file existence check) in the agent detail
  view.
- Show the composed prompt byte length next to the body length so the
  user can see at a glance that fragments were joined.

### 4.5 Tests

`tests/prompt-compose.test.ts` (new file):

1. **Empty fragments** — body only, joined = body trimmed.
2. **Single fragment** — body + one fragment, joined = fragment + sep + body.
3. **Multi-fragment with override priority** — three fragments + body;
   verify the order matches the array order; verify that an empty
   fragment is silently skipped (does not inject double-separator).
4. **Mode is recorded but does not change output for v1** — `append` and
   `replace` produce identical strings.

`tests/agents-fragments.test.ts` (new file):

1. Agent file with `systemPromptFragments: ["./f1.md"]` resolves the
   fragment relative to the agent file's dir, joins correctly.
2. Agent file with a missing fragment path fails load with a clear
   error naming the path.
3. Agent file with `systemPromptMode: "invalid"` falls back to `append`
   and emits the warning.

`tests/spawn-prompt-compose.test.ts` (new file):

1. Snapshot of `composeAgentPrompt` output for a reference agent
   config: body `B`, fragments `["F1", "F2", "F3"]`, mode `append`.
   Expected: `F1 + sep + F2 + sep + F3 + sep + B`.
2. Integration: `writePromptToTempFile(agent.name, composeAgentPrompt(...))`
   yields a file whose contents equal the snapshot.

---

## 5. Acceptance Criteria

- [ ] An agent file with `systemPromptFragments: [...]` produces a
      single composed prompt string in `agent.systemPrompt` at load time.
- [ ] Both `system-prompt-fragments` and `systemPromptFragments` (kebab
      and camelCase) frontmatter keys are accepted.
- [ ] Both `append` and `replace` modes produce identical output for v1
  (deterministic, no side-channel differences).
- [ ] Missing fragment file path produces an error that names the agent
      and the missing path; agent load fails.
- [ ] Empty fragment file is treated as empty (no double-separator).
- [ ] `pane.ts:558` and `runner.ts:632` both import and call
      `composeAgentPrompt` (no direct `agent.systemPrompt` string writes).
- [ ] `/agents show <name>` displays the fragment paths and the composed
      prompt length.
- [ ] `bun test ./tests ./extensions/subagent/__tests__` passes.
- [ ] No regression in existing pane lifecycle, session persistence, or
      task dispatch behavior.

---

## 6. Implementation Steps (PR 1–5)

All PRs target `feature/fragments` and are squash-merged into `main` once
v1 is feature-complete.

### PR 1 — `feat: add composeAgentPrompt helper + tests`
- New file `extensions/subagent/prompt-compose.ts`.
- New file `tests/prompt-compose.test.ts` with the four cases in § 4.5.
- No call-site changes yet.

### PR 2 — `feat: parse systemPromptFragments frontmatter`
- Extend `AgentConfig` (§ 4.1.1).
- Add frontmatter parsing (§ 4.1.2) with kebab/camelCase aliases.
- Add `tests/agents-fragments.test.ts` cases 2–3.
- _Do not_ wire fragment reads into the materialization step yet — only
  surface the parsed fields on `AgentConfig`.

### PR 3 — `feat: materialize fragments into systemPrompt at load time`
- Add fragment file reads in the agent load loop (§ 4.1.3).
- Add `tests/agents-fragments.test.ts` case 1.
- Wire missing-file and empty-file handling.

### PR 4 — `feat: route both spawn sites through composeAgentPrompt`
- Refactor `pane.ts:558` and `runner.ts:632` (§ 4.3).
- Add `tests/spawn-prompt-compose.test.ts`.
- Verify no regression in `tests/` and
  `extensions/subagent/__tests__/`.

### PR 5 — `feat: agent browser shows fragments`
- Update `browser/agents-tab.ts` to display fragment list and composed
  prompt length.
- Update README quick-start to show the new frontmatter fields.

Each PR is independently mergeable; PR N+1 builds on PR N.

---

## 7. Risks and Open Questions

1. **Drift risk on `mode: "replace"` semantics**. Both modes produce
   identical output in v1. Future readers may assume they differ. The
   mode is captured in metadata but is otherwise inert. Document this
   in code with a `// v1: append and replace produce identical output`
   comment.
2. **Long fragment lists at spawn time**. Fragment reads are
   synchronous (`fs.readFileSync`). An agent declaring 50 fragments
   across 50 files will stall agent discovery by 50 file reads. For v1
   this is acceptable (typical agents have < 5 fragments); a future
   optimization could batch-read or use async I/O.
3. **Path traversal**. `path.resolve` does not prevent `../` escape.
   Intentional for v1 (sibling `fragments/` dirs are useful). Tighter
   containment (e.g., require resolved path to live under
   `agentDir/fragments/`) is a v2 consideration.
4. **Symlink loops**. `fs.readFileSync` will throw `ELOOP` if a fragment
   path loops. Catch and surface as "fragment unreadable: <path>".
5. **Fragment files containing frontmatter**. Should they be parsed?
   **No** — fragments are raw markdown bodies, joined verbatim. Their
   frontmatter (if any) is included literally. This is intentional to
   avoid surprise; document it in the spec and README.

---

## 8. Spec After-Completion Archive Path

Once v1 merges to `main`:

- Move this spec from `specs/001-multi-prompt-injection.md` (status
  `Approved`) to `specs/archive/001-multi-prompt-injection.v1.md`
  (status `Implemented`).
- Update `specs/README.md` index entry.
- Begin `specs/002-runtime-system-prompt-switching.md` for v2.

---

## 9. Extension surface (reserved)

This spec **does not** implement runtime prompt switching. The section
numbering is reserved for v2:

- § 10 — Reserved (skipped; will be filled by runtime-switching spec).
- § 11 — Deferred features (v2). See below.

---

## 10. Reserved

Intentionally empty. Reserved for v2 runtime-switching spec to maintain
stable chapter numbering.

---

## 11. Deferred Features (v2)

### 11.1 Runtime system prompt switching

**Why deferred**: § 9 in the original draft covered this; during planning
we agreed v1 should focus on static composition (80% of use cases) and
ship before tackling the ~200 lines + new pane control protocol +
`before_agent_start` hook that runtime switching requires.

**Reserved interface (v1)**:

- `composeAgentPrompt` is designed as a **pure function** so v2 can wrap
  it with side effects (logging, layer tracking) without refactoring.
- The `mode` field is captured on `AgentConfig` even though v1 produces
  identical output for both modes — v2 will differentiate.
- `agents.ts` does not strip fragment paths; the `/agents show` UI
  surfaces them — v2 can leverage this for "swap fragment X to fragment
  Y" UX.

**Reserved state model** (preview, not implemented):

```ts
type EffectivePromptState = {
  basePrompt: string;
  dynamicLayers: Array<{
    mode: "append" | "replace";
    content: string;
    reason?: string;
    appliedAt: number;
  }>;
};
```

Replacement rule (reserved for v2): first `replace` discards `basePrompt`;
subsequent `replace` discards prior layers; all `append`s stack to tail;
applied at each `before_agent_start` turn boundary.

**Required v2 work**:

- A new `update_system_prompt` tool on the parent.
- A control-channel push to the spawned pane subprocess.
- Hook into pi's `before_agent_start` event in the spawned agent's
  parent session (this requires upstream cooperation — possibly an
  extension hook in pi itself, or a workaround using `PI_SUBAGENT_*`
  env vars + a custom dispatcher inside the spawned pane).
- Spec 002 will own the full v2 design.

### 11.2 Path containment hardening

Tighten fragment path resolution: by default require the resolved path
to live under `agentDir/fragments/`, with an opt-out escape hatch for
legacy layouts.

### 11.3 Async fragment I/O

If a typical agent declares > 20 fragments, switch agent load to async I/O.

### 11.4 Fragment inheritance

Let fragments themselves declare nested fragment paths (recursive
expansion with cycle detection).

---

## 12. Revision History

| Version | Date       | Author | Changes |
|---------|------------|--------|---------|
| v1.0    | 2026-08-12 | NexQuark | Initial draft, targeted at pi-subagents (since superseded). |
| v1.1    | 2026-08-12 | NexQuark | Retargeted to `@nexquark/pi-subagent-fragments` fork of `pi-agents-tmux`. Lines, file paths, and agent-discovery mechanics updated for the upstream codebase. Removed runtime-switching implementation (§ 9 in v1.0 → § 11 deferred in v1.1). PR plan reduced from 10 to 5 PRs (static-only). |