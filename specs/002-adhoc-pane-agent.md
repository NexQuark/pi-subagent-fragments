# Spec 002: Ad-hoc Pane Agent Launch (Call-Time Prompt Assembly)

| Field | Value |
|---|---|
| **Status** | Approved (round 3 polish-2 landed; see § 11 + `specs/_reviews/002-{1,2,3}.md`) |
| **Target version** | `0.2.0` |
| **Scope** | This fork only (`@nexquark/pi-subagent-fragments`) |
| **Upstream base** | `vanillagreencom/vstack@faeb65af` (`pi-agents-tmux` 2.8.1) |
| **PRs** | PR 6, 7, 8a, 8b, 9 on `feature/adhoc-agent` (see § 6; round 3 reorder) |
| **v2 reserved** | § 10 — Per-step ad-hoc in parallel/chain deferred |

---

## 1. Background and Goal

The current `subagent` tool, the `/agents:start` slash command, and the
`/agents:send` slash command all assume the target agent has a
pre-existing `.md` file under `~/.pi/agent/agents/`,
`<project>/.pi/agents/`, or one of the `.claude/agents/` compatibility
paths (`extensions/subagent/agents.ts:36-44`, `agents.ts:339-366`).
Without a file, `validateAgentInventory`
(`extensions/subagent/dispatch.ts:78-94`) refuses the call with a
"Unknown subagent(s)" error.

Three concrete patterns are blocked by that requirement:

1. **Ad-hoc pane agents without a definition file.** A user wants to
   drop into a tmux pane and have an LLM respond with a particular
   system prompt assembled from a few markdown files and an inline
   preamble. They do not want to author and commit an `agent-x.md`
   file just for that one conversation.
2. **System-prompt injection at call time.** Spec 001
   (`specs/001-multi-prompt-injection.md`) added
   `systemPromptFragments` to agent frontmatter, but it is only
   consulted at agent **load time**. There is no way for an LLM or a
   slash command to inject fragments when **spawning** the agent. The
   static fragment mechanism is therefore unreachable from any
   code path that does not already own an agent file.
3. **Empty pi** (no system prompt at all) plus a single user prompt.
   Useful for one-off Q&A against an isolated session without
   polluting the agent directory.

**Round 3 additions** (R2 grammar + R5 bug fixes):

4. **Concise slash-command grammar (R2).** Spec 002 v1.2 used a
   long-flag form (`/agents:adhoc <name> [--pane|--no-pane]
   [--prompt-file...] [--prompt...] [--task...] [--task-file...]`).
   Round 3 introduces an R2 grammar with `#`/`@`/`"..."` source
   markers, a small fixed flag set (`--replace` / `--model` / `--cwd`
   / `--pane-direction` / `--pane-size` / `--pane-target`), and a
   `--` separator for unrecognized flags that passthrough into the
   launcher script's `pi` argv. The slash command surface moves from
   `/agents:adhoc` to **enhancing the existing `/agents:new` and
   `/agents:start`** rather than introducing a new top-level command.
5. **Pane interaction bugs (R5)** — five concrete issues surfaced by
   the user; classified into lifecycle / interaction / dashboard
   / prompt-injection / TUI layers. Round 3 lands the **pane
   lifecycle** + **prompt-injection** subset:

   - **C1**: `pane: true` invoked with `$TMUX` unset throws
     `Persistent pane agents require tmux ($TMUX is unset)` —
     unreachable from a fresh pi session. Round 3 falls back to
     bg dispatch with a one-time warning.
   - **C2**: `/agents:start <name>` reuses the live pane across calls
     without an escape hatch for "force fresh pane" — round 3 adds
     `--new-pane` as the user-facing escape (existing `forceSpawn`
     remains the programmatic escape).
   - **C3**: typo of a discovered agent name synthesizes an empty-pi
     ad-hoc silently (carried from round 2 § 12.7). Round 3 makes
     this a console.warn with a "did you mean" hint when the typo
     has no system sources — i.e., looks like a forgotten `#./foo.md`.
   - **C4a**: `ensurePersistentPane` `tmux split-window` fails when
     the computed `splitPercent` is missing/invalid (panes.ts:810-820);
     round 3 retries without `-p` so tmux picks its default split.
   - **C4b**: `/agents:start` pane flags (`--pane-direction`,
     `--pane-size`, `--pane-target`) are not user-exposed; only the
     default `-h -p 50 -t primary` exists. Round 3 surfaces all three
     as documented flags.

   Dashboard / TUI / cross-pane interaction layers are deferred to
   spec 003 (out of scope for round 3).

**Goal of round 3**: extend the round-2 surface with the R2 grammar
on `/agents:new` + `/agents:start`, the four new tool params
(`model` / `replace` / `cwd` / `passthroughArgs`), and the five R5
fixes (C1 / C2 / C3 / C4a / C4b). The discovered-agent flow
remains the source of truth; ad-hoc params only apply when the name
is **not** discovered. Existing `systemPromptFragments` frontmatter
remains authoritative for discovered agents.

All round-3 new fields are **no-ops when omitted** for callers using
**discovered** agents (byte-identical to v1.2 for the round-2 param
shape). Round-3 adds four more fields; their backward-compat
behavior matches round-2 (see § 5 row 17).

**Non-goals (round 3)**:

- Ad-hoc agents in `tasks: [...]` (parallel) or `chain: [...]`
  modes — kept single-only; see § 10.1.
- Runtime prompt mutation after spawn — still spec 001 § 11.1.
- Per-call override of a discovered agent's system prompt — see
  § 10.2.
- Dashboard / TUI pane interaction bugs — see spec 003 (deferred).

---

## 2. Current State Analysis

### 2.1 Subagent tool surface

`extensions/subagent/tools.ts:36-81` defines `SubagentParams` with the
following fields: `agent`, `task`, `tasks[]`, `chain[]`,
`agentScope`, `confirmProjectAgents`, `cwd`, `sessionKey`,
`forceSpawn`, `resumeSession`.

There is no field for inline system prompt, fragment file paths, task
file, or per-call pane override. There is no field to mark the call as
ad-hoc.

### 2.2 Tool registration and inventory gate

`extensions/subagent/index.ts:1948-2010` registers the `subagent`
tool. The flow is:

1. Discover agents with `discoverAgents(ctx.cwd, agentScope)`
   (`agents.ts:368-385`).
2. Branch on the **mode** (`agent+task` single, `tasks` parallel, or
   `chain` sequential); exactly one must be present.
3. Call `validateAgentInventory(requestedAgentNames, launchInventory(...), agentScope)`
   (`index.ts:1997`, `dispatch.ts:78-94`). Any name missing from
   `allowed` triggers `formatInventoryValidationError` and an
   `isError: true` return.

There is no path through which a name **outside** the inventory is
accepted. This is the gate that blocks ad-hoc launch.

### 2.3 Dispatch path

`extensions/subagent/dispatch.ts:357-407` (`runSingleDispatch`) looks
up the agent in the supplied `agents` array by name. If the name is
present, dispatch proceeds; if absent, the helper returns a refused
result with `stderr: "Unknown agent: ..."`. The same gate exists in
`runParallelDispatch` (`dispatch.ts:241-282`) and `runChainDispatch`
(`dispatch.ts:130-178`).

For ad-hoc to work in single mode, the synthesized `AgentConfig` must
be present in the `agents` array **before** `runSingleDispatch` looks
it up. The simplest hook is `extensions/subagent/index.ts:1994-2009`,
where `agents` is built up from `discoverAgents`.

### 2.4 Pane spawning is parameter-agnostic

`extensions/subagent/pane.ts:773-862` (`ensurePersistentPane`) and
`pane.ts:905-997` (`queuePersistentPaneTask`) accept an `AgentConfig`
and work with whatever prompt / pane flag is on it. The launcher
script in `pane.ts:715-734` writes `composeAgentPrompt({ body,
fragments, mode })` to `<runtimeRoot>/prompts/<name>.md` and passes
the path as `--append-system-prompt`. There is no requirement that
the agent originate from a `.md` file — `AgentConfig.source` and
`filePath` are descriptive metadata, not load prerequisites.

This means the **only** changes needed for ad-hoc pane launching are:
(a) synthesize an `AgentConfig` at call time, (b) plumb it into the
`agents` array consumed by dispatch. No changes to `pane.ts`,
`runner.ts`, or `prompt-compose.ts` are required for the happy path.

### 2.5 Slash command surface

`extensions/subagent/agents-command.ts:208-265` registers the
`/agents` command plus a number of `/agents:<sub>` subcommands
(`start`, `new`, `resume`, `send`, `attach`, `stop`, `trace`,
`toggle`). Every subcommand except `toggle` and `trace` resolves the
agent by name via `discovery.agents.find(...)`
(`agents-command.ts:46`); if the name is missing, the handler throws
`"Unknown agent: ..."` (e.g. `agents-command.ts:54`, `agents-command.ts:79`).

`/agents:adhoc` is not registered. The closest existing entry is
`/agents:start`, which always routes through the discovered-agent
path.

### 2.6 What is missing

Round 2 gaps:

- A way to **synthesize** an `AgentConfig` from call-time prompt
  parameters.
- A way to **bypass** inventory validation when the caller has
  supplied their own prompt material.
- A way to **override** the discovered agent's `pane` flag at call
  time.
- A way to **read the task from a file** (`taskFile` overload).
- A slash command surface that accepts the same parameters via
  parsed CLI args.

Round 3 adds (R2 grammar + R5 bug fixes):

- A **concise source-marker grammar** (`#` / `#"..."` / `@` / `"..."`)
  so slash commands don't degenerate into flag soup.
- **C1 tmux fallback**: when ad-hoc defaults to `pane: true` and
  `$TMUX` is unset, the current code throws. Round 3 warns + falls
  back to bg.
- **C2 reuse escape**: `/agents:start` reuses the live pane
  without a user-facing "force fresh" option. Round 3 adds
  `--new-pane`.
- **C3 typo warn**: an empty-pi ad-hoc with a name close to a
  discovered agent is almost certainly a typo; round 3 emits a
  one-time `console.warn` with a "did you mean" hint.
- **C4a size retry**: `tmux split-window -p N` can fail with
  "size missing" under specific tmux versions; round 3 retries
  without `-p` so tmux picks its default split.
- **C4b user-facing pane flags**: `--pane-direction`,
  `--pane-size`, `--pane-target` surface the three tmux
  primitives that were previously hardcoded.
- **Round-3 tool params**: `model`, `replace`, `cwd`,
  `passthroughArgs` (passthrough reaches the spawned `pi` argv
  for first-classing deferred flags).

---

## 3. Design

### 3.1 New tool parameters

Extend `SubagentParams` (`tools.ts:36-81`) with the following
**optional** fields. All are no-ops when omitted (full backward
compatibility).

```ts
pane?: boolean;               // override pane-vs-bg for both discovered and ad-hoc
systemPrompt?: string;        // inline system prompt body (no file read)
systemPromptFiles?: string[]; // paths read at spawn time, joined via composeAgentPrompt
taskFile?: string;            // path whose contents become the task; overrides task
model?: string;               // round 3: override agent.model at call time
replace?: boolean;            // round 3: composer mode override (true → "replace")
cwd?: string;                 // round 3: cwd override (fragment root + pane cwd)
passthroughArgs?: string[];   // round 3: unrecognized flag values appended to pi argv
```

**Pane override semantics**:

| Case | `pane` param | Resulting `agent.pane` |
|------|-------------|-----------------------|
| Discovered agent (name in inventory) | omitted | `agent.pane` (unchanged) |
| Discovered agent | `true` | `true` (forced) |
| Discovered agent | `false` | `false` (forced) |
| Ad-hoc agent (name not in inventory) | omitted | `true` (default — open pane) |
| Ad-hoc agent | `true` | `true` |
| Ad-hoc agent | `false` | `false` |

