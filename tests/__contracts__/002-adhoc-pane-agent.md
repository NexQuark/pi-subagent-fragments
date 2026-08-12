# Test contract — spec 002 round 3 (ad-hoc pane agent + pane resilience + new grammar)

Mapping from spec 002 §5 acceptance criteria to test files. Each
row is one acceptance criterion. `sub-tmux` writes the failing test
first (TDD red), then makes it pass (green), then refactors.

Source spec: `specs/archive/002-adhoc-pane-agent.v1.md` (status: Implemented, v0.2.0).
Test files referenced here are planned under spec 002 §4.6.

**Round 3 additions** (vs round 2 contract):
- R2 grammar parser tests (L1-L5 → L1-L15): `#` / `#"..."` / `@` / `"..."` / `--replace` / `--model` / `--cwd` / `--pane-*` / passthrough
- R5 bug fix tests (NEW section): C1 tmux detect, C2 reuse escape, C3 typo warn, C4a size retry, C4b pane flags
- Subagent tool surface tests (NEW section): `systemPrompt`, `systemPromptFiles`, `taskFile`, `pane`, `model`, `replace`, `cwd`, `passthroughArgs`

| # | Spec §5 row | Test file | Test case | Status |
|---|---|---|---|---|
| 1 | `subagent({ agent: "foo", task: "...", systemPrompt: "..." })` succeeds when `foo` is not in any agent directory | `tests/adhoc-dispatch.test.ts` | ad-hoc-succeeds-with-systemPrompt | placeholder |
| 2 | `subagent({ agent: "foo", task: "...", systemPromptFiles: [...] })` joins files into `--append-system-prompt` body | `tests/adhoc-dispatch.test.ts` | ad-hoc-joins-systemPromptFiles | placeholder |
| 3 | `subagent({ agent: "foo", task: "..." })` with no `systemPrompt`/`systemPromptFiles` succeeds (empty pi) | `tests/adhoc-dispatch.test.ts` | ad-hoc-empty-pi-succeeds | placeholder |
| 4 | `subagent({ agent: "foo", taskFile: "./t.md" })` reads `t.md` and uses contents as task | `tests/adhoc-dispatch.test.ts` | ad-hoc-taskFile-reads-file | placeholder |
| 5 | `subagent({ agent: "foo", taskFile, task })` warns and uses `taskFile` | `tests/adhoc-dispatch.test.ts` | ad-hoc-taskFile-overrides-task-with-warn | placeholder |
| 6 | `subagent({ agent: "foo", pane: false })` for ad-hoc forces bg | `tests/adhoc-dispatch.test.ts` | ad-hoc-pane-false-routes-bg | placeholder |
| 7 | `subagent({ agent: "alpha", pane: true })` overrides discovered `pane: false` | `tests/adhoc-dispatch.test.ts` | discovered-pane-override-true | placeholder |
| 8 | `subagent({ agent: "alpha", pane: false })` overrides discovered `pane: true` | `tests/adhoc-dispatch.test.ts` | discovered-pane-override-false | placeholder |
| 9 | `subagent({ tasks: [{ agent: "foo", task: "..." }] })` with `foo` not in inventory fails with ad-hoc-in-parallel-mode error | `tests/adhoc-dispatch.test.ts` | parallel-adhoc-refused | placeholder |
| 10 | `/agents:new foo ./base.md -- "do X"` opens a pane and queues task (round 3: `/agents:new` not `/agents:adhoc`) | `tests/adhoc-slash.test.ts` | adhoc-slash-pane-default | placeholder |
| 11 | `/agents:new foo ./base.md --no-pane -- "do X"` runs as one-shot bg | `tests/adhoc-slash.test.ts` | adhoc-slash-no-pane-bg | placeholder |
| 12 | `/agents show foo` after ad-hoc spawn shows synthesized description, prompt, pane flag | `tests/adhoc-slash.test.ts` | adhoc-slash-show-surfaces-synthesized | placeholder |
| 13 | Missing `systemPromptFiles` path fails with a clear error naming agent + path | `tests/adhoc-synth.test.ts` | synth-missing-fragment-throws | placeholder |
| 14 | Invalid `name` (e.g. spaces) fails the synthesizer with a clear error | `tests/adhoc-synth.test.ts` | synth-invalid-name-throws | placeholder |
| 15 | `bun test ./tests ./extensions/subagent/__tests__` passes | (whole suite) | (suite-level) | placeholder |
| 16 | No regression in existing pane lifecycle / session persistence / task dispatch | (whole suite) | (suite-level) | placeholder |
| 17 | `subagent` with discovered-agent path (no new params) is byte-identical to v1.0 behavior | (whole suite) | (regression) | placeholder |
| 18 (round 3) | `/agents:new foo --replace` → synthesizer receives `mode: "replace"` | `tests/adhoc-dispatch.test.ts` | dispatch-replace-mode | placeholder |
| 19 (round 3) | `/agents:new foo --model MiniMax-M2.7` → AgentConfig.model set | `tests/adhoc-dispatch.test.ts` | dispatch-model-set | placeholder |
| 20 (round 3) | `/agents:new foo --cwd /tmp/work` → synthesizer uses /tmp/work as fragment resolution root + pane cwd | `tests/adhoc-dispatch.test.ts` | dispatch-cwd-propagated | placeholder |
| 21 (round 3) | `/agents:new foo --temperature 0.7` → passthroughArgs forwarded to pi argv in launcher script | `tests/adhoc-dispatch.test.ts` | dispatch-passthrough-to-launcher | placeholder |

