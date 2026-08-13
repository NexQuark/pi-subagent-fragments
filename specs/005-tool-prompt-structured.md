# Spec 005: Structured Tool Prompting — retire APPEND_SYSTEM.md

| Field | Value |
|---|---|
| **Status** | Approved — R1/R2/R3 Implemented (TDD via sub-tmux), R4 (docs) pending |
| **Target version** | `0.4.0` |
| **Scope** | This fork only (`@nexquark/pi-subagent-fragments`) |
| **Upstream base** | `vanillagreencom/vstack` (unchanged since spec 004) |
| **PRs** | pending (TDD via sub-tmux) |

---

## 1. Background and Goal

The fork currently ships its tool-usage rules (subagent / delegate_subagent
calling rules) through the **APPEND_SYSTEM.md** mechanism: `postinstall`
(`scripts/append-system.mjs`) upserts `instructions.md` into
`~/.pi/agent/APPEND_SYSTEM.md`, which Pi appends to **every main-agent**
system prompt.

Structural problems with that approach (analyzed 2026-08-13):

1. **Main/child asymmetry** — pane child agents have their
   `--append-system-prompt` overridden by the launcher's composed prompt
   file, so the rules text is invisible to the very agents that also
   register these tools.
2. **Global token cost** — every main session carries the text whether or
   not the tools are used.
3. **Text over structure** — free-form prose, no per-tool attachment, no
   schema.
4. **Install-time injection** — writing global state at `postinstall`
   rather than declaring capability at load time.

Pi provides a native structured mechanism the fork does not use:
`ToolDefinition.promptSnippet` (one-line Available-tools snippet) and
`ToolDefinition.promptGuidelines` (guideline bullets appended to the
default system prompt when the tool is active) — collected per tool by
agent-session (dist/core/agent-session.js:1970-1983) and applied only
while the tool is active.

**User decision**: retire the APPEND_SYSTEM.md channel entirely; move
tool rules into `promptSnippet`/`promptGuidelines`; keep the full
`instructions.md` text as an **optional skill** that is shipped with the
package but **never installed automatically**; document install/use of
the skill in README.

## 2. Requirements

### R1 — Tool rules → `promptSnippet` / `promptGuidelines`

For every tool registered in `extensions/subagent/tools.ts`
(`subagent`, `delegate_subagent`, `steer_subagent`,
`get_subagent_result`, `wait_for_subagent_idle`, `stop_subagent`,
`complete_subagent`):

- `promptSnippet`: one-line description for the Available tools section.
- `promptGuidelines`: **curated** core rules (not the full 30-line text) —
  the calling rules that must be in-prompt for correct tool use (e.g.
  "end your turn after dispatching a persistent-pane task", "one
  self-contained task string per delegation", "do not use for work you
  can do directly", result-retrieval semantics). Long-tail detail moves
  to the skill (R3).

Keep total guideline bulk comparable to or smaller than today's injected
text.

### R2 — Retire the APPEND_SYSTEM.md channel

- Remove `"pi": { "appendSystem": "./instructions.md" }` from
  `package.json`; drop `scripts/append-system.mjs` from the shipped
  package (and its `postinstall`/`preuninstall` script entries).
- Existing installs: the `vstack:append-system @nexquark/pi-subagent-fragments`
  block must be **removed from `~/.pi/agent/APPEND_SYSTEM.md`** (one-time
  cleanup — the block is delimited by begin/end comments, so removal is
  mechanical; include a cleanup helper or document the manual edit).
- No new installs write APPEND_SYSTEM.md.

### R3 — Optional skill (shipped, never auto-installed)

- Ship the full instructions as a skill under the package, e.g.
  `skills/subagent-usage/SKILL.md` (content = curated expansion of the
  current `instructions.md`).
- **Not installed** by `postinstall`; not registered by the extension at
  load time. The extension must not load it implicitly.
- README documents how to install/use it (copy into the user skills dir
  per Pi's skills mechanism — e.g. `~/.pi/agent/skills/…` — or the
  project skills dir; exact path follows Pi's current skills layout).

### R4 — README + docs

- README: replace any APPEND_SYSTEM.md references with (a) the structured
  tool prompting note and (b) the optional skill install/use instructions.
- DEVELOPMENT.md/AGENTS.md: update the "rules live in instructions.md"
  references, if any, to point at tools.ts promptGuidelines + the skill.

## 3. Acceptance criteria

- [x] R1: each registered tool carries promptSnippet + curated
      promptGuidelines; guidelines appear in the assembled system prompt
      when the tool is active (unit test on buildSystemPrompt-equivalent
      composition, or the extension's own prompt assembly test).
- [x] R2: package.json has no `pi.appendSystem`; postinstall/preuninstall
      no longer reference append-system; the local
      `~/.pi/agent/APPEND_SYSTEM.md` block is removed; fresh-install
      verification shows no write.
- [x] R3: skill ships in the package tarball, is NOT auto-installed, and
      README documents install/use.
- [ ] R4: README/DEVELOPMENT updated; suite green.

## 4. Implementation steps

1. sub-tmux TDD: R1 (tools.ts promptSnippet/promptGuidelines + tests),
   R2 (package.json + scripts removal + local cleanup), R3 (skill file +
   packaging), R4 (docs by sub-meta).
2. technical review (sub-meta) → reviewer verdict → squash to main.
3. Release v0.4.0 per charter §5 (bump + archive this spec + local
   tarball install + smoke).

## 5. Open findings

| ID | Origin | Description | Disposition |
|----|--------|-------------|-------------|
| F-01 | this spec | Main/child rule asymmetry (APPEND_SYSTEM.md invisible to pane children) | Fixed by R1 (per-tool guidelines apply wherever the tool registers) |
| F-02 | this spec | Global token cost of unconditional append | Fixed by R1 (guidelines only while tool active) |

## 6. Revision history

| Version | Date | Change |
|---------|------|--------|
| v1.0 | 2026-08-13 | Initial — retire APPEND_SYSTEM.md; structured tool prompting; optional skill |