For ad-hoc, defaulting `pane` to `true` matches sub-meta's 1A answer:
"pane 模式提升为'调用方决定 + 默认对 ad-hoc 也开'". A user who wants a
purely transient bg agent passes `pane: false`.

**Task source semantics**:

- `task` only: use inline text (unchanged).
- `taskFile` only: read file, use contents.
- Both: `taskFile` wins; log a one-time `console.warn` noting the
  override.
- Neither: refuse with `"task or taskFile is required"` (the
  existing `Invalid parameters` path already handles this).

### 3.2 Ad-hoc resolution

In `extensions/subagent/index.ts:1994-2009`, after `discoverAgents`
returns the inventory but **before** `validateAgentInventory` runs.
See § 4.3 for the implementation; the prose below describes the
trigger semantics.

The trigger detects "name not in inventory" once, then
mode-dispatches:

- `hasSingle` → synthesize and inject into `agents`.
- `hasChain || hasTasks` → surface the ad-hoc-specific error
  instead of letting `validateAgentInventory` return the generic
  `"Unknown subagent(s)"` (the user would not learn that ad-hoc
  is single-only without it). v2 § 10.1 lifts this branch and
  teaches the synthesizer to handle N names.

**Ad-hoc trigger**: `params.agent` is set AND the name is not in
the discovered inventory. No ad-hoc param is required — an empty
pi (`subagent({ agent: "x", task: "..." })`) is just an ad-hoc
agent with empty prompt body and no fragments. Setting
`systemPrompt` / `systemPromptFiles` / `pane` / `taskFile` is
optional but accepted.

`validateAgentInventory` then sees the synthesized agent in
`allowed` and passes. The downstream `runSingleDispatch` finds it
in `flow.agents` and dispatches normally.

**Ad-hoc in parallel/chain (v1)**: rejected with a clear error:

> `subagent: ad-hoc agents are only supported in single mode. Move <name> into <scope>.pi/agents/<name>.md or split the call into single dispatches.`

See § 10.1 for v2.

### 3.3 The synthesizer

A new helper in `extensions/subagent/agents.ts`:

```ts
export interface SynthesizeAdhocAgentInput {
  name: string;
  cwd: string;
  systemPrompt?: string;
  systemPromptFiles?: string[];
  pane: boolean;
  // Round 3 additions:
  replace?: boolean;          // composer mode override; default false ("append")
  model?: string;             // override agent.model; falls through to discovered/parent model if omitted
  passthroughArgs?: string[]; // unrecognized --flag values appended to pi argv in the launcher script
  /**
   * Round 3 / C3 side channel. The synthesizer does not import
   * discoverAgents; the dispatcher computes the nearest match and
   * passes it here. When no system sources are provided AND
   * distance ≤ 2, the synthesizer emits a one-time console.warn.
   */
  nearestDiscoveredName?: { name: string; distance: number };
}

export async function synthesizeAdhocAgent(
  input: SynthesizeAdhocAgentInput,
): Promise<AgentConfig>;
```

Behavior:

- Read each `systemPromptFiles` path with `fs.promises.readFile`,
  UTF-8. Reuse the same error shape as
  `loadFragmentStrings` (`agents.ts:151-181`): missing file /
  non-regular file / unreadable → throw with agent name and path.
  **Error prefix mirrors spec 001 for grep continuity**:
  `[pi-subagent-fragments] Failed to read fragment "<path>" for
  ad-hoc agent "<name>": <msg>` (note "Failed" capitalized to
  match `loadFragmentStrings`, and "<path>" before "<name>" to
  match the load-time ordering).
- Resolve fragment paths **relative to `cwd`** (the calling
  session's cwd), unlike spec 001's agent-file-relative resolution.
  This matches the natural "I have these files in my working dir"
  mental model for ad-hoc use.
- Call `composeAgentPrompt({ body: input.systemPrompt ?? "",
  fragments: <resolved strings>, mode: input.replace ? "replace" : "append" })`.
  **Join order** (spec 001 § 3.2): `[...fragments, body]`
  joined with `\n\n---\n\n`; empty strings are filtered out, so
  the empty-pi case preserves as `""`.
  Round 3 exposes the `"replace"` mode: when `input.replace === true`,
  the composer treats the **last non-empty source** as the canonical
  body and discards earlier fragments. This matches spec 001 § 11.1's
  reserved semantics. The contract test S9 verifies the behavior:
  `synthesizeAdhocAgent({ name, systemPrompt: "BODY", systemPromptFiles: ["./a.md", "./b.md"], replace: true })`
  yields `composed === "<contents-of-b.md>\n\n---\n\nBODY"` (last
  fragment kept, body appended).
- Round 3 also preserves `passthroughArgs` on the returned
  `AgentConfig` so the launcher script (`pane.ts:715-734`) can append
  the unrecognized flags to the spawned `pi` argv. The synthesizer
  itself does **not** interpret `passthroughArgs` — it is a pure
  pass-through. Contract test S10 verifies preservation.
- Return an `AgentConfig` with:
  - `name: input.name` — must match `^[A-Za-z0-9_-]+$`. This is
    **stricter** than `safeFileName` (`names.ts:1`), which also
    permits `.`. The extra dot-rejection is intentional defense
    against path-traversal in the launcher script's
    `shellQuote(agent.name)`. Names that fail the regex are
    rejected at the synthesizer boundary.
  - `description: "(ad-hoc, ephemeral — synthesized at call time)"` —
    surfaces in `/agents show` so ad-hoc agents are visibly
    distinguished from real-but-empty descriptions. (v2 may
    enrich with prompt byte-length; see § 10.6.)
  - `pane: input.pane`.
  - `systemPrompt: composed`.
  - `systemPromptFragments: input.systemPromptFiles` (preserved for
    `/agents show`).
  - `systemPromptMode: "append"`.
  - `source: "user"` — ad-hoc agents are user-supplied, not from a
    repo-controlled agent file. Trust level matches caller session.
  - `filePath: ""` — synthesized, no source file.

### 3.4 Task file resolution

`taskFile` is read at dispatch time, **before** the synthesized
agent enters `runSingleDispatch`:

```ts
let resolvedTask = params.task ?? "";
if (params.taskFile) {
  resolvedTask = await fs.promises.readFile(params.taskFile, "utf-8");
  if (params.task && params.task.trim() !== "") {
    console.warn(`[pi-subagent-fragments] taskFile overrides task for ${params.agent}.`);
  }
}
```

Resolution is **relative to `cwd`** (matching `systemPromptFiles`).
The string is passed through unchanged to `runSingleAgent` /
`queuePersistentPaneTask`; no trimming, no template substitution.

If `taskFile` is unreadable, fail with a clear error naming the path
(no fallback to `task`).

### 3.5 Inventory validation ordering

The validation branch order becomes:

1. Mode check (existing): exactly one of `{agent+task, tasks[],
   chain[]}`.
2. **Ad-hoc recognition** (new): if `params.agent` is set and not in
   inventory, synthesize and inject (empty pi when no prompt params
   are supplied; see § 3.2).
3. **Inventory validation** (existing): every remaining requested
   name must be in inventory. Ad-hoc names are already in inventory
   by step 2.
4. **Project-agent confirmation** (existing): unchanged.

Steps 2+3 together guarantee that the "Unknown subagent(s)" error
fires only when the caller genuinely forgot to declare the agent and
also did not supply ad-hoc material.

### 3.6 `/agents:new` and `/agents:start` slash commands (R2 grammar)

Round 3 retires the `/agents:adhoc` command (spec 002 v1.2 §3.6) and
extends the existing `/agents:new` and `/agents:start` commands with
the same R2 grammar. Both commands accept the same argument shape:

```text
/agents:new <name> [<system-source>...] [<user-source>...] [--flag...] [-- <passthrough-args>]
/agents:start <name> [<system-source>...] [<user-source>...] [--flag...] [-- <passthrough-args>] [--new-pane]
```

**Source markers** (recognized positional tokens):

| Form | Semantics |
|---|---|
| `#<unquoted-path>` | System source: must resolve to a regular file; missing or non-file **throws** with the path in the error. |
| `#"<quoted>"` | System source: `fs.statSync().isFile()` ? read file : use the quoted content verbatim as inline system-prompt text. |
| `@<path-or-text>` | User source: `fs.statSync().isFile()` ? read file : use the literal token as inline user-prompt text. |
| `"<text>"` | User source: inline text (no file lookup). |

System sources accumulate in declaration order into the synthesizer's
`systemPromptFiles` (or as inline body content via the quoted
fallback). User sources concatenate with `\n\n` into the task string
(multi-source users are common in review tasks where the user wants
the agent to see both "the patch" and "the question").

**Source markers cannot contain whitespace** (the parser splits on
`/\s+/`; same trade-off as round-2 R2-F5). For inline content with
whitespace, write the content to a fragment file and use the bare
`#<path>` form. Quoted-region extraction (i.e., honoring `"..."`
as a single token) is a future parser extension — see R3-F7.

**Recognized flags (8)** (consumed by the parser):

| Flag | Value | Effect |
|---|---|---|
| `--replace` | (none) | Set synthesizer `mode: "replace"`. See § 3.3 S9. |
| `--model <name>` | model id | Override `agent.model`. |
| `--cwd <path>` | absolute path | Override the cwd for fragment resolution and pane spawn. |
| `--pane-direction <h\|v>` | `h` or `v` | Round 3 / C4b: pass `-h` or `-v` to `tmux split-window`. Default `h`. |
| `--pane-size <N[%\|l]>` | e.g. `30%`, `25l` | Round 3 / C4b: pass `-p N` (default, percent) or `-l N` (lines). Default `50%`. |
| `--pane-target <primary\|next\|<id>>` | target | Round 3 / C4b: pass `-t <id>` (primary resolves to current primary pane id; next resolves to the next layout-group pane id). Default `primary`. |
| `--no-pane` | (none) | Round 3 / C1: force bg dispatch (bypasses tmux; emits the "tmux not available" warning if `$TMUX` is unset; otherwise dispatches `runSingleAgent`). |
| `--new-pane` | (none) | Round 3 / C2: on `/agents:start` and `/agents:resume`, triggers the stop-then-create sequence. On `/agents:new`, **silently ignored** (the command already forceSpawns; R3-E12). |

**Unrecognized `--xxx [value]` flags** (not in the recognized list)
accumulate into `passthroughArgs[]` in declaration order. After
the `--` separator, all subsequent tokens (including non-flag
tokens) go to `passthroughArgs[]` verbatim, regardless of marker
prefix. The parser does not error on unknown flags; round 3
deliberately lets pi-side flags pass through. The synthesizer
preserves `passthroughArgs` on the `AgentConfig` (contract S10);
the launcher script (`pane.ts:715-734`) appends each entry to
the spawned `pi` argv, wrapped with `shellQuote` (`names.ts:3`).
Values pass through `shellQuote` per spec 001 §4.7.

**`/agents:new` semantics**: same as spec 002 v1.2 (stop any existing
live pane + forceSpawn: true + start fresh). Round 3 adds the R2
grammar on top.

**`/agents:start` semantics**: same as spec 002 v1.2 (resume or reuse
existing live pane; queue task without force-spawn). Round 3 adds:

- The R2 grammar (same shape as `/agents:new`).
- `--new-pane` (round 3 / C2): escape hatch that does what
  `/agents:new` does (stop existing + forceSpawn: true). This is the
  user-facing counterpart to the programmatic `forceSpawn: true`
  option on the tool surface. Maps to the existing `forceSpawn`
  branch in `agents-command.ts:55-58`.

**Argument parser** (`parseAdhocArgs` in `agents-command.ts`):

- Splits the post-command string on whitespace. **Quoting is not
  processed** — the parser treats `"..."` as a literal token
  containing the quotes, and the user (or their shell) is responsible
  for tokenization. This matches the existing `/agents:*` family
  (`agents-command.ts:34`).
- Recognizes `name` (first positional), then walks remaining
  positional tokens classifying each by prefix marker
  (`#` / `#"` / `@` / `"`).
- Flag tokens (`--foo` / `--foo <bar>`) update a result object.
- The `--` separator ends flag parsing; subsequent tokens go to
  `passthroughArgs` (round 3) regardless of prefix.
- Missing name → result has `name: ""`; the handler surfaces the
  usage error.
- `parseAdhocArgs` LOC budget ≤60 (was ≤45 in round 2 — the new
  grammar adds ~15 lines for source classification).

**Handler integration**:

- The handler calls `synthesizeAdhocAgent` with all parsed sources
  + flags + `cwd` override.
- After synthesis, the handler calls `queuePersistentPaneTask` (pane
  lane) or `runSingleAgent` (bg lane based on `--no-pane` and C1
  fallback).
- Round 3 / C4b: pane flag values (`--pane-direction`, `--pane-size`,
  `--pane-target`) are passed through to `ensurePersistentPane`'s
  `tmux split-window` invocation (currently hardcoded at
  `pane.ts:810-820`; the round 3 patch makes the flags
  parameterizable). When `--new-pane` is set, the handler first
  invokes `stopPersistentPane` to clear the existing entry.

**Argument completions**:

- `<name>` for `/agents:new` and `/agents:start`: completion against
  the discovered agent list (`paneAgentNameCompletions` already
  exists in `agents-command.ts:213`).
- `--cwd`, `--pane-target`: file-path / pane-id completion (best
  effort; round 3 may defer if `tmux list-panes` integration is too
  much).

**Why retire `/agents:adhoc`**: keeping the new grammar on
`/agents:new` + `/agents:start` instead of introducing a third
top-level command avoids command-surface proliferation and lets
existing muscle memory (`/agents:start <name>`) absorb the new
capability without documentation re-discovery. The spec 002 v1.2
`/agents:adhoc` command registration
(`agents-command.ts:255-262`) is removed in round 3.

### 3.7 No new CLI surface for the spawned `pi`

Spawned `pi` processes get the same `--append-system-prompt
<file>` flag as today (`pane.ts:734`, `runner.ts:653`). The file
contents are the joined prompt from `composeAgentPrompt`. Nothing
changes downstream.

### 3.8 Trust and safety

- **Ad-hoc agents run with the caller's tool set.** They are not
  subject to a separate `denyTools` (no frontmatter to declare one).
  This matches the principle that ad-hoc agents inherit the
  caller's authority. Document in spec § 4.
- **No fragment path containment.** spec 001 § 13.3 already notes
  the same loose policy for discovered fragments; ad-hoc inherits
  it. Ad-hoc fragment paths resolve relative to `cwd`, so they
  inherit the cwd's filesystem scope.
- **`name` validation.** Ad-hoc names must match `^[A-Za-z0-9_-]+$`.
  This prevents injection into the launcher script's
  `shellQuote(agent.name)` and is **stricter** than `safeFileName`
  (`names.ts:1`), which also permits `.`. The extra dot-rejection
  is intentional.
- **`source: "user"`.** Ad-hoc agents are not repo-controlled. They
  are excluded from the `confirmProjectAgents` gate (which only
  prompts for `source === "project"`; ad-hoc is `"user"`).
- **Round 3 / C1 — tmux availability detection.** `pane: true` is
  the default for ad-hoc. When the call site is outside a tmux
  session (`process.env.TMUX` is unset), the round-3 handler emits a
  one-time warning of the form `[pi-subagent-fragments] tmux not
  available; pane disabled, dispatching as bg.` and falls back to
  `runSingleAgent` instead of throwing. Contract test C1 verifies
  the warning content (must contain `"tmux"` and `"pane disabled"`).
  The programmatic escape is `pane: false`; the slash-command
  escape is `--no-pane`.
- **Round 3 / C2 — pane reuse escape hatch.** `ensurePersistentPane`
  reuses a live pane for the same `name` across calls. The
  user-facing escape is `--new-pane` on `/agents:start`, which
  invokes `stopPersistentPane` first and then dispatches with
  `forceSpawn: true`. This is equivalent to `/agents:new` for the
  same `name`; both commands end up at the same launcher
  invocation. Contract test C2 verifies the stop-then-create
  sequence.
- **Round 3 / C3 — typo "did you mean" warn.** When the synthesizer
  is invoked with no system sources (zero `#`-prefixed tokens, no
  inline body), and the requested name is within Levenshtein
  distance ≤2 of any discovered agent name, the round-3
  implementation emits a one-time `console.warn` of the form
  `[pi-subagent-fragments] Ad-hoc <name> synthesized with no
  system sources. Did you mean "<discovered>"? (existing agent
  file).` Contract test C3 verifies the warn content; C3' verifies
  that providing any system source suppresses the warn. This is a
  mitigation for spec 002 v1.2 § 12.7 (silent typo) without
  breaking the empty-pi case.
- **`source: "user"`.** Ad-hoc agents are not repo-controlled. They
  are excluded from the `confirmProjectAgents` gate (which only
  prompts for `source === "project"`; ad-hoc is `"user"`).

---

## 4. Implementation Details

### 4.1 `extensions/subagent/tools.ts`

Extend `SubagentParams` with the round-2 + round-3 fields:

```ts
// Round 2 (carried over):
pane: Type.Optional(
  Type.Boolean({
    description:
      "Override pane-vs-bg for this dispatch. Ad-hoc defaults to true (pane); discovered agents keep their frontmatter pane flag when omitted. See § 4.4 for the strict-precedence resolution.",
  }),
),
systemPrompt: Type.Optional(
  Type.String({
    description:
      "Inline system prompt body joined with systemPromptFiles at spawn time. Mutually independent of agent frontmatter; ignored when the name resolves to a discovered agent.",
  }),
),
systemPromptFiles: Type.Optional(
  Type.Array(Type.String(), {
    description:
      "Paths to markdown files whose contents are joined with systemPrompt via composeAgentPrompt (spec 001 semantics). Paths resolve relative to the calling session's cwd. Ignored when the name resolves to a discovered agent.",
  }),
),
taskFile: Type.Optional(
  Type.String({
    description:
      "Path to a file whose contents become the task. Overrides `task` when both are provided. Resolves relative to the calling session's cwd.",
  }),
),

// Round 3 additions:
model: Type.Optional(
  Type.String({
    description:
      "Override agent.model at call time. Same shape as the frontmatter `model` field (e.g. 'MiniMax-M2.7' or 'claude-opus-4-5'). Falls through to the parent session's model if omitted.",
  }),
),
replace: Type.Optional(
  Type.Boolean({
    description:
      "Compose-mode override for ad-hoc dispatch. true → composeAgentPrompt with mode: 'replace' (last non-empty fragment becomes canonical, earlier fragments dropped). false / omitted → mode: 'append' (default).",
  }),
),
cwd: Type.Optional(
  Type.String({
    description:
      "Override the cwd for fragment resolution and pane spawn. Absolute path; used both as the base for `path.resolve` when reading fragments and as the pane's cwd for `tmux split-window -c`. Default: ctx.cwd.",
  }),
),
passthroughArgs: Type.Optional(
  Type.Array(Type.String(), {
    description:
      "Unrecognized --flag values forwarded verbatim to the spawned pi argv. The launcher script appends these after the recognized flags. Used for pi options not yet first-classed in the dispatcher.",
  }),
),
```

No changes to other tools (`DelegateSubagentParams`,
`GetSubagentResultParams`, etc.).

### 4.2 `extensions/subagent/agents.ts`

Add `synthesizeAdhocAgent` (round 2 base + round 3 extensions).
It is async because fragment file reads are async (spec 001 used
`fs.readFileSync` because load-time is sync; call-time is
async-friendly and matches the tool's async context).

```ts
const AD_HOC_NAME_RE = /^[A-Za-z0-9_-]+$/;

export async function synthesizeAdhocAgent(input: SynthesizeAdhocAgentInput): Promise<AgentConfig> {
  if (!AD_HOC_NAME_RE.test(input.name)) {
    throw new Error(
      `[pi-subagent-fragments] Ad-hoc agent name "${input.name}" is invalid. Use only [A-Za-z0-9_-].`,
    );
  }
  const fragmentPaths = input.systemPromptFiles ?? [];
  const fragments: string[] = [];
  for (const fragmentPath of fragmentPaths) {
    const resolved = path.resolve(input.cwd, fragmentPath);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(resolved);
    } catch (cause) {
      throw new Error(
        `[pi-subagent-fragments] Failed to read fragment "${fragmentPath}" for ad-hoc agent "${input.name}": ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (!stat.isFile()) {
      throw new Error(`[pi-subagent-fragments] Ad-hoc agent "${input.name}": fragment path is not a regular file: ${resolved}`);
    }
    try {
      fragments.push(await fs.promises.readFile(resolved, "utf-8"));
    } catch (cause) {
      throw new Error(
        `[pi-subagent-fragments] Failed to read fragment "${fragmentPath}" for ad-hoc agent "${input.name}": ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  // Round 3: replace mode — keep only the last non-empty fragment,
  // drop earlier ones. Filter here (not in composeAgentPrompt) so
  // spec 001's "reserved for v2" semantics on discovered agents
  // remain untouched. Contract test S9 verifies.
  const effectiveFragments = input.replace && fragments.length > 0
    ? fragments.slice(-1)
    : fragments;
  const composed = composeAgentPrompt({
    body: input.systemPrompt ?? "",
    fragments: effectiveFragments,
    mode: input.replace ? "replace" : "append",
  });

  // Round 3 / C3: emit "did you mean" warn when synthesis has no
  // system sources and the requested name is near a discovered
  // agent. Empty-pi is still allowed (no error); the warn is purely
  // a UX hint for typos. The dispatcher computes the nearest match
  // (via computeNearestDiscoveredName at § 4.3) and passes it as the
  // typed `input.nearestDiscoveredName` field; the synthesizer does
  // not import discoverAgents itself (stays a pure function).
  if (
    fragmentPaths.length === 0 &&
    !(input.systemPrompt?.trim()) &&
    input.nearestDiscoveredName &&
    input.nearestDiscoveredName.distance <= 2
  ) {
    const nearest = input.nearestDiscoveredName;
    console.warn(
      `[pi-subagent-fragments] Ad-hoc agent "${input.name}" synthesized with no system sources. Did you mean "${nearest.name}"? (existing agent file)`,
    );
  }

  return {
    name: input.name,
    description: "(ad-hoc, ephemeral — synthesized at call time)",
    pane: input.pane,
    // Round 3: model override flows from caller through to
    // AgentConfig.model. Falls through to the parent session's
    // selectedModelForAgent if undefined.
    model: input.model,
    systemPrompt: composed,
    systemPromptFragments: fragmentPaths.length > 0 ? fragmentPaths : undefined,
    systemPromptMode: input.replace ? "replace" : "append",
    source: "user",
    filePath: "",
    // Round 3: passthrough preserved on the returned AgentConfig so
    // the launcher script can append the unrecognized flags to the
    // spawned pi argv. Contract test S10 verifies preservation.
    passthroughArgs: input.passthroughArgs && input.passthroughArgs.length > 0
      ? [...input.passthroughArgs]
      : undefined,
  } as AgentConfig & { passthroughArgs?: string[] };
}
```

**Round 3 notes**:

- The `replace: true` mode passes through to `composeAgentPrompt`
  with `mode: "replace"` (spec 001 § 11.1's reserved semantics).
  Earlier fragments are dropped **locally** in the synthesizer
  (`fragments.slice(-1)`) before the compose call so
  `composeAgentPrompt` itself is not modified (keeps the
  change scoped to spec 002; spec 001's "reserved for v2"
  semantics on discovered agents remain untouched).
- The C3 "did you mean" warn is implemented as a `console.warn`
  inside the synthesizer. The discovered-name lookup is performed
  by the caller (the dispatch layer at § 4.3) and passed in via
  the typed `input.nearestDiscoveredName` field; the synthesizer
  itself does not import `discoverAgents` (kept a pure function).
- `passthroughArgs` is preserved on the returned object. The
  `AgentConfig` interface (`agents.ts:23-49`) does not yet declare
  this field; round 3 extends the interface. Contract test S10
  verifies preservation; D8 verifies the launcher script
  actually appends the array to `pi` argv. The launcher script
  (`pane.ts:715-734`) wraps each `passthroughArgs[i]` with
  `shellQuote` (`names.ts:3`) before joining into argv; values
  pass through `shellQuote` per spec 001 §4.7 (same escaping as
  the recognized argv). Content is unfiltered but safely
  shell-escaped.

### 4.3 `extensions/subagent/index.ts`

In the `subagent` tool execute (around L1962-2009), after mode
detection and before `validateAgentInventory`:

```ts
// Existing (with `hasSingle` redefined to also accept taskFile)
const hasChain = (params.chain?.length ?? 0) > 0;
const hasTasks = (params.tasks?.length ?? 0) > 0;
// hasSingle: an `agent` plus at least one of `task` / `taskFile`.
const hasSingle = Boolean(params.agent && (params.task ?? params.taskFile));
const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

// Round 3 / C1: tmux availability detection. Only fires for ad-hoc
// agents (discovered agents with pane:false are not affected, and
// discovered agents with pane:true inherit their pane decision from
// the discovered AgentConfig, not from a default). The warn is
// scoped inside the ad-hoc branch below.
const tmuxAvailable = Boolean(process.env.TMUX);

// Ad-hoc recognition (see § 3.5 for rationale).
// 1. In single mode: synthesize the agent (the happy path).
// 2. In parallel/chain mode: out-of-inventory names are a user error;
//    surface the ad-hoc-specific message instead of the generic
//    "Unknown subagent(s)" so users understand the limitation.
let adHocSynthesized: AgentConfig | undefined;
if (params.agent !== undefined && !agents.some((a) => a.name === params.agent)) {
  if (hasSingle) {
    // C1 / PR7-E1: tmux fallback forces pane: false so the
    // synthesized agent dispatches as bg, not pane. The warn is a
    // UX hint; the pane flip is the actual mitigation. Without
    // this, dispatch would still route to runPersistentPaneAgent
    // and ensureTmux would throw despite the warn.
    const tmuxAvailable = Boolean(process.env.TMUX);
    const fallbackToBg = shouldAdhocFallbackToBg(tmuxAvailable, params.pane);
    if (fallbackToBg) {
      console.warn(`[pi-subagent-fragments] tmux not available; pane disabled, dispatching as bg.`);
    }
    // Round 3: pass model / replace / cwd / passthroughArgs through.
    // Round 3 / C3: compute nearest discovered name for the
    // "did you mean" warn when there are no system sources.
    const nearest = computeNearestDiscoveredName(params.agent, discovery.agents);
    adHocSynthesized = await synthesizeAdhocAgent({
      name: params.agent,
      cwd: params.cwd ?? ctx.cwd,
      systemPrompt: params.systemPrompt,
      systemPromptFiles: params.systemPromptFiles,
      pane: fallbackToBg ? false : (params.pane ?? true),
      replace: params.replace,
      model: params.model,
      passthroughArgs: params.passthroughArgs,
      nearestDiscoveredName: nearest, // round 3 / C3 side channel
    });
    agents = [...agents, adHocSynthesized];
  } else if (hasChain || hasTasks) {
    return {
      content: [{ type: "text", text: `subagent: ad-hoc agents are only supported in single mode. Move "${params.agent}" into <scope>.pi/agents/${params.agent}.md or split the call into single dispatches.` }],
      details: makeDetails(hasChain ? "chain" : "parallel")([]),
      isError: true,
    };
  }
}

// Existing inventory validation now sees the synthesized name in `allowed`.
const requestedAgentNames = collectRequestedAgentNames(params as Record<string, any>);
const inventoryError = validateAgentInventory(requestedAgentNames, launchInventory(ctx.cwd, agentScope, agents), agentScope);
```

The `taskFile` resolution happens in the same handler, just before
the existing `runSingleDispatch` call:

```ts
let resolvedTask = params.task ?? "";
if (params.taskFile) {
  try {
    resolvedTask = await fs.promises.readFile(path.resolve(ctx.cwd, params.taskFile), "utf-8");
  } catch (cause) {
    return {
      content: [{ type: "text", text: `subagent: failed to read taskFile "${params.taskFile}": ${cause instanceof Error ? cause.message : String(cause)}` }],
      details: makeDetails("single")([]),
      isError: true,
    };
  }
  if ((params.task ?? "").trim() !== "") {
    console.warn(`[pi-subagent-fragments] taskFile overrides task for ${params.agent}.`);
  }
}

if (params.agent && resolvedTask) {
  return runSingleDispatch({
    agent: params.agent,
    agents,
    cwd: ctx.cwd,
    cwdOverride: params.cwd,
    forceSpawn: params.forceSpawn ?? false,
    makeDetails,
    onUpdate,
    parentModel,
    parentSessionId,
    parentThinkingLevel,
    pi,
    removeDashboardAgent,
    resumeSession: params.resumeSession,
    runtimeRoot,
    sessionKey: params.sessionKey,
    signal,
    task: resolvedTask,
    updateDashboard,
  });
}
```

`pane` override for **discovered** agents: handled in
`runSingleDispatch` itself, not in `index.ts`. See § 4.5.

### 4.4 `extensions/subagent/dispatch.ts` — `pane` override

`runSingleDispatch` (L357-407) currently reads
`flow.agents.find(...)` and uses `agent.pane` to decide between
`runPersistentPaneAgent` and `runSingleAgent`. v1 extends the
helper's input to accept a `paneOverride?: boolean`:

```ts
export async function runSingleDispatch(
  flow: DispatchFlowContext & {
    agent: string;
    task: string;
    cwdOverride?: string;
    sessionKey?: string;
    paneOverride?: boolean;
  },
): Promise<ToolTextResult> {
  const agent = flow.agents.find((candidate) => candidate.name === flow.agent);
  // paneOverride, when explicitly true or false, takes ABSOLUTE precedence
  // over the discovered/synthesized agent's `pane` flag. When omitted,
  // fall back to the agent's flag (for ad-hoc, synthesizeAdhocAgent already
  // set agent.pane to `input.pane ?? true`, so the fallback returns the
  // correct value with no special case).
  const usePane = flow.paneOverride === true ? true
                : flow.paneOverride === false ? false
                : Boolean(agent?.pane);
  const result = usePane
    ? await runPersistentPaneAgent(/* same args */)
    : await runSingleAgent(/* same args */);
  ...
}
```

The call site in `index.ts:2009` passes `paneOverride: params.pane`:

```ts
return runSingleDispatch({
  ...,
  paneOverride: params.pane,
});
```

The strict-precedence `=== true / === false` ladder matters: a
naive `agent.pane || paneOverride` would short-circuit on a
truthy `agent.pane` and silently swallow a `paneOverride: false`
(see F1 in the review). Trace table for the fixed logic:

| Case | `usePane` |
|------|-----------|
| Discovered `pane:true` + omitted | `true` |
| Discovered `pane:true` + `pane:true` | `true` |
| Discovered `pane:true` + `pane:false` | **`false`** |
| Discovered `pane:false` + omitted | `false` |
| Discovered `pane:false` + `pane:true` | `true` |
| Discovered `pane:false` + `pane:false` | `false` |
| Ad-hoc + omitted | `true` (via synthesized `agent.pane`) |
| Ad-hoc + `pane:false` | `false` |

### 4.5 `extensions/subagent/agents-command.ts` — `/agents:new` + `/agents:start` (R2 grammar, round 3)

Round 3 retires `/agents:adhoc` registration. The `/agents:new` and
`/agents:start` commands at `agents-command.ts:55` and
`agents-command.ts:62` are extended to use the same R2 grammar.

The existing `findAgent(parts[1])` lookup at
`agents-command.ts:46` stays for the **discovered-agent** path
(round-2 v1.0 behavior). Round 3 adds an **ad-hoc path** that
activates when the name does not resolve in the inventory. Both
paths share the same R2 grammar parser.

**Round 3 changes to `agentsHandler`**:

- After `findAgent(parts[1])`, check whether `findAgent` returned
  `undefined`. If yes, fall into the ad-hoc path (parse R2 grammar,
  synthesize the agent, dispatch).
- The ad-hoc branch lives inside the existing `start`/`new`/`start`
  if/else, **after** the existing agent-found branch. Placing it
  there keeps the discovered-agent path byte-identical to v1.0
  when the name resolves, and only the ad-hoc case exercises the
  new code.
- For `/agents:start`, the `--new-pane` flag (round 3 / C2)
  triggers the same stop-then-create sequence that
  `/agents:new` already does. The handler unifies both cases:
  `forceSpawn = (command === "new" || parsed.newPane)`.

**`parseAdhocArgs` contract** (round 3 grammar; supersedes
v1.2's long-flag contract):

- Splits `args` on `/\s+/`. Quoting is **not** processed; users
  who need whitespace in inline text should rely on the
  `#"..."` and `@...` prefix markers (the parser handles quoted
  tokens as a single literal string with the quotes preserved).
- **First positional token** is `name`.
- **Subsequent positionals**: classified by leading marker:
  - `#<unquoted-path>` → `systemPromptFiles` entry (read later).
  - `#"<quoted>"` → `systemPromptSources` entry with
    `{ type: "file-or-inline", value: <quoted-with-quotes> }`;
    resolved at handler time via `fs.statSync().isFile()`.
  - `@<path-or-text>` → `userSources` entry with
    `{ type: "file-or-inline", value: <token> }`; resolved at
    handler time the same way.
  - `"<text>"` → `userSources` entry with
    `{ type: "inline", value: <quoted-with-quotes> }`.
- **Recognized flags** (consume value where applicable):
  - `--replace` → `replace: true`.
  - `--model <name>` → `model: name`.
  - `--cwd <path>` → `cwd: path`.
  - `--pane-direction <h|v>` → `paneDirection: 'h' | 'v'`.
  - `--pane-size <N[%\|l]>` → `paneSize: { value: N, unit: '%' \| 'l' }`.
  - `--pane-target <primary\|next\|<id>>` → `paneTarget: <value>`.
  - `--no-pane` → `pane: false` (ad-hoc default true).
  - `--new-pane` → `newPane: true`. On `/agents:start` (and
    `/agents:resume`), triggers the stop-then-create sequence. On
    `/agents:new`, **silently ignored** (the command already
    forceSpawns by definition; R3-F14).
- **`--` separator**: ends flag parsing. Subsequent tokens go
  into `passthroughArgs[]` verbatim, regardless of marker.
- **Unrecognized `--flag <value>`**: also accumulates into
  `passthroughArgs[]` (the parser does not error on unknown
  flags; round 3 deliberately lets pi-side flags pass through).
- **Missing name** → `name: ""`; handler surfaces the usage error.
- **LOC budget**: ≤60 lines for the parser function (was ≤45 in
  v1.2; the round-3 source classification adds ~15 lines).

**Handler source resolution** (`agents-command.ts`, in the ad-hoc
branch):

```ts
// Pseudocode for the source resolution step. Real impl is in
// agents-command.ts at the new branch.
const resolvedSystemFiles: string[] = [];
const resolvedSystemInline: string[] = [];
for (const src of parsed.systemPromptSources) {
  if (src.type === "file-or-inline") {
    // Strip surrounding double quotes from `#"..."` form.
    const raw = stripQuotes(src.value);
    if (fs.statSync(raw).isFile()) {
      resolvedSystemFiles.push(raw);
    } else {
      resolvedSystemInline.push(raw);
    }
  }
}
const resolvedUserParts: string[] = [];
for (const src of parsed.userSources) {
  if (src.type === "file-or-inline") {
    if (fs.statSync(src.value).isFile()) {
      resolvedUserParts.push(await fs.promises.readFile(src.value, "utf-8"));
    } else {
      resolvedUserParts.push(src.value);
    }
  } else {
    resolvedUserParts.push(stripQuotes(src.value));
  }
}
const systemPromptBody = resolvedSystemInline.join("\n\n---\n\n");
const task = resolvedUserParts.join("\n\n");
```

The synthesizer is then called with `systemPrompt: systemPromptBody`
and `systemPromptFiles: resolvedSystemFiles`. The C3 "did you
mean" warn lives in the synthesizer (§ 4.2) — the handler does
not need to know.

**`ensurePersistentPane` round 3 patch** (C4a + C4b):

```ts
// In extensions/subagent/pane.ts:782-826, the tmux split-window
// call (currently L810-820) becomes:
const tmuxArgs: string[] = [
  "split-window",
  paneDirection,            // C4b: '-h' or '-v' (was hardcoded)
  "-d",
  "-P",
  "-F",
  "#{pane_id}",
];
if (paneSize.unit === "%") {
  tmuxArgs.push("-p", String(paneSize.value));   // C4b: was hardcoded "50"
} else {
  tmuxArgs.push("-l", String(paneSize.value));   // C4b: lines mode
}
tmuxArgs.push(
  "-t", paneTargetId,                           // C4b: was hardcoded primaryPaneId
  "-c", cwd,
  "bash", paths.launcherFile,
);

let result = await tmux(tmuxArgs);
if (result.code !== 0 && tmuxArgs.includes("-p")) {
  // C4a: tmux rejects the split when percent is missing/invalid
  // (computed percent can be < 10 in dense layout groups, or a
  // tmux version mismatch emits "size missing"). Retry without
  // `-p` so tmux picks its default split; this is a fallback
  // path, not the primary flow.
  const fallback = tmuxArgs.filter((_, i) => tmuxArgs[i - 1] !== "-p" && tmuxArgs[i] !== "-p");
  // The filter removes both "-p" and its value token. tmuxArgs
  // shape: [..., "-p", "30", ...]. Element i is "-p" → drop;
  // element i+1 immediately follows "-p" → also drop. Result:
  // [..., "-c", cwd, "bash", launcherFile] (size flag removed,
  // its value token removed in the same pass).
  result = await tmux(fallback);
}
if (result.code !== 0) throw new Error(`Failed to launch tmux pane for ${agent.name}: ${result.stderr || result.stdout}`.trim());
```

The launcher script (`pane.ts:715-734`) is also extended to
append `passthroughArgs` after the recognized `--tools` flag and
before any positional `Task:` argument, so unrecognized `--xxx`
flags reach the spawned `pi` argv.

**Lifecycle events**: unchanged from v1.2. `--no-pane` bg path
emits `subagents:started` from `runner.ts:669`; pane path emits
`subagents:queued` / `subagents:created` via
`queuePersistentPaneTask`.

### 4.6 Tests

`tests/adhoc-synth.test.ts` (new file):

1. **Synthesizer with no prompt material** — `name: "x"`, no
   `systemPrompt`, no `systemPromptFiles` →
   `agent.systemPrompt === ""`, `agent.pane === true`.
2. **Synthesizer with inline body** — `systemPrompt: "be terse"` →
   composed prompt is `"be terse"`.
3. **Synthesizer with fragment files** — two files in `cwd/`,
   `systemPromptFiles: ["./a.md", "./b.md"]` → composed prompt is
   `<a>\n\n---\n\n<b>`.
4. **Synthesizer with body + fragments** — fragment + body →
   composed prompt is `<fragment>\n\n---\n\n<body>`.
5. **Bad name** — `name: "with spaces"` throws with a clear error.
6. **Missing fragment file** — `systemPromptFiles: ["./nope.md"]`
   throws with the path and the agent name.
7. **Pane override defaults to true** — no `pane` passed →
   `agent.pane === true`.
8. **Pane override false** — `pane: false` → `agent.pane === false`.

`tests/adhoc-dispatch.test.ts` (new file): integration tests that
exercise the `subagent` tool's ad-hoc branch end-to-end through
`dispatch.ts`. Use the existing `prepareSingleResultForReturn` /
`runSingleDispatch` plumbing without spawning real `pi` processes
(set a stub in `runner.ts:setBgSpawnForTests`-style seam).

1. **`subagent({ agent: "foo", task: "..." })`** with no `.md` file
   → empty-pi ad-hoc, dispatched, `agent.name === "foo"` and
   `agent.systemPrompt === ""`.
2. **`subagent({ agent: "foo", task: "...", systemPrompt: "..." })`**
   → synthesized with composed prompt containing the inline body.
3. **`subagent({ agent: "foo", taskFile: "./t.md", pane: false })`**
   → bg dispatch (`kind: "oneshot"`), task content matches file
   contents.
4. **`subagent({ agent: "alpha", task: "...", systemPrompt: "..." })`**
   where `alpha` IS in inventory → discovered agent wins,
   `systemPrompt` param ignored, warning emitted.
5. **`subagent({ tasks: [{ agent: "foo", task: "..." }], ... })`**
   where `foo` is not in inventory → refused with the
   "ad-hoc only supported in single mode" error.
6. **Pane override on discovered agent** — `subagent({ agent:
   "alpha", task: "...", pane: true })` where `alpha` has
   `pane: false` in frontmatter → routed through
   `runPersistentPaneAgent` instead of `runSingleAgent`.

`tests/adhoc-slash.test.ts` (new file):

1. `parseAdhocArgs("foo --pane --prompt-file ./a.md --task hi")` →
   `{ name: "foo", pane: true, promptFiles: ["./a.md"], task: "hi" }`.
2. `parseAdhocArgs("foo --no-pane")` →
   `{ name: "foo", pane: false, promptFiles: [], task: undefined }`.
3. `parseAdhocArgs("foo --task-file ./t.md")` →
   `{ name: "foo", pane: true, promptFiles: [], taskFile: "./t.md" }`.
4. Missing name → empty `name` (handler surfaces usage error).
5. Duplicate `--prompt-file` → all values collected into the array.
6. `parseAdhocArgs("foo --pane --no-pane")` →
   `{ name: "foo", pane: false }` (last-wins; `--no-pane` wins).
7. `parseAdhocArgs("foo --prompt-file \"/path/with spaces.md\"")` →
   `{ name: "foo", pane: true, promptFiles: ["\"/path/with", "spaces.md\""] }`
   (parser does **not** consume shell quotes — the file path
   with spaces breaks into two tokens; this is intentional, see
   § 4.5 contract).

### 4.7 Documentation

Update `README.md` and `CHANGELOG.md` to mention:

- `subagent` now accepts `pane`, `systemPrompt`, `systemPromptFiles`,
  `taskFile`.
- `/agents:adhoc` is available.
- Discovered-agent flow is unchanged.

The LLM-visible tool description at
`extensions/subagent/index.ts:1953-1963` must also be updated. The
existing array contains the now-incorrect sentence *"Agent names
are checked against selected inventory before launch; unknown
names fail with available agents."* Replace it with the
ad-hoc-aware prose below. Final array (one entry per
bullet, joined with `. `):

```text
- Delegate tasks to specialized agents with isolated context.
- Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).
- Bg agents use fresh one-shot sessions by default; pass sessionKey only when you want continuity.
- Agent names are checked against selected inventory before launch; single-mode unknown names are synthesized as ad-hoc agents (empty pi unless systemPrompt/systemPromptFiles are provided).
- systemPrompt/systemPromptFiles compose via composeAgentPrompt (spec 001 semantics); taskFile reads cwd-relative and overrides task when both are set.
- Pane override (pane: true|false) forces lane choice for both discovered and ad-hoc; ad-hoc defaults to pane: true and therefore requires tmux in single mode unless pane: false is passed.
- Ad-hoc is single-only; tasks:[...] and chain:[...] still require discovered agents.
- Parallel calls run through a flat worker pool capped at maxConcurrency (default 4); callers do not need to split requests.
- Results are truncated by default to ${DEFAULT_RESULT_MAX_LINES} lines or ${formatSize(DEFAULT_RESULT_MAX_BYTES)}; full oversized output is saved under the session runtime when enabled.
- Default agent scope is "project" (nearest project .pi/agents plus .claude/agents compatibility).
- Use agentScope: "both" to include user-level agents from ~/.pi/agent/agents and ~/.claude/agents.
```

---

## 5. Acceptance Criteria

Round 3 maps each row of `tests/__contracts__/002-adhoc-pane-agent.md`
to a test case in one of: `tests/adhoc-synth.test.ts` (S1–S10),
`tests/adhoc-slash.test.ts` (L1–L15), `tests/adhoc-dispatch.test.ts`
(D1–D8), `tests/adhoc-bugfix.test.ts` (C1–C4b). **Total: 62 rows**
(17 spec-§5 rows + S1–S10 (10) + L1–L15 (15) + D1–D8 (8) + C1–C4b'''' (12)).
Spec §4.6 covers the test file layout; this section is the
acceptance contract.

### 5.1 subagent tool surface (rows 1–9, 18–21)

- [ ] `subagent({ agent: "foo", task: "...", systemPrompt: "..." })`
      succeeds when `foo` is not in any agent directory. *(row 1)*
- [ ] `subagent({ agent: "foo", task: "...", systemPromptFiles:
      ["./a.md", "./b.md"] })` succeeds and joins the files into
      a single `--append-system-prompt` body. *(row 2)*
- [ ] `subagent({ agent: "foo", task: "..." })` with neither
      `systemPrompt` nor `systemPromptFiles` succeeds (empty pi).
      *(row 3)*
- [ ] `subagent({ agent: "foo", taskFile: "./t.md" })` reads
      `t.md` and uses its contents as the task. *(row 4)*
- [ ] `subagent({ agent: "foo", taskFile: "./t.md", task: "..." })`
      warns and uses `t.md` contents. *(row 5)*
- [ ] `subagent({ agent: "foo", pane: false })` for ad-hoc forces
      a bg dispatch (no tmux pane opened). *(row 6)*
- [ ] `subagent({ agent: "alpha", pane: true })` where `alpha`
      has `pane: false` in frontmatter forces a pane dispatch.
      *(row 7)*
- [ ] `subagent({ agent: "alpha", pane: false })` where `alpha`
      has `pane: true` in frontmatter forces a bg dispatch.
      *(row 8)*
- [ ] `subagent({ tasks: [{ agent: "foo", task: "..." }] })`
      where `foo` is not in inventory fails with the ad-hoc-in-
      parallel-mode error. *(row 9)*
- [ ] `subagent({ agent: "foo", replace: true })` → synthesizer
      receives `mode: "replace"`. *(row 18, round 3)*
- [ ] `subagent({ agent: "foo", model: "MiniMax-M2.7" })` →
      `AgentConfig.model` is `"MiniMax-M2.7"`. *(row 19, round 3)*
- [ ] `subagent({ agent: "foo", cwd: "/p" })` → synthesizer uses
      `/p` as fragment resolution root + pane cwd. *(row 20,
      round 3)*
- [ ] `subagent({ agent: "foo", passthroughArgs: ["--temperature",
      "0.7"] })` → launcher script receives the array appended to
      `pi` argv. *(row 21, round 3)*

### 5.2 `/agents:new` and `/agents:start` surface (rows 10–12)

- [ ] `/agents:new foo ./base.md -- "do X"` opens a pane and
      queues the task (round 3: `/agents:new`, R2 grammar).
      *(row 10)*
- [ ] `/agents:new foo ./base.md --no-pane -- "do X"` runs as a
      one-shot bg agent. *(row 11)*
- [ ] `/agents show foo` (after an ad-hoc spawn) shows the
      enriched `(ad-hoc, ephemeral — synthesized at call time)`
      placeholder, the joined prompt, and the pane flag. *(row 12)*

### 5.3 Synthesizer + system sources (rows 13–14)

- [ ] Missing `#<unquoted-path>` system source fails with a clear
      error naming agent + path (no silent skip). *(row 13)*
- [ ] Invalid `name` (e.g. spaces) fails the synthesizer with a
      clear error. *(row 14)*

### 5.4 Suite-level invariants (rows 15–17)

- [ ] `bun test ./tests ./extensions/subagent/__tests__` passes.
      *(row 15)*
- [ ] No regression in existing pane lifecycle, session
      persistence, or task dispatch behavior. *(row 16)*
- [ ] `subagent` with the **discovered** agent path (no new
      params) is byte-identical to the v1.0 behavior. *(row 17)*

### 5.5 Round 3 bug-fix contracts (rows C1–C4b)

- [ ] **C1**: `subagent({ agent: "foo", pane: true })` invoked
      with `$TMUX` unset emits a warning containing `"tmux"` and
      `"pane disabled"`, then dispatches as bg. *(adhoc-bugfix)*
- [ ] **C2**: `/agents:start alpha --new-pane` stops the existing
      live pane + creates fresh (`forceSpawn: true`). *(adhoc-bugfix)*
- [ ] **C3**: ad-hoc synthesis with no system sources + name near
      a discovered agent emits `console.warn` with `"did you
      mean"` hint. *(adhoc-bugfix)*
- [ ] **C3'**: ad-hoc synthesis with `#./base.md` (non-empty
      sources) emits **no** warn. *(adhoc-bugfix)*
- [ ] **C4a**: `ensurePersistentPane` tmux split fails with
      "size missing" → retry without `-p`, succeeds on second
      attempt. *(adhoc-bugfix)*
- [ ] **C4a'**: retry succeeds with tmux's default split. *(adhoc-bugfix)*
- [ ] **C4b**: `--pane-direction v` → `tmux split-window -v`.
      *(adhoc-bugfix)*
- [ ] **C4b'**: `--pane-size 30%` → `tmux split-window -p 30`.
      *(adhoc-bugfix)*
- [ ] **C4b''**: `--pane-size 25l` → `tmux split-window -l 25`.
      *(adhoc-bugfix)*
- [ ] **C4b'''**: `--pane-target <id>` → `tmux split-window -t <id>`.
      *(adhoc-bugfix)*
- [ ] **C4b''''**: `/agents:start alpha` (no pane flags) defaults
      to `-h -p 50 -t primary`. *(adhoc-bugfix)*

---

## 6. Implementation Steps (PR 6 → 7 → 8 → 9)

Round 3 originally proposed splitting PR 8 into 8a (dispatcher
integration) and 8b (slash command UI for `/agents:start` +
passthrough + C4b). The split was retracted in review (R3-F6):
both surfaces share the same R2 parser and the same grammar
shape, so an in-between state with one command using R2 and the
other using round-2 would be inconsistent. Round 3 ships as a
single PR 8 covering both `/agents:new` and `/agents:start`.

All PRs target `feature/adhoc-agent` and follow the charter §4
TDD cycle (red → green → optional refactor per test row, with the
round-3 commit prefix `spec 002 §Y.<test-name> <red|green|refactor>`
or `spec 002 §3.6.<test-name>` for slash-command rows). Each PR is
independently mergeable; PR N+1 builds on PR N. PRs are squash-merged
into `main` once each PR's TDD cycles complete and the suite is
green. After all PRs land, charter §5 step 7 (sub-meta smoke) +
step 9 (reviewer released) gate release.

### PR 6 — `feat: synthesizeAdhocAgent helper + tests (S1–S10)`

- New helper `synthesizeAdhocAgent` in `agents.ts` (§ 4.2),
  including round-3 `replace` mode (local `fragments.slice(-1)`
  filter before `composeAgentPrompt`), `model` override,
  `passthroughArgs` preservation on the returned `AgentConfig`,
  and the C3 "did you mean" warn (gated by the typed
  `input.nearestDiscoveredName` field).
- New file `tests/adhoc-synth.test.ts` with rows S1–S10.
- No call-site changes yet.

### PR 7 — `feat: subagent tool + dispatcher + C4a + D1–D8`

- Extend `SubagentParams` (§ 4.1) with all 8 round-2 + round-3 fields.
- Add ad-hoc recognition branch in `index.ts:subagent execute`
  (§ 4.3) + `runSingleDispatch` `paneOverride` (§ 4.4). The
  C1 tmux-availability warn is **scoped to the ad-hoc branch**
  (not fired for discovered agents; R3-F2 / R3-E2).
- Patch `ensurePersistentPane` for **C4a** (try/catch retry without
  `-p` on "size missing") at `pane.ts:810-820` (§ 4.5 round-3 patch,
  annotated per R3-E8).
- Add `tests/adhoc-dispatch.test.ts` with D1–D8 (D7, D8 are round 3).
- Add `tests/adhoc-bugfix.test.ts` for C4a, C4a' (the retry path).
- No slash command yet.

### PR 8 — `feat: /agents:new + /agents:start R2 grammar + pane flags + C1/C2/C3/C4b`

- Extend `agentsHandler` `start`/`new` branches with the R2 grammar
  parser (`parseAdhocArgs`, § 4.5 round-3 contract, ≤60 LOC
  unless reviewer explicitly approves over-budget per R3-E7).
- Wire `--replace`, `--model`, `--cwd`, `--pane-direction`,
  `--pane-size`, `--pane-target`, `--no-pane` into the call chain.
- Wire `--no-pane` + `$TMUX` unset fallback for **C1** at the
  dispatcher layer (warn + bg).
- Add `--new-pane` flag (C2) on `/agents:start` and `/agents:resume`
  only (silently ignored on `/agents:new`, which already
  forceSpawns; R3-E12).
- Surface `--pane-direction`, `--pane-size`, `--pane-target` to
  `ensurePersistentPane` (C4b) by parameterizing the
  `tmux split-window` invocation (§ 4.5 round-3 patch).
- Wire C3 "did you mean" warn through the typed
  `input.nearestDiscoveredName` field on `SynthesizeAdhocAgentInput`
  (R3-E3).
- Wire `passthroughArgs` through the launcher script:
  `pane.ts:715-734` appends the array to `pi` argv after the
  recognized `--tools` flag, wrapping each entry with `shellQuote`
  (`names.ts:3`) per R3-E9 / R3-F10.
- Add `tests/adhoc-slash.test.ts` L1–L15 +
  `tests/adhoc-bugfix.test.ts` C1, C1', C2, C3, C3', C4b, C4b',
  C4b'', C4b''', C4b''''.

### PR 9 — `docs: README + CHANGELOG + C4b user docs`

- Document the 8 new tool parameters and the R2 grammar on
  `/agents:new` + `/agents:start`.
- Update the v1 "Known limitations" section to remove the
  "ad-hoc requires an agent file" constraint (now lifted).
- Add a "Pane flags" section for `--pane-direction` / `--pane-size`
  / `--pane-target` with examples.
- Add a "Passthrough flags" section explaining that unrecognized
  `--xxx <value>` flags reach the spawned `pi` argv (shell-escaped).
- CHANGELOG entry: "feat: ad-hoc pane agent launch with R2 grammar
  (spec 002)".

---

## 7. Risks and Open Questions

1. **Synthesized agent vs discovered agent on a name collision.**
   Today, when `params.agent` matches a discovered agent, the
   discovered agent wins regardless of ad-hoc params. This is
   intentional (4A: "discovered takes precedence"). If the caller
   passes `systemPromptFiles` for a discovered agent, the params
   are silently ignored. **Risk**: silent confusion. **Mitigation**:
   log a one-time `console.warn` when `params.agent` matches a
   discovered agent AND any ad-hoc prompt param is present,
   stating that the discovered agent's prompt is used.
2. **Pane default for ad-hoc.** Defaulting to `pane: true` may
   surprise users who expect ad-hoc to be transient. **Mitigation**:
   `pane: false` is one extra line; document the default in the
   tool description.
3. **`name` collision with discovered agents.** If the caller
   picks a name that already exists, the synthesized agent is
   skipped (the discovered one wins per Risk 1) and the call
   proceeds — possibly to a different agent than the caller
   expected. **Mitigation**: the `console.warn` in Risk 1 covers
   the prompt side; for the name side, document that ad-hoc
   names must be unique vs. inventory, or add an opt-in
   `assertUnique: true` flag in v2 if real collisions arise.
4. **Async synthesizer in `index.ts`.** The subagent tool
   `execute` is already async; no new event-loop turn is
   introduced. **Risk**: an unreadable fragment file now turns
   the call into a failed dispatch, where v0 it was an inventory
   error. Both are failures — no new attack surface, but the
   error wording changes. Document in the changelog.
5. **Empty-pi security.** A user can spawn a pi with no system
   prompt. The spawned pi then runs with whatever defaults pi
   itself applies (likely the upstream default system prompt).
   This is not new (spec 001's empty-body agents already did
   this), but worth calling out so users know ad-hoc empty pi
   inherits pi's default rather than a project-supplied baseline.
6. **`taskFile` content size.** No upper bound. A 100 MB task file
   becomes a 100 MB argument to the spawned pi. **Mitigation**:
   document the limit; no hard cap in v1.
7. **Slash command `--prompt` arg quoting.** Quoting in
   `/agents:adhoc foo --prompt "be terse"` depends on shell
   quoting and on the `args.trim().split(/\s+/)` parser inherited
   from existing `/agents:*` commands (which does not strip
   quotes). Multi-line prompts are the worst case; single-line
   values with embedded spaces also break (e.g. `--prompt "be
   terse"` parses as `--prompt "\"be"` with `"terse\""` becoming
   `--task terse"`). **Mitigation**: document and use
   `--prompt-file` for any prompt containing whitespace; a v2
   follow-up may add shell-style quoting to the parser.

8. **Empty-pi ad-hoc requires tmux.** `subagent({ agent: "foo",
   task: "..." })` (single mode, unknown name, no prompt params)
   defaults to `pane: true`. **Round 3 status: implemented
   (C1)** — the dispatcher path at § 4.3 emits a one-time
   `console.warn` and forces `pane: false` when `$TMUX` is
   unset, so `runPersistentPaneAgent` is not reached. The
   underlying `ensureTmux()` at `extensions/subagent/pane.ts:105-108`
   still throws `Persistent pane agents require tmux ($TMUX is
   unset)` for any path that actually invokes it; ad-hoc no
   longer does. **Workaround for explicit bg**: pass
   `pane: false` (tool surface) or `--no-pane` (slash command).
   Cross-references: § 12.3 (limitation retired), § 10.4
   (deferred closed), § 7 Risk 12 (round-3 entry with C1
   mitigation details).

9. **`description: "(ad-hoc)"` is opaque in `/agents show`.**
   After an ad-hoc spawn, `agents show <name>` renders the
   description placeholder as if it were the agent's real
   description — indistinguishable at a glance from a real-but-
   empty description. **Mitigation**: enrich the placeholder
   string to `"(ad-hoc, ephemeral — synthesized at call time)"`; v2
   may surface prompt byte-length too.

10. **`taskFile` size hits argv `E2BIG`.** A multi-megabyte
    `taskFile` is concatenated into the spawned `pi` argv via
    `args.push(\`Task: ${task}\`)` at `runner.ts:660`. Linux
    `ARG_MAX` (~256 KB depending on kernel) rejects larger
    strings; the spawn fails with `E2BIG` from `execve`. (Wording
    correction: § 7 Risk 6 previously claimed "100 MB argument";
    the actual ceiling is `ARG_MAX`, not 100 MB.) **Mitigation**:
    document; no hard cap in v1.

11. **Ad-hoc pane reuses across calls.** `ensurePersistentPane`
    (`pane.ts:782-826`) reuses a live tmux pane for the same
    agent name across successive dispatches — discovered agents
    have always worked this way, but ad-hoc feels ephemeral and
    users may expect a fresh pane per call. **Mitigation**:
    pass `forceSpawn: true` (the existing pane-only escape
    hatch) to reset session and re-spawn. Document in README.
    Round 3 / C2 adds the user-facing `--new-pane` flag on
    `/agents:start` so the escape does not require programmatic
    access.

12. **Round 3 / C1 — tmux availability gap** *(implemented)*.
    Defaulting ad-hoc to `pane: true` would have caused a user
    invoking `/agents:new` from a fresh pi session (where `$TMUX`
    is unset) to hit the underlying
    `Persistent pane agents require tmux` error path. **Round 3
    fixes this** at the dispatcher layer (§ 4.3): a one-time
    `console.warn` fires and `pane` is forced to `false`, routing
    the dispatch to `runSingleAgent` instead of
    `runPersistentPaneAgent`. `--no-pane` remains the programmatic
    escape. The pane-layer itself (`ensurePersistentPane`) still
    requires `$TMUX`; the fix is purely at the dispatcher layer.
    **Mitigation**: warn-and-fallback per contract C1; documented
    in README that "ad-hoc without tmux is bg-only by default".
    Cross-references: § 4.3 implementation, § 12.3 limitation
    retired, § 10.4 deferred closed.

13. **Round 3 / C3 — typo "did you mean" warn noise.** The C3 warn
    fires whenever the synthesizer is invoked with no system
    sources AND the requested name is near (Levenshtein ≤2) a
    discovered agent. False positives: the user may legitimately
    want an empty-pi ad-hoc whose name happens to resemble a
    discovered agent. **Mitigation**: the warn is one-time
    `console.warn` (not an error); the empty-pi case still
    succeeds; users can suppress by providing `#./base.md` (any
    system source).

14. **Round 3 / C4a — split-size failure surface.** tmux
    `split-window -p N` rejects the call when N is missing or out
    of range. The current `pane.ts:810-820` always passes
    `-p <splitPercent>`; layout groups with ≥11 panes can compute
    `splitPercent < 10` (the `Math.max(10, ...)` floor), but the
    real failure mode observed in R5 was the user-reported
    "size missing" error from a tmux version mismatch. **Mitigation**:
    C4a retry without `-p` lets tmux pick its default split;
    second-attempt success verified by `bugfix-c4a-retry-default-split`.

15. **Round 3 / C4b — pane flag misuse.** `--pane-direction`,
    `--pane-size`, `--pane-target` are low-level tmux primitives
    and easy to misuse (e.g., `--pane-target <dead-pane-id>`
    fails silently). **Mitigation**: round 3 keeps the defaults
    (`-h -p 50 -t primary`) for users who omit the flags; users
    who opt in must understand tmux pane layout. Document the
    failure modes (target doesn't exist, size < 10, etc.) in
    README.

16. **Round 3 — passthroughArgs security surface.** Unrecognized
    `--flag value` tokens accumulate into `passthroughArgs` and
    reach the spawned `pi` argv. A user-supplied `--shell-command
    "rm -rf /"` would be passed through verbatim if `pi` itself
    honors it. **Mitigation**: the parser emits a one-time
    `console.warn` listing each unrecognized flag on first use;
    users opt-in by continuing. The launcher's argv handling is
    sandboxed by `pi`'s own argv layer. Passthrough content is
    unfiltered but shell-escaped via `shellQuote` per spec 001
    §4.7. Document in README that passthrough reaches `pi` argv
    unfiltered (content is shell-escaped, but not validated).

---

## 8. Spec After-Completion Archive Path

After all round-3 PRs (PR 6 / 7 / 8a / 8b / 9) merge to `main`:

- Move this spec from `specs/002-adhoc-pane-agent.md` (status
  `Approved`) to `specs/archive/002-adhoc-pane-agent.v1.md`
  (status `Implemented`).
- Update `specs/README.md` index entry.
- Begin `specs/003-runtime-call-time-prompt-override.md` for the
  deferred items in § 10, plus any spec 003 follow-ups for the
  R5 pane bugs that round 3 deferred (dashboard / TUI / cross-pane
  interaction layers).

**Release flow** is governed by the team charter (`docs/team-charter.md`
v1.2 after _charter-2 merge). The release flow walks charter §5
steps 1–10; round 3 ships at version **v0.2.0** which **skips
step 8 (`npm publish`) at reviewer discretion** (the per-version
`[POST-VN.M.P]` charter gate is a future amendment; see charter §7
Open Questions, line 249, and § 8 step-8 prose). Concretely:

- Steps 1–5 (PRs merged + `bun test` green + CHANGELOG + version
  bump + squash merge): reviewer-driven.
- Step 6 (archive + archive Status): reviewer owns.
- Step 7 (sub-meta local install smoke): sub-meta owns;
  representative flow + `[meta] smoke passed | smoke failed
  (blocker) | smoke failed (follow-up)` intercom report.
- Step 8 (`npm publish`): **skipped for v0.2.0** at reviewer
  discretion; the per-version `[POST-VN.M.P]` charter gate is a
  future amendment (see charter §7 Open Questions, line 249).
- Step 9 (`[review] released vN.M.P`): reviewer intercom.
- Step 10 (`specs/README.md` Implemented): sub-meta owns.

**Blocker handling**: step 7 smoke failures become review
findings; reviewer arbitrates fix PR vs. spec amendment. Step 8
post-publish failures (charter violation) trigger the rollback
path in `docs/team-charter.md` §5.

---

## 9. Reserved

Intentionally empty. Reserved for v2 ad-hoc-in-parallel and
call-time override specs to maintain stable chapter numbering.

---

## 10. Deferred Features (v2)

### 10.1 Ad-hoc in `tasks: []` (parallel) and `chain: []`

**Why deferred**: parallel and chain dispatch resolve multiple names
against the inventory at once (`validateAgentInventory`). Ad-hoc
synthesis is currently single-name only. Extending to N names needs:

- A way to mark **which** task items are ad-hoc (e.g.
  `task: "..."` + `systemPromptFiles: [...]` on each `TaskItem`,
  or a discriminated union).
- The synthesizer hoisted into the dispatch layer (currently
  inside the `subagent` tool's execute).
- Parallel result rendering that surfaces the synthesized agent's
  description and prompt length per result.

Tracked for v2.

### 10.2 Per-call prompt override on discovered agents

**Why deferred**: spec 001 § 11.1 already defers runtime prompt
mutation. Per-call prompt override on **discovered** agents is
adjacent: the static fragments are still loaded, but the call
site adds extra material. This requires:

- A schema change to `AgentConfig` to expose `extraFragments:
  string[]` separate from `systemPromptFragments`.
- Or, simpler, a new `overrideSystemPrompt: string` field that
  fully replaces the composed prompt for the duration of this
  dispatch.
- Tool-call ergonomics: callers will want
  `overrideFragments: string[]` and `overrideSystemPrompt: string`
  separately.

For v1, the discovered-agent path is untouched. v2 picks this up
under `specs/003-runtime-call-time-prompt-override.md`.

### 10.3 Ad-hoc tool allowlist

**Why deferred**: ad-hoc agents currently inherit the caller's
active tool set (no `denyTools` because no frontmatter). For
production safety, a future spec could add an optional
`denyTools: string[]` parameter to the synthesizer (caller
explicitly restricts the ad-hoc agent's tool set).

### 10.4 Ad-hoc agents in non-tmux environments

**Round 3 status: implemented (C1).** `ensurePersistentPane` still
requires `$TMUX` to be set (`pane.ts:111`); an ad-hoc caller
outside tmux falls back to bg dispatch (warns + uses
`runSingleAgent`) at the dispatcher level (§ 4.3), not at the
pane layer. v2 may revisit to add a tmux-bootstrap step (start
a tmux server if needed) for users who actively want a pane.

### 10.5 Interactive empty pane (no task)

`subagent({ agent: "foo" })` (no `task`, no `taskFile`) currently
errors as "Invalid parameters". § 12.7 / § 4.3 keep this behavior
because the alternative — a tmux pane that just sits there awaiting
input — adds a new lifecycle state the dashboard / registry /
stop_subagent have to model. v2 may revisit if real demand
appears: spin the pane up with a system prompt + an "idle" initial
state, and let the user interact directly.

### 10.6 Ad-hoc `description` enrichment

The v1 placeholder `"(ad-hoc, ephemeral — synthesized at call
time)"` (set in `synthesizeAdhocAgent`) is a string-only signal.
A richer UX would surface:
- joined prompt byte-length (so the user can see at a glance
  that fragments composed);
- first fragment path (so the user can tell which base layer
  was loaded);
- the `cwd` used for fragment resolution (debugging).

This requires the dashboard / `/agents show` rendering to learn
the new fields. Tracked for v2.

### 10.7 Typo guard for ad-hoc dispatch

**Round 3 status: implemented (C3) for the warn path; remaining
options deferred.** The first bullet (one-time `console.warn`
on empty-pi + near-discovered-name) landed in round 3 — see
§ 12.7 and the synthesizer code at § 4.2 (gated by the typed
`input.nearestDiscoveredName` field passed in by the dispatcher
at § 4.3).

Deferred to v2:

- Optional `assertUnique: true` flag that refuses to synthesize
  when the requested name is within Levenshtein distance < 3 of
  a discovered agent name.
- Dashboard item that flags "this dispatch synthesized an ad-hoc
  agent; did you mean <discovered>?" for follow-up visibility.

The `assertUnique` flag in particular requires measuring how
often real users hit the typo case in practice; defer until
then.

---

## 11. Revision History

| Version | Date       | Author | Changes |
|---------|------------|--------|---------|
| v1.0    | 2026-08-12 | sub-tmux | Initial draft, derived from sub-meta answers 1A 2A 3B 4A 5A 6A. Targets `pi-subagent-fragments` 0.2.0. |
| v1.1    | 2026-08-12 | sub-tmux | Round-1 review fixes from review-subagent-tmux (verdict: Request changes): **F1** fix `paneOverride` strict-precedence ladder in § 4.4; **F2/F9** add § 12.7 (silent typo) and § 12.8 (`hasSingle` backward-incompat) and clarify § 1 "no-op" claim; **F3** update tool description array (§ 4.7); **F4** consolidate ad-hoc trigger expression, drop dead `if (hasChain || hasTasks)` branch (§ 3.5 + § 4.3); **F5** add Risks 8–12 (§ 7); **F6** drop `default: false` from `pane` schema (§ 4.1); **F7/E9** pin `parseAdhocArgs` contract, add 6th and 7th test cases, add parser-aware acceptance criteria; **F8** reword § 4.5 placement note; **F10–F13** pin join order, error prefix, mode rationale, name regex; **F14** fix test 2 prose; **F15** add cwd-scope note to § 12.6. New § 10.5–10.7 deferrals for interactive empty pane, description enrichment, typo guard. |
| v1.2    | 2026-08-12 | sub-tmux | Round-2 polish (verdict: Approve with comments): **R2-F1/E1** delete § 3.2 code block (prose-only); **R2-F2/E2** sync `description` placeholder to enriched string in § 4.2 code; **R2-F3/E3** sync error prefix to spec 001 grep target in § 4.2 code (both throw sites); **R2-F4/E4** delete redundant § 7 Risk 11 (pointer to Risk 7), renumber 12→11; **R2-F5/E5** fix § 5 acceptance criterion quote-stripping claim; **R2-F6/E6** drop "and ad-hoc params are present" from § 3.5 step 2 (empty pi always triggers synthesis). |
| v1.3    | 2026-08-12 | sub-tmux | Round-3 review fixes from review-subagent-tmux (verdict: **Approve with comments**): **R3-E1/F1** §4.2 implements replace mode locally via `fragments.slice(-1)` filter before `composeAgentPrompt`; **R3-E2/F2** C1 warn scoped to ad-hoc branch only; **R3-E3/F3** `nearestDiscoveredName` declared in `SynthesizeAdhocAgentInput`, cast hack dropped; **R3-E5/F6** PR split collapsed to single PR 8; **R3-E6/F11** `[POST-V0.2.0]` citation dropped from §8; **R3-E7/F8** parser LOC budget relaxed to "≤60 unless reviewer explicitly approves over-budget"; **R3-E8/F9** C4a retry filter annotated with tmuxArgs shape comment; **R3-E9/F10** passthrough shellQuote reference added; **R3-E10/F12** §7 Risk 16 mitigation strengthened (one-time warn + shellQuote + sandboxed argv layer); **R3-E11/F13** this verdict word; **R3-E12/F14** `--new-pane` explicitly silently ignored on `/agents:new`; **R3-E13/F15** contract count updated to 62 rows; **R3-E14/F16** §3.6 unrecognized-flag bullets merged. Cross-refs § 12.3 / § 12.7 / § 10.4 / § 10.7 / § 7 Risk 8 / § 7 Risk 12 updated to mark C1/C3 implemented. |
| v1.4    | 2026-08-12 | sub-tmux | Round-3 PR 6 polish (verdict: **Approve** for PR 6 commit series): **PR6-F1** §8 intro `[POST-V0.2.0]` mention replaced with "at reviewer discretion" + cross-ref to §8 step-8 line and charter §7 Open Questions. **PR6-F2** §7 Risk 8 stale "throws `Persistent pane agents require tmux`" prose retired to "implemented (C1) — dispatcher emits warn + forces pane:false when $TMUX unset"; cross-refs § 12.3 / § 10.4 / § 7 Risk 12 added. §7 Risk 12 wording tightened: pre-fix description moved to conditional ("would have caused"); C1 implementation paragraph clarified (one-time warn + pane:false routing, dispatcher-level fix). |
| v1.5    | 2026-08-12 | sub-tmux | Round-3 PR 7 fix batch (verdict: review-subagent-tmux `_pr7-1` finding fixup): **PR7-E1/F1 HIGH** `pane: fallbackToBg ? false : (params.pane ?? true)` in `extensions/subagent/index.ts` — C1 fallback now actually routes to bg lane (was just-warn-no-force; spec §3.8 + §7 Risk 12 prose promised bg dispatch, impl was half-wired). **PR7-E1 spec reconcile** §4.3 pseudocode updated; `tmuxAvailable` + `fallbackToBg` hoisted to named locals; shouldAdhocFallbackToBg helper referenced. **PR7-E2/F3** C1 + C1' strengthened to exercise `shouldAdhocFallbackToBg` directly: C1 asserts 6 boolean input combos + synthesizer returns `agent.pane === false` on fallback (regression test for PR7-F1); C1' substring check on warn string template. **PR7-E3/F3** C2 → `test.todo` (PR 8 agents-command.ts 真集成时回填). **PR7-F5** `applyC4aRetry(args: string[]): string[]` exported from `extensions/subagent/agents.ts` (utility module; not `pane.ts` per reviewer F5 + sub-meta F5); C4a + C4a' real tests use exported helper (not in-line filter; not `test.todo` — helper is pure, no tmux dep). **PR7-F2 retcon**: 5d90456 split into 323ab40 (red: tests only) + 823567b (green: impl only) per charter §4.5 TDD cycle audit. |
| v1.6    | 2026-08-12 | sub-tmux | Round-3 PR 8 cycles 1-4 (retcon + full path integration): **PR8 cycle 1** R2 grammar parser `parseAdhocArgs` + `tokenizeArgs` (quote-aware) + `AdhocParsedArgs`/`AdhocSystemSource`/`AdhocUserSource` types in `agents-command.ts`; L1-L15 tests + C2 promoted from test.todo to real. Cycle 1 retcon split `d009155` into `c767164` (red) + `bd94ef9` (green). **PR8 cycle 2** `buildTmuxSplitArgs` pure helper in `pane.ts` + `ensurePersistentPane`/`queuePersistentPaneTask`/`runPersistentPaneAgent` C4b params (`paneDirection`/`paneSize`/`paneTarget`); C4b 5 row tests (direction-v / size-percent / size-lines / target / defaults). Cycle 2 retcon split into `81e818a` (red) + `0903b82` (green). **PR8 cycle 3** C4a mock tmux retry (`ensurePersistentPane` retry on 'size missing' via `applyC4aRetry`) in `tests/pane-resilience.test.ts` (new file); C1 agents-command warn scope (helper-level). Cycle 3 retcon split `5c2693f` into `d02203a` (red) + `7b4905b` (green). **PR8 cycle 4** agents-command ad-hoc branch (name not in inventory → parse + synth + dispatch via `queuePersistentPaneTask` with C4b params); C1 warn scope in the ad-hoc path; D8 passthroughArgs reach launcher argv via shellQuote; stale C2 test.todo removed; spec §11 v1.6 row. Final suite 401 pass / 0 fail / 0 todo. |
| v1.7    | 2026-08-12 | sub-tmux | Round-3 PR 8 round 1 fix batch (verdict: review-subagent-tmux `_pr8-1.md`, Request changes, 2 HIGH + 2 MED). **PR8-E1 HIGH** `--no-pane` INVERTED: old `pane: fallbackToBg ? false : true` dropped `parsed.noPane`; new shared pure helper `resolveAdhocPane(tmux, noPane): boolean` in `agents.ts` (= noPane ? false : tmux). `--no-pane` forces bg regardless of tmux; non-tmux host falls back bg. Single source of truth for handler + tests. **PR8-E2 HIGH** C2 `--new-pane` parsed but never wired: new shared `resolveForceNewPane(command, newPaneFlag)` = (command==='new' || newPaneFlag) in `agents-command.ts`; BOTH paths consume the flag (discovered path detects trailing `--new-pane` token; ad-hoc path reads `parsed.newPane`); `forceNewPane && wantPane` triggers stop-then-create. **PR8-E3 MED** C1 warn-scope test drifted from handler (used `shouldAdhocFallbackToBg` + hardcoded true): now uses shared `resolveAdhocPane`, covering all 4 tmux×noPane combos. **PR8-E4 MED** D8 test didn't verify launcher argv: now runs `writeLauncher` and asserts exec line contains passthrough tokens shell-quoted (`x;y` → `'x;y'`, spec 001 §4.7); impl was already correct. Final suite 402 pass / 0 fail / 0 todo. |
| v1.8    | 2026-08-12 | sub-tmux | Round-3 PR 8 round 2 fix batch (verdict: review-subagent-tmux `_pr8-2.md`, Request changes, 1 HIGH/CRITICAL + 2 MED). **PR8-E5 HIGH/CRITICAL** `--no-pane` STILL never routed to bg (round-1 fix was cosmetic `pane: wantPane`; handler unconditionally called `queuePersistentPaneTask` → `ensureTmux` throw on tmux-less host): handler now branches on `wantPane` — pane lane → `queuePersistentPaneTask`; bg lane → `runSingleAgent` (same bg-dispatch path as subagent tool ad-hoc recognition in `index.ts`; reuse, not copy). New handler-level test file `tests/adhoc-handler.test.ts` invokes the REAL `agentsHandler` (via `registerAgentsCommands` + mock pi) to close the parsed-but-not-wired root pattern (PR7-F1 / PR8-F1 / PR8-F5 false confidence). **PR8-F6 MED** C1 warn fired on tmux-available hosts: condition changed from `!wantPane` to `!tmuxAvailable` — a tmux host passing `--no-pane` (explicit bg choice) no longer gets a fake 'tmux not available' message. **PR8-F7 MED** E2 C2 test was helper-only, contradicting its 'handler-level/mock tmux validates stop-then-create' claim: new handler-level test invokes `/agents:start --new-pane` via real handler + mock tmux (`setPaneExecCaptureForTests`) and asserts a tmux split-window (pane create) happens. Final suite 406 pass / 0 fail / 0 todo. |

---

## 12. Known Limitations (v1)

Inherited from spec 001 plus ad-hoc-specific constraints. **None of
these block v1 shipping** — each is a known boundary with a
workaround. Future spec revisions may lift some into v2 work.

### 12.1 Ad-hoc only in single mode

`tasks: [...]` and `chain: [...]` still require discovered agents.
See § 10.1.

### 12.2 Discovered agents ignore call-time prompt params

When `params.agent` matches a discovered agent, `systemPrompt`,
`systemPromptFiles`, and `taskFile` are silently ignored (with a
warning). See § 7 item 1.

### 12.3 Ad-hoc pane requires tmux

**Round 3 status: implemented (C1).** The `/agents:adhoc` command
was retired in round 3; `/agents:new` + `/agents:start` (the new
ad-hoc entry points) no longer throw when `$TMUX` is unset.
Instead, the dispatcher emits a one-time warning
(`[pi-subagent-fragments] tmux not available; pane disabled,
dispatching as bg.`) and falls back to `runSingleAgent`.
`ensurePersistentPane` itself still requires a tmux session
(`pane.ts:111`); the round-3 fix lives at the dispatcher level
(§ 4.3) where the warn + fallback fires before the pane path is
attempted. **Workaround for users who want bg explicitly**:
`--no-pane` (slash command) or `pane: false` (tool surface).

### 12.4 Ad-hoc names collide with discovered agents silently

A user-supplied name that matches a discovered agent name routes
to the discovered agent with a warning, not the synthesized one.
See § 7 item 3 (now also § 10.7 for v2 typo-guard mitigations).

### 12.5 No tool restriction for ad-hoc agents

Ad-hoc agents inherit the caller's active tools. There is no
`denyTools` field for ad-hoc dispatch. See § 10.3.

### 12.6 Fragment path containment is loose

Fragment paths resolve relative to `cwd` via `path.resolve`. A
`systemPromptFiles: ["../../etc/foo"]` will read outside the cwd.
This matches spec 001 § 13.3's policy for discovered fragments.

Ad-hoc fragments inherit the cwd's filesystem scope (the same
loose policy). For ad-hoc, there is no "agent file directory"
to anchor to — fragments live wherever the calling session's cwd
points. Note that `~` is **not** shell-expanded (the spec reads
files via `fs.promises.readFile`, not via shell); use absolute
paths or `${HOME}` to reference user files.

### 12.7 Silent typo of a discovered agent name

`subagent({ agent: "reviewe", task: "..." })` (typo of a
discovered `reviewer.md`) succeeds as an empty-pi ad-hoc
dispatch rather than failing with `"Unknown subagent(s)"`. The
typo is invisible at the synthesis layer.

**Round 3 status: C3 implemented.** When ad-hoc synthesis runs
without any system sources AND the requested name is within
Levenshtein distance ≤2 of a discovered agent name, the
synthesizer emits a one-time `console.warn` of the form
`[pi-subagent-fragments] Ad-hoc agent "<name>" synthesized
with no system sources. Did you mean "<discovered>"? (existing
agent file)`. See § 4.2 (synthesizer) and § 4.3 (dispatcher
passes the typed `nearestDiscoveredName` field). § 10.7 is now
**closed**.

### 12.8 `hasSingle` accepts `taskFile`-only — backward-incompat with v0

`subagent({ agent: "foo", taskFile: "./t.md" })` previously
failed with `"Invalid parameters. Provide exactly one mode"`
because v0's `hasSingle` only accepted `task`. It now succeeds as
a single-mode dispatch (this is intentional, since otherwise
`taskFile` alone would be useless). v0 callers that relied on
the error to detect typos now see no error.
