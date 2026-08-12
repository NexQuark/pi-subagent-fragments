# Spec 003: Runtime Prompt Injection for Live Agents

| Field | Value |
|---|---|
| **Status** | Approved (round 1 review 2026-08-12: OQ 2–5 resolved, amendments A1–A6; implementation pending) |
| **Target version** | `0.3.0` |
| **Scope** | This fork only (`@nexquark/pi-subagent-fragments`) |
| **Upstream base** | `vanillagreencom/vstack@faeb65af` (`pi-agents-tmux` 2.8.1) |
| **PRs** | TBD — depends on § 7 Open Question 1 (blocker path A/B/C/D) |
| **v2 reserved** | § 10 — cross-pane broadcast (pattern matching fan-out) deferred |

---

## 1. Background and Goal

spec 001 (fragment injection at load time) and spec 002 (call-time ad-hoc synthesis) both **set** the system prompt at agent launch. After launch, the system prompt is **frozen** in the running `pi` subprocess (read once from `--append-system-prompt <file>`). This is fine for short-lived tasks but blocks three real-world patterns:

1. **Long-running pane agent learns new convention mid-task.** A `reviewer` agent has been pinging away for 20 minutes when the user decides the project's convention has shifted ("from now on, focus on the new auth layer"). They want to push the new convention into the live agent's effective prompt without restarting the session and losing conversation context.
2. **A/B prompt experiment.** A user runs the same ad-hoc agent on a long task, observes its approach, then wants to substitute one half of the system prompt ("be terse" replaced with "be thorough"). Without spec 003, this requires restart + state handoff, both lossy.
3. **Add new fragments without restart.** A pane agent was launched with a base fragment but the user wants to add an overlay fragment mid-session without re-spawning.

**Goal of this spec (v1)**: extend the existing `subagent` tool and `/agents` slash commands with a runtime prompt mutation surface so the caller can:

- Replace the agent's effective system prompt with one of three modes (`--replace`, `--append`, `--add`).
- Target a single named agent by name (no glob / pattern fan-out in v1).
- Use existing R2 grammar for the new content (`#` / `#"..."` / `@` / `"..."` / `--cwd` / passthrough).
- Maintain a per-agent history of up to 10 prompt versions with rollback.
- Emit a `console.warn` to the user on every successful mutation (matching spec 002 C1/C3 pattern).

Mutations are **mid-task capable** via pi's `before_agent_start` hook (per turn, with `event.systemPrompt` readable and `systemPrompt` return-value replacing it for that turn). New prompt takes effect at the next agent turn, not mid-turn — same boundary semantics as `steer_subagent`.

**Key discovery (2026-08-12)**: pi's extension API exposes a `before_agent_start` hook that fires per user turn. Returning `{ systemPrompt: <new> }` replaces the prompt for that turn; the next turn fires the hook again. This means spec 003 is implementable **without pi upstream changes** — implementation path (E) uses this hook + persistent state. No `steer_subagent` extension needed; no fork.

**Non-goals (v1)**:

- Cross-pane broadcast (`/agents:inject <pattern>`); single-agent only. See § 10.
- Per-segment mutation (different prompts for different conversation turns). v2.
- Auto-rollback on completion / timeout. v2.
- Real-time prompt inspector UI in the popup. v2.

---

## 2. Current State Analysis

### 2.1 pi runtime hooks (path E viability)

`pi`'s extension API exposes a `before_agent_start` hook with per-turn mutation semantics. From the official `extensions/index.d.ts`:

```ts
export interface BeforeAgentStartEvent {
  type: "before_agent_start";
  prompt: string;
  images?: ImageContent[];
  /** The fully assembled system prompt string. */
  systemPrompt: string;
  /** Structured options used to build the system prompt. */
  systemPromptOptions: BuildSystemPromptOptions;
}

export interface BeforeAgentStartEventResult {
  /** Replace the system prompt for this turn. If multiple extensions
   *  return this, they are chained. */
  systemPrompt?: string;
}
```

The official comment on the event type reads: *"Fired after user submits prompt but before agent loop."* — i.e., **per user turn**, not per session.

Plus, `ExtensionContextActions.getSystemPrompt(): string` lets handlers read the current effective prompt at any time.

**Conclusion**: the upstream pi runtime does not have a "frozen after startup" limitation for system-prompt mutation — it has a hook that fires per turn with mutation capability. spec 003's blocker (Q2) is solved without upstream changes. Implementation path (E) (see § 4.4) is the chosen path.

For comparison, the older `--append-system-prompt <file>` CLI flag (`extensions/subagent/runner.ts:631-636`, `extensions/subagent/pane.ts:555-560`) is read once at subprocess spawn time and seeds the initial system prompt. The hook then takes over for subsequent mutations.

### 2.2 Existing injection surfaces (for context, not used by spec 003)

- `steer_subagent` — sends user-message steering via `pi-session-bridge`. **Does not** modify the system prompt; only injects user-level messages.
- `complete_subagent` — only persistent pane children; marks a task as complete and persists outbox JSON. **Does not** modify session state.
- `send_user_message` (bg only) — direct user message injection in bg contexts. Same constraint: user message, not system prompt.

None of these provide runtime **system-prompt** mutation. spec 003 introduces it via `before_agent_start` hook + persistent state (path E).

### 2.3 Spec 002 ad-hoc synthesizer reuse

Spec 002's `synthesizeAdhocAgent` (`extensions/subagent/agents.ts`) accepts `systemPromptSources` and produces a composed string. spec 003 should **reuse** the same composition logic (R2 grammar, fragment resolution, replace-mode filter) for the new content. No duplication.

### 2.4 History / rollback infrastructure

No history exists today. spec 003 introduces a per-agent FIFO queue of up to 10 versions, persisted alongside the pane registry (`specs/registry/pane-registry.json`). New module: `extensions/subagent/prompt-history.ts`.

### 2.5 What is missing

- A way to **invoke** runtime prompt mutation on a live agent.
- A way to **resolve** the three mutation modes (`--replace`, `--append`, `--add`) into an effective prompt string given the current state.
- A way to **persist and roll back** through prompt versions.
- An implementation path that **overcomes** the pi runtime limitation (see § 7 Open Question 1).

---

## 3. Design

### 3.1 Command shape (R2 grammar locked)

```
/agents:inject <name> [--replace | --append | --add] [<system-source>...] [--rollback [N]] [--history]

flags (mutually exclusive — exactly one):
  --replace           clean slate; effective prompt = NEW only
  --append            effective prompt = pi-default + NEW
  --add               effective prompt = (current-effective) + NEW
  --rollback [N]      revert to version N versions back (N omitted = 1)
  --history           list saved versions (read-only; does not mutate)

flags (passthrough — same R2 grammar as spec 002 § 3.6):
  --cwd <path>        fragment resolution root + pane cwd
  --temperature N     passthrough to pi argv (any --xxx not in this list)

system sources (R2 grammar, spec 002 § 3.6):
  #<unquoted-path>    read file (must exist)
  #"<quoted>"         file if exists, else inline string
  <bare args>         after the recognized flags, accumulated as inline strings
                      (note: spec 002 used #/@"..." for the user-source slots;
                       spec 003 only deals with system-prompt sources, so no
                       @ / "<text>" user-source variants)

defaults:
  mode                --append if no mode flag and not --rollback / --history
  rollback N          1 (immediate previous version)
  history             --history without value returns last 10 versions
```

**Mutually exclusive rule**: parser enforces exactly one of `--replace`, `--append`, `--add`, `--rollback [N]`, `--history`. Conflicting flags → `Error: inject: --replace / --append / --add / --rollback / --history are mutually exclusive`.

### 3.2 Three modes — concrete effective prompt

Let `<new>` = composed result of system sources (R2 grammar). Let `<current>` = current effective system prompt of `<name>` (read at injection time). Let `<pi-default>` = the system prompt pi applies when `--append-system-prompt` is empty (upstream default; not directly readable from our side; we treat it as opaque base).

| Mode | Effective prompt after mutation | Effect on `<pi-default>` | Effect on `<current>` |
|---|---|---|---|
| `--replace` | `<new>` | discarded | discarded |
| `--append` | `<current-effective>` + `<new>` | preserved (as part of current) | preserved |
| `--add` | `<current-effective>` + `<new>` | preserved (as part of current) | preserved |

> **v1 note (round 1 review OQ3, 2026-08-12)**: `<pi-default>` is opaque to
> the subagent extension — we never read or write it. The write side composes
> from the agent's **current effective prompt** (read from the pane registry /
> synthesizer, which already includes the pi-default base seeded at launch via
> `--append-system-prompt`). Consequently `--append` and `--add` are
> **aliases in v1** (both = current + new); they are kept as separate flags for
> R2 grammar lock and may diverge in a later version that introduces a
> per-segment base concept. The state file stores the **fully composed**
> effective prompt, so a subsequent mutation composes on top of the last
> composed value.

### 3.3 Hot-swap semantics (path E)

Mutations are **mid-task capable** in the sense that:

- The new prompt is **queued for the agent's next turn** (not mid-turn tear-up).
- If the agent is currently processing a tool call or generating a response, that turn completes with the **previous** system prompt; subsequent turns use the new one.
- This matches `steer_subagent` semantics — the steered message arrives at the next turn boundary.

The implementation registers a `before_agent_start` handler:

```ts
// extensions/subagent/prompt-inject.ts (new)
const STATE_DIR = `${homedir()}/.cache/pi-subagent-fragments/inject`;

pi.on("before_agent_start", (event, ctx) => {
  const name = ctx.sessionManager.getSessionName();
  if (!name) return;
  const stateFile = injectStatePathFor(name);
  let state: { systemPrompt: string; prev: string };
  try {
    state = JSON.parse(readFileSync(stateFile, "utf-8"));
    unlinkSync(stateFile); // one-shot consumption
  } catch {
    return; // no pending injection
  }
  pushHistory(name, { prev: event.systemPrompt, new: state.systemPrompt });
  return { systemPrompt: state.systemPrompt };
});

> **round 1 review A1/A3 (2026-08-12)**: name lookup is
> `ctx.sessionManager.getSessionName()` (the `ExtensionContext` surface —
> `getSessionName` lives on `ReadonlySessionManager`, not on `ctx` directly).
> `injectStatePathFor(agentName)` is the **single shared path helper** between
> the write side (`/agents:inject`) and this read side — no duplicated path
> construction (PR8-E3 regression guard).
```

The state file is written by `/agents:inject <name> ...` (see § 4.2) before the next user turn. The hook consumes it one-shot at the next turn boundary.

For both pane and bg lane agents, this mechanism works because the extension is registered per-session and runs in the same process as the agent.

### 3.4 History & rollback

Per-agent FIFO queue of up to 10 versions:

- On successful mutation, push the **previous** effective prompt onto the queue (so rollback restores it).
- Cap at 10; oldest evicted on overflow.
- `--rollback N` reverts to `queue[N-1]` (1-indexed: `--rollback 1` = immediately previous; `--rollback` = same as `--rollback 1`).
- `--rollback` when queue is empty → `Error: inject: no prior versions to roll back to`.
- `--history` lists versions with timestamp + mode + size.

Storage: session runtime dir — `runtimeDirForContext(ctx)/prompt-history/<agent-name>.json` (round 1 review OQ2 ruling, 2026-08-12). Session-scoped to the parent session that owns the live pane, beside `panes.json` / `tasks.json` / `sessions/` — one lifecycle, one cleanup story; survives parent-session restarts (runtime dir keyed by parent session id, matching how the pane registry already works). Not `~/.cache` (would leak across machines/sessions and survive agent teardown).

### 3.5 User notification

`console.warn` on every successful mutation, matching spec 002 C1/C3 pattern:

```
[pi-subagent-fragments] inject: <name> mode=<replace|append|add> bytes=<N> history=<queue-length>
```

On `--history`: emit a markdown table via `pi.sendMessage` (not console.warn).

On `--rollback`: same warn format with `mode=rollback`.

### 3.6 Tool surface (subagent tool addition)

`SubagentParams` gains:

```ts
inject?: {
  name: string;
  mode: "replace" | "append" | "add";
  sources: SystemPromptSource[];
  rollback?: number;
  history?: boolean;
  cwd?: string;
};
```

`SystemPromptSource` is the typed version of R2 grammar (already defined in spec 002 § 4.1).

### 3.7 Trust and tools

- Ad-hoc injections inherit the caller's tool set (no separate `denyTools`; consistent with spec 002 ad-hoc).
- History files are written under the session runtime dir; not exposed to the agent.
- `--rollback` is **destructive** but bounded (queue cap 10). No undo beyond the queue.

---

## 4. Implementation Details

> **§ 7 Open Question 1 (blocker path) determines most of § 4.**
>
> Below is the architecture-agnostic core; implementation specifics depend on which of A/B/C/D the user picks at round 1 review.

### 4.1 Composition reuse

```ts
// extensions/subagent/prompt-inject.ts (new file)
import { composeAgentPrompt } from "./prompt-compose.js";
import { readFileSync } from "node:fs";
import path from "node:path";

export interface SystemPromptSource {
  kind: "file" | "string";
  value: string;
}

export interface InjectInput {
  name: string;
  mode: "replace" | "append" | "add";
  sources: SystemPromptSource[];
  cwd: string;
  current?: string;          // current effective prompt (for --add)
  piDefaultOpaque?: true;    // marker: we don't have pi-default content
}

export interface InjectResult {
  effective: string;
  prev: string | undefined;  // previous effective (for history push)
  bytes: number;
}

export function composeInjection(input: InjectInput): InjectResult {
  const fragments = input.sources
    .filter((s) => s.kind === "string")
    .map((s) => s.value);
  const fileContents = input.sources
    .filter((s) => s.kind === "file")
    .map((s) => readFileSync(path.resolve(input.cwd, s.value), "utf-8"));
  const allFragments = [...fragments, ...fileContents];
  const newPart = composeAgentPrompt({
    body: "",
    fragments: allFragments,
    mode: "append",
  });
  let effective: string;
  switch (input.mode) {
    case "replace":
      effective = newPart;
      break;
    case "append":
      // pi-default is opaque; we just emit `newPart` and the implementation
      // path appends it to pi-default's base via the chosen mechanism.
      effective = newPart;
      break;
    case "add":
      effective = (input.current ?? "") + "\n\n---\n\n" + newPart;
      break;
  }
  return { effective, prev: input.current, bytes: Buffer.byteLength(effective, "utf-8") };
}
```

Note: `--append` and `--replace` both produce `effective = newPart` in this architecture-agnostic layer. The **base context** (pi-default or current) is added by the implementation-path-specific code (path A/B/C/D in § 7).

### 4.2 Slash command

```ts
// extensions/subagent/agents-command.ts (extension)
pi.registerCommand("agents:inject", {
  description: "Inject system prompt into a live agent: /agents:inject <name> [--replace|--append|--add] [<sources>...] [--rollback [N]] [--history]",
  getArgumentCompletions: paneAgentNameCompletions,
  handler: async (args, ctx) => agentsHandler(`inject ${args}`.trim(), ctx),
});
```

`agentsHandler` adds an `inject` branch:

```ts
} else if (command === "inject") {
  const parsed = parseInjectArgs(parts.slice(1));
  const target = findAgent(parsed.name) ?? synthesizeAdhocAgent(...);
  const result = await injectSystemPrompt(target, parsed, ctx);
  console.warn(`[pi-subagent-fragments] inject: ${parsed.name} mode=${parsed.mode} bytes=${result.bytes} history=${result.historyLength}`);
  content = `Injected into ${parsed.name}. mode=${parsed.mode} bytes=${result.bytes}`;
}
```

### 4.3 History module

```ts
// extensions/subagent/prompt-history.ts (new file)
const MAX_HISTORY = 10;

export interface PromptVersion {
  timestamp: string;
  mode: "replace" | "append" | "add" | "rollback";
  prev: string;
  new: string;
  source: string; // intercom message id or null for ad-hoc
}

export class PromptHistory {
  constructor(private readonly file: string) {}
  push(v: PromptVersion): void {
    const arr = this.read();
    arr.push(v);
    while (arr.length > MAX_HISTORY) arr.shift();
    writeFileSync(this.file, JSON.stringify(arr, null, 2));
  }
  get(n: number): PromptVersion | undefined { return this.read()[n - 1]; }
  list(): PromptVersion[] { return this.read(); }
  private read(): PromptVersion[] {
    try { return JSON.parse(readFileSync(this.file, "utf-8")); }
    catch { return []; }
  }
}
```

### 4.4 Implementation: path E — `before_agent_start` hook + persistent state

Path E is the chosen implementation (resolves § 7 Open Question 1). No upstream changes needed.

**State file layout**:

```
~/.cache/pi-subagent-fragments/inject/<agent-name>.json
{
  "systemPrompt": "<composed from sources>",
  "mode": "replace" | "append" | "add",
  "queuedAt": "ISO-8601",
  "queuedBy": "intercom message id or null"
}
```

**Write side (`/agents:inject` handler)**:

```ts
} else if (command === "inject") {
  const parsed = parseInjectArgs(parts.slice(1));
  const target = findAgent(parsed.name);
  if (!target) throw new Error(`Unknown agent: ${parsed.name}`);
  if (!target.pane) {
    // bg one-shot — session already exited; nothing to inject into
    throw new Error("inject: target is not a live persistent agent");
  }
  const composed = composeInjection({
    name: parsed.name,
    mode: parsed.mode,
    sources: parsed.sources,
    cwd: parsed.cwd ?? ctx.cwd,
    current: target.currentSystemPrompt, // read from ctx
  });
  const stateFile = injectStatePathFor(parsed.name);
  await fs.promises.mkdir(dirname(stateFile), { recursive: true });
  await fs.promises.writeFile(stateFile, JSON.stringify({
    systemPrompt: composed.effective,
    mode: parsed.mode,
    queuedAt: new Date().toISOString(),
    queuedBy: null,
  }, null, 2));
  console.warn(`[pi-subagent-fragments] inject: ${parsed.name} mode=${parsed.mode} bytes=${composed.bytes} history=${await getHistoryLength(parsed.name)}`);
}
```

> **round 1 review OQ4/OQ5 (2026-08-12)**: non-pane targets (bg one-shot or
> ad-hoc without a live pane) fail with the "not a live persistent agent"
> error — there is no session to inject into. `--cwd` in inject sets the
> **source-resolution root only** (`tryResolveAsFile` base, same helper as
> spec 002); it does **not** relocate the running agent (pi has no mid-session
> chdir). `--history` and `--rollback` do not need a live pane (they read/write
> the history file only), but do need the agent to have existed.

**Read side (hook handler)** — see § 3.3 above.

**Concurrency**: state file is consumed one-shot (`unlinkSync`). If two `/agents:inject` calls race before the next turn, the second write wins (FIFO without queue — acceptable since each call overrides).

**History push**: hook side; uses `event.systemPrompt` (the **previous** effective prompt) and the new `state.systemPrompt`.

**Limitations**:
- Mid-turn tear-up is not supported; new prompt takes effect at next turn boundary (matches `steer_subagent`).
- One-shot consumption: if the agent is paused (idle, not generating), the state file is consumed on the next turn; if the agent then idles again without another turn, the state file is gone. Acceptable since the next user input always triggers a turn.
- Bg one-shot agents cannot be injected into (already exited by the time the command runs); fail with clear error.

---

## 5. Acceptance Criteria

- [ ] `/agents:inject <name> --replace <source>` succeeds; new effective prompt = source only; `console.warn` emitted.
- [ ] `/agents:inject <name> --append <source>` succeeds; new effective prompt = pi-default + source (per implementation path); `console.warn` emitted.
- [ ] `/agents:inject <name> --add <source>` succeeds; new effective prompt = current + source; `console.warn` emitted.
- [ ] `/agents:inject <name> --history` lists up to 10 prior versions with timestamp + mode + bytes.
- [ ] `/agents:inject <name> --rollback` reverts to immediately previous version.
- [ ] `/agents:inject <name> --rollback 3` reverts to 3 versions back.
- [ ] `/agents:inject <name> --rollback` on empty history → error.
- [ ] History queue overflow evicts oldest (cap 10).
- [ ] Mid-task mutation: agent's current turn completes with old prompt; next turn uses new.
- [ ] Multiple `--replace / --append / --add` flags → error (mutually exclusive).
- [ ] `--history` and `--rollback` are mutually exclusive with `--replace / --append / --add`.
- [ ] R2 grammar sources (`#<file>` / `#"<text>"`) work in inject command.
- [ ] Passthrough flags (`--temperature`, etc.) reach pi argv.
- [ ] Mutating an unknown / dead agent → error.
- [ ] `bun test ./tests ./extensions/subagent/__tests__` passes; no spec 001 / spec 002 regression.
- [ ] Tool surface: `subagent({ inject: { name, mode, sources, ... } })` works.

---

## 6. Implementation Steps (PRs)

Path E is the chosen implementation (§ 4.4); PRs are defined below.

| PR | Scope | Test file |
|---|---|---|
| PR 10 | `composeInjection` + history module (`extensions/subagent/prompt-history.ts`) + slash parser (`parseInjectArgs`) + `/agents:inject` handler wiring | `tests/prompt-inject-compose.test.ts` |
| PR 11 | `before_agent_start` hook handler + state file read/consume + integration with `runSingleDispatch` for ad-hoc injection path | `tests/prompt-inject-dispatch.test.ts` |
| PR 12 | `subagent` tool surface (`inject` param) + subagent-side integration tests (verify state file written + read on next turn) | `tests/prompt-inject-tool.test.ts` |
| PR 13 | docs (README + CHANGELOG) | n/a |

---

## 7. Open Questions

1. **Implementation path** — RESOLVED on 2026-08-12 by user pick of **path E** (`before_agent_start` hook + persistent state). Implementation per § 3.3 and § 4.4.

2. **History persistence location** — RESOLVED on 2026-08-12 (round 1 review): session runtime dir `runtimeDirForContext(ctx)/prompt-history/<agent>.json` (see § 3.4). Session-scoped, beside the pane registry; not `~/.cache`.

3. **`<pi-default>` content visibility** — RESOLVED on 2026-08-12 (round 1 review): pi-default is opaque and never read; `--append` composes from the agent's **current effective prompt** (which already includes pi-default). `--append` and `--add` are **aliases in v1** (see § 3.2 v1 note).

4. **`/agents:inject` on ad-hoc agents** — RESOLVED on 2026-08-12 (round 1 review): fail with `inject: target is not a live persistent agent` — no persistent session to inject into. `--history`/`--rollback` need only the history file, not a live pane (see § 4.4 write-side note).

5. **`--cwd` semantics in inject** — RESOLVED on 2026-08-12 (round 1 review): source-resolution root only; does not relocate the running agent (see § 4.4 write-side note).

---

## 8. Spec After-Completion Archive Path

Once v1 merges to main:

- Move `specs/003-prompt-inject.md` → `specs/archive/003-prompt-inject.v1.md` (status `Implemented`).
- Update `specs/README.md` index entry.
- Begin v0.3.1 follow-up spec for cross-pane broadcast + per-segment mutation + auto-rollback.

---

## 9. Reserved

Intentionally empty. Reserved for v2 follow-ups to maintain stable chapter numbering.

---

## 10. Deferred Features (v0.3.x+)

- **Cross-pane broadcast** — `/agents:inject <pattern>` matching multiple agents. v0.3.1 candidate.
- **Per-segment mutation** — different prompts for different conversation segments (e.g., turn 1-5 use base; turn 6+ use appended). v0.3.x.
- **Auto-rollback on completion / timeout** — revert to base prompt when task ends or stalls. v0.3.x.
- **Real-time prompt inspector UI** — show current effective prompt in `/agents` popup Monitor tab. v0.3.x.

---

## 11. Revision History

| Version | Date | Author | Changes |
|---|---|---|---|
| v1.0 | 2026-08-12 | sub-meta | Initial draft, derived from user Q1/Q2/Q3 answers on spec 003 design space. Targets `@nexquark/pi-subagent-fragments` 0.3.0. |
| v1.1 | 2026-08-12 | sub-meta | **Q2 resolved**: implementation path = (E) `before_agent_start` hook + persistent state. § 1 Background gains "Key discovery" paragraph noting per-turn hook semantics. § 2.1 replaced with hook viability analysis from `extensions/index.d.ts` (`BeforeAgentStartEvent` / `BeforeAgentStartEventResult` types; `getSystemPrompt()` reader). § 3.3 hot-swap semantics redrawn with hook + state-file mechanism. § 4.4 implementation redrawn as concrete path E with write side (`/agents:inject` handler) and read side (hook handler). § 7 Open Question 1 marked RESOLVED with link to § 4.4. § 6 PRs now defined (PR 10–13). No upstream changes required.
| v1.2 | 2026-08-12 | sub-meta | **Round 1 review** (`specs/_reviews/003-1.md`): OQ 2–5 resolved — OQ2 session-runtime-dir history; OQ3 `--append` composes from current effective prompt (`--append`/`--add` aliases in v1); OQ4 non-pane targets error; OQ5 `--cwd` resolution-root only. Amendments A1–A3 (mandatory: `ctx.sessionManager.getSessionName()` keying, alias semantics, shared `injectStatePathFor`) + A4–A6 (minor) applied to § 3.2/§ 3.3/§ 3.4/§ 4.4/§ 7/§ 12. Status → Approved. PR 10–13 scope unchanged.

---

## 12. Known Limitations (v1)

- 12.1 — RESOLVED (2026-08-12, round 1 review): implementation path E; PRs / acceptance criteria finalized.
- 12.2 — RESOLVED (2026-08-12, round 1 review OQ3): `--append` composes from current effective prompt; `--append`/`--add` aliases in v1 (see § 3.2 note).
- 12.3 — RESOLVED (2026-08-12, round 1 review OQ5): `--cwd` = source-resolution root only.
- 12.4 — In-flight task mid-turn tear-up is not supported; new prompt takes effect at next turn boundary (matches `steer_subagent` semantics).
- 12.5 — Cross-pane broadcast deferred to § 10.
- 12.6 — Rollback depth limited to 10 versions by history cap.
- 12.7 — Per-agent history not shared across agent renames or copies.
- 12.8 — Round 1 review amendments A1–A3 (mandatory): `ctx.sessionManager.getSessionName()` hook keying; `--append`/`--add` alias semantics; shared `injectStatePathFor` write/read helper. A4–A6 (minor): chained-hook ordering best-effort note; state-consumed re-inject test; `--history` includes `prev` bytes. See `specs/_reviews/003-1.md`.