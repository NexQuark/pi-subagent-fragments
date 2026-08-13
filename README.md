# pi-subagent-fragments

Pi extension that adds **fragments-based systemPrompt composition** to forked
`pi-agents-tmux` agents. Drop-in replacement: same pane lifecycle, same
`/agents:*` commands — but the agent's `systemPrompt` is now assembled from
multiple frontmatter-declared fragments at spawn time.

## About this fork

This is a fork of
[vanillagreencom/vstack](https://github.com/vanillagreencom/vstack),
specifically the [`pi-extensions/pi-agents-tmux/`](https://github.com/vanillagreencom/vstack/tree/main/pi-extensions/pi-agents-tmux)
extension. The upstream source commit is
[`faeb65af`](https://github.com/vanillagreencom/vstack/commit/faeb65af9319fddf4cb7528c224e259df6f40a24)
(version `2.8.1`).

See [`UPSTREAM.md`](./UPSTREAM.md) for sync history, cherry-pick policy, and
critical-fix fast-track rules.

## What this fork adds

A `systemPromptFragments?: string[]` frontmatter field on agent definitions,
plus a `composeAgentPrompt()` helper that joins the body and fragments into
the temp file passed to `--append-system-prompt` at spawn time.

- **Static composition only in v1** — fragments are joined once at agent
  spawn and remain immutable for the session lifetime.
- **Runtime switching deferred to v2** — see
  [specs/001-multi-prompt-injection.md § Deferred](./specs/001-multi-prompt-injection.md#11-deferred-features-v2).

For the full design, API surface, lifecycle, configuration, errors,
testing, and migration path, see
[`specs/001-multi-prompt-injection.md`](./specs/001-multi-prompt-injection.md).

## Ad-hoc pane agent launch (`/agents:new` / `/agents:start`)

You can launch a **one-off agent** — no `.md` file required — straight from
`/agents:new <name>` or `/agents:start <name>`. When `<name>` is not in the
agent inventory, the command synthesizes an in-memory agent on the spot and
dispatches it to a fresh persistent pane (or a background one-shot).

### Command grammar (spec 002 §3.6)

```text
/agents:new  <name> [<system-source>...] [<user-source>...] [--flag...] [-- <passthrough>]
/agents:start <name> [<system-source>...] [<user-source>...] [--flag...] [-- <passthrough>]
```

A source is one of:

| Source            | Meaning                                                            |
| ----------------- | ------------------------------------------------------------------ |
| `#<path>`         | Must-exist system-prompt **file** (errors if missing)              |
| `#"..."`         | System-prompt: a **file** if it exists, otherwise inline text      |
| `@<path>`         | User prompt: a **file** if it exists, otherwise inline string      |
| `"..."`          | Inline user prompt (the task)                                      |

`#<path>` and `#"..."` sources contribute to the agent's `systemPrompt`;
`@<path>` (file-or-inline) and quoted `"..."` sources become the user
prompt dispatched to the agent. File sources are read at launch; inline
values are joined with `---` separators.

### Flags

| Flag                     | Effect                                                        |
| ------------------------ | ------------------------------------------------------------- |
| `--replace`              | Overwrite an existing agent definition of the same name       |
| `--model <id>`           | Force the model for this agent (overrides the default)        |
| `--cwd <path>`           | Run the agent in this working directory                       |
| `--pane-direction <h|v>` | Split the pane horizontally (`h`) or vertically (`v`) (C4b)   |
| `--pane-size <N[%|l]>`   | Pane size as a percent (`N%`) or absolute lines (`Nl`) (C4b)  |
| `--pane-target <target>` | Primary pane, next pane, or a specific pane id (C4b)          |
| `--no-pane`              | Force background (one-shot) dispatch, never a pane            |
| `--new-pane`             | Stop any existing pane for this agent and start a fresh one   |

Any unknown `--flag` after the recognized set is passed through verbatim to
the spawned agent as a launcher argument — use `--` before raw/passthrough
tokens you don't want interpreted:

```text
/agents:new dba --model gpt-4o "audit the schema" -- --verbose --output ./report
```

> **Everything except `<name>` is optional.** `/agents:new <name>` (and
> `/agents:start <name>`) with no sources and no flags is valid: the agent
> starts with an empty task and decides its own next action (it may ask
> what to do). The minimal invocation is just the name:
>
> ```text
> /agents:new explorer
> ```

### Full worked example

One command exercising every source type and most flags (all four source
kinds contribute in one invocation):

```text
/agents:new dba \
  #./role/base-dba.md \                            # system file (must exist)
  #"./style.md" "be terse" \                       # system: file-or-inline
  @./tasks/billing-audit.md \                      # user: file-or-inline
  "audit the schema for the billing service" \     # user inline (the task)
  --model gpt-4o \
  --cwd /srv/billing \
  --pane-direction v --pane-size 60% \
  --no-pane \
  -- --verbose --output ./report                   # passthrough after `--`
```

Sources: `#<path>` and `#"..."` contribute to the agent's `systemPrompt`;
`@<path>` and `"..."` become the dispatched user prompt (the task). File
sources are read at launch; inline values are joined with `---` separators.
The minimal form is just a name plus a quoted task:

```text
/agents:new reviewer "review the auth flow in src/auth.ts"
```

### `/agents:new` vs `/agents:start`

- `/agents:new` always starts a fresh pane (equivalent to `--new-pane`).
- `/agents:start` resumes an existing pane for the agent if one is live;
  pass `--new-pane` to force a stop-and-recreate.
- `--new-pane` is **silently ignored** on `/agents:new` (it is already the
default behavior) — it only matters for `/agents:start`.

### Background fallback (C1)

If `$TMUX` is not set (not running inside tmux), the ad-hoc agent is
dispatched as a background one-shot instead — with a `tmux not available`
warning. `--no-pane` also forces the background path. For full pane
geometry and the launcher invocation contract, see
[`specs/archive/002-adhoc-pane-agent.v1.md`](./specs/archive/002-adhoc-pane-agent.v1.md).

## Runtime prompt injection (`/agents:inject`)

You can **mutate a running agent's system prompt** without restarting it.
`/agents:inject` writes a pending injection into the target agent's session
runtime dir; the extension's `before_agent_start` hook applies it at the
agent's next turn and records the applied version in a per-agent history.

### Command grammar (spec 003 §3.1)

```text
/agents:inject <name> [--replace | --append | --add] [<system-source>...]
               [--rollback [N]] [--history] [--cwd <path>] [-- <passthrough>]
```

- `--replace` installs exactly the given sources as the new prompt.
- `--append` / `--add` **compose against the agent's real current prompt**
  at apply time (`current + separator + new`). They are aliases in v1.
- `--rollback [N]` reverts to the version N prompts ago (`--rollback 1` =
  immediately previous). `N` must be `>= 1`.
- `--history` prints a markdown table of applied versions (`# | mode |
  bytes | timestamp`).
- `--cwd <path>` is the **source-resolution root only** — it does not
  relocate the running agent.

System sources use the same R2 grammar as `/agents:new`: `#<path>`
(must-exist file), `#"..."` (file-or-inline), or a bare inline string.

```text
/agents:inject dba --append "#<docs/audit-policy.md>"
/agents:inject dba --replace "You are the audit DBA now."
/agents:inject dba --history
/agents:inject dba --rollback 2
```

**Liveness requirement (mutation only)**: `--replace`/`--append`/`--add`
require the target to have a **live pane session** — there is no session to
inject into otherwise. `--history` and `--rollback` only touch the history
file and work without a live pane.

### The `subagent` tool `inject` param

The `subagent` tool also accepts an `inject` object — a **standalone
action** (no `agent`/`task` dispatch needed) that writes the same pending
injection:

```jsonc
{
  "inject": {
    "name": "dba",
    "mode": "append", // or replace / add / rollback / history
    "sources": [{ "kind": "string", "value": "Audit all DDL." }],
    "rollback": 1,     // with mode rollback
    "cwd": "/path"    // source-resolution root only
  }
}
```

**Unlike the slash handler, the tool-side mutation does NOT require a live
pane** — it writes the state and the hook applies it whenever the target
agent's session next turns (the target may not be running yet).

### Apply semantics

- One-shot: the state file is consumed (unlinked) on first apply — a second
turn does not re-inject.
- The applied version is pushed to history **on apply**, keyed by the
agent's real session name (`ctx.sessionManager.getSessionName()`), with
`prev` = the real current prompt from the hook event.
- History is capped at 10 versions (FIFO) and lives in the session runtime
dir (`~/.pi/agent/vstack/sessions/<sessionId>/pi-subagent-fragments/`).

For the full design, see
[`specs/003-prompt-inject.md`](./specs/003-prompt-inject.md).

## Install

```bash
npm install -g @nexquark/pi-subagent-fragments
pi install npm:@nexquark/pi-subagent-fragments
```

The `npm install -g` step downloads and unpacks the package under
`npm root -g`; the `pi install` step registers it with Pi's
`~/.pi/agent/settings.json` (or `~/.pi/settings.json` for project-local).
Restart Pi to load the extension. After registration, `/agents`,
`subagent`, `delegate_subagent`, `get_subagent_result`,
`wait_for_subagent_idle`, `steer_subagent`, and `stop_subagent` are
available alongside the existing `pi-agents-tmux` tool surface.

To uninstall:

```bash
pi remove npm:@nexquark/pi-subagent-fragments
npm uninstall -g @nexquark/pi-subagent-fragments
```

For local development from this repo (no `npm publish` round-trip
required), use `pi install --path .` from the repo root.

### Local tarball install (per-minor-version house rule)

This package is **not published to the npm registry**; every completed
minor version is installed on this machine directly from a locally
packed tarball. This is the routine way the running Pi picks up a new
minor version (`npm publish` is never used).

```bash
cd /home/openatom/codes/repos/pi-subagent-fragments
npm pack                      # → nexquark-pi-subagent-fragments-<ver>.tgz
npm install -g --allow-scripts=@nexquark/pi-subagent-fragments ./nexquark-pi-subagent-fragments-<ver>.tgz
```

The `--allow-scripts` flag is required on npm ≥ 10.4 (install-scripts
gate); it lets the package's `postinstall` (`append-system.mjs install`)
refresh `~/.pi/agent/APPEND_SYSTEM.md`. If it was skipped, run it once
manually from the global package dir:

```bash
cd "$(npm root -g)/@nexquark/pi-subagent-fragments" && node scripts/append-system.mjs install
```

`settings.json` keeps the `npm:@nexquark/pi-subagent-fragments` entry
unchanged — the `npm:` prefix resolves to the freshly installed global
package. **Restart Pi** for the new version to load.

## Known limitations (v1)

Inherited from upstream `pi-agents-tmux`'s `loadAgentsFromDir`, which reads
`.md` files at the **top level** of the agent scope only — it does not
recurse into subdirectories. Practically:

- Place the agent `.md` file at the top level of the agent scope
  (`~/.pi/agent/agents/agent-alpha.md` for user scope,
  `<project>/.pi/agents/agent-alpha.md` for project scope).
- Place fragment files in the **same directory** as the agent file, and
  reference them with paths relative to it:

  ```markdown
  ---
  name: agent-alpha
  systemPromptFragments: ["./fragment-alpha-role.md"]
  ---

  You are agent-alpha.
  ```

- `mode: "append"` and `mode: "replace"` produce identical output in v1.
  The `mode` field is captured for v2 runtime-switching semantics; the v2
  spec will differentiate.

See
[specs/001-multi-prompt-injection.md § 13](./specs/001-multi-prompt-injection.md#13-known-limitations-v1)
for the full list (path sandbox, async I/O, raw-join, etc.).

## License

MIT — same as upstream. See [`LICENSE`](./LICENSE) for the fork attribution
notice.