## Synthesizer unit tests (`tests/adhoc-synth.test.ts`, per spec §4.6)

| # | Spec §4.6 case | Test name | Status |
|---|---|---|---|
| S1 | empty systemPrompt + no fragments → empty composed | synth-empty-pi | placeholder |
| S2 | inline systemPrompt + no fragments → composed === systemPrompt | synth-inline-only | placeholder |
| S3 | systemPromptFiles[0..n] resolved relative to cwd | synth-fragments-cwd-relative | placeholder |
| S4 | unreadable fragment path → error naming agent + path | synth-fragment-unreadable-throws | placeholder |
| S5 | non-regular file (e.g. directory) → error | synth-fragment-not-regular-throws | placeholder |
| S6 | `name` matching `^[A-Za-z0-9_-]+$` → accepted | synth-name-valid | placeholder |
| S7 | `name` containing spaces / shell metacharacters → rejected | synth-name-invalid-throws | placeholder |
| S8 | composed prompt goes to `systemPrompt`; original `systemPromptFiles` preserved for `/agents show` | synth-preserves-fragment-paths | placeholder |
| S9 (round 3) | `mode: "replace"` → composed === last fragment only, body discarded | synth-replace-mode | placeholder |
| S10 (round 3) | synthesizer output includes `passthroughArgs` preserved on AgentConfig | synth-passthrough-preserved | placeholder |

## Slash command tests (`tests/adhoc-slash.test.ts`, per spec §4.6 round 3)

R2 grammar — new command shape `/agents:new <name> [<system-source>...] [<user-source>...] [--flag...] [-- <passthrough-args>]`:

| # | Spec §4.6 case | Test name | Status |
|---|---|---|---|
| L1 | `parseAdhocArgs("foo")` → `{ name: "foo" }` (empty pi) | parse-args-name-only | placeholder |
| L2 | `parseAdhocArgs("foo ./base.md")` → `{ name: "foo", systemPromptSources: [{type:"file", path:"./base.md"}] }` | parse-args-system-file-unquoted | placeholder |
| L3 | `parseAdhocArgs("foo #\"./with space.md\"")` → file if exists, else inline string | parse-args-system-quoted-ambiguous | placeholder |
| L4 | `parseAdhocArgs("foo #\"a-system-prompt.md\"")` quoted → fs.statSync().isFile() check → file | parse-args-system-quoted-file-resolves | placeholder |
| L5 | `parseAdhocArgs("foo #\"a-system-prompt.md\"")` quoted not on disk → inline string | parse-args-system-quoted-fallback-inline | placeholder |
| L6 | `parseAdhocArgs("foo ./base.md #\"missing.md\"")` mixed | parse-args-mixed-system-sources | placeholder |
| L7 | `parseAdhocArgs("foo @./task.md")` → file if exists else inline string | parse-args-user-file-or-string | placeholder |
| L8 | `parseAdhocArgs("foo @./missing.md")` → fallback to literal "@./missing.md" inline | parse-args-user-fallback | placeholder |
| L9 | `parseAdhocArgs("foo @./task.md \"additional user prompt\"")` → both user sources concatenated | parse-args-user-multi-concat | placeholder |
| L10 | `parseAdhocArgs("foo --replace")` → `{ mode: "replace" }` | parse-args-replace-mode | placeholder |
| L11 | `parseAdhocArgs("foo --model MiniMax-M2.7")` → `{ model: "MiniMax-M2.7" }` | parse-args-model | placeholder |
| L12 | `parseAdhocArgs("foo --cwd /tmp/work")` → `{ cwd: "/tmp/work" }` | parse-args-cwd | placeholder |
| L13 | `parseAdhocArgs("foo --temperature 0.7")` → passthroughArgs = ["--temperature", "0.7"] | parse-args-passthrough-flag-value | placeholder |
| L14 | `parseAdhocArgs("foo --no-history")` → passthroughArgs = ["--no-history"] | parse-args-passthrough-bare-flag | placeholder |
| L15 | Missing name → empty `name` (handler surfaces usage error) | parse-args-missing-name | placeholder |

## Dispatch tests (`tests/adhoc-dispatch.test.ts`, per spec §4.6)

| # | Spec §4.6 case | Test name | Status |
|---|---|---|---|
| D1 | ad-hoc with no `systemPrompt*` and no `pane` override → empty pi + auto pane | dispatch-adhoc-defaults-pane-true | placeholder |
| D2 | discovered-agent path with no new params → byte-identical to v1.0 | dispatch-discovered-byte-identical | placeholder |
| D3 | `subagent({ agent: "foo", tasks: [...] })` where `foo` is not in inventory → refused with ad-hoc-in-parallel error | dispatch-parallel-refused | placeholder |
| D4 | `subagent({ chain: [...] })` with ad-hoc name → refused with ad-hoc-in-chain error | dispatch-chain-refused | placeholder |
| D5 | discovered-agent name + ad-hoc params → discovered wins, one-time `console.warn` | dispatch-discovered-wins-with-warn | placeholder |
| D6 | `pane` override flips dispatch to `runPersistentPaneAgent` / `runSingleAgent` correctly per agent type | dispatch-pane-override-routing | placeholder |
| D7 (round 3) | `subagent({ agent: "foo", model: "X", replace: true, cwd: "/p" })` → synthesizer receives all four params | dispatch-round3-param-passthrough | placeholder |
| D8 (round 3) | `subagent({ agent: "foo", passthroughArgs: ["--temperature", "0.7"] })` → launcher script receives passthroughArgs appended to pi argv | dispatch-round3-passthrough-launcher | placeholder |

## R5 bug fix tests (`tests/adhoc-bugfix.test.ts`, per spec round 3 §4.6)

| # | Spec §4.6 case | Test name | Status |
|---|---|---|---|
| C1 (round 3) | `subagent({ pane: true })` invoked with `$TMUX` unset → emits warning, dispatches bg | bugfix-c1-tmux-detect-fallback | placeholder |
| C1' (round 3) | `subagent({ pane: true })` with `$TMUX` unset → warning contains "tmux" + "pane disabled" | bugfix-c1-warning-content | placeholder |
| C2 (round 3) | `/agents:start alpha --new-pane` → stops existing + creates fresh (forceSpawn:true) | bugfix-c2-reuse-escape | placeholder |
| C3 (round 3) | ad-hoc synthesis with no system sources → console.warn emitted with "did you mean" hint | bugfix-c3-typo-warn | placeholder |
| C3' (round 3) | ad-hoc synthesis with `#./base.md` (non-empty sources) → no warn | bugfix-c3-no-warn-with-sources | placeholder |
| C4a (round 3) | `ensurePersistentPane` tmux split fails with "size missing" → retry without `-p`, succeeds | bugfix-c4a-size-missing-retry | placeholder |
| C4a' (round 3) | `ensurePersistentPane` retry succeeds on second attempt with default split | bugfix-c4a-retry-default-split | placeholder |
| C4b (round 3) | `/agents:start alpha --pane-direction v` → tmux split-window called with `-v` | bugfix-c4b-direction-v | placeholder |
| C4b' (round 3) | `/agents:start alpha --pane-size 30%` → tmux split-window called with `-p 30` | bugfix-c4b-size-percent | placeholder |
| C4b'' (round 3) | `/agents:start alpha --pane-size 25l` → tmux split-window called with `-l 25` | bugfix-c4b-size-lines | placeholder |
| C4b''' (round 3) | `/agents:start alpha --pane-target <id>` → tmux split-window called with `-t <id>` | bugfix-c4b-target | placeholder |
| C4b'''' (round 3) | `/agents:start alpha` (no pane flags) → defaults: `-h -p 50 -t primary` | bugfix-c4b-defaults | placeholder |