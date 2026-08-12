/**
 * spec 002 §3.6 / §5.2 / §5.5 L1-L15 + C2 — see tests/__contracts__/002-adhoc-pane-agent.md.
 *
 * PR 8 cycle 1: R2 grammar parser + /agents:new + /agents:start handler.
 *
 * R2 grammar (locked per sub-meta ack):
 *   /agents:new <name> [<system-source>...] [<user-source>...] [--flag...] [-- <passthrough-args>]
 *   system-source ::= #<unquoted-path>      (must exist; throw if not)
 *                  | #"<quoted>"             (file-or-inline: fs.statSync().isFile())
 *   user-source   ::= @<path-or-text>        (file-or-inline)
 *                  | "<text>"                (inline)
 *
 *   flags (recognized): --replace, --model <n>, --cwd <p>, --pane-direction <h|v>,
 *                       --pane-size <N[% | l]>, --pane-target <primary|next|<id>>,
 *                       --no-pane, --new-pane (start/resume only)
 *   flags (passthrough): any other --xxx [value] → passthroughArgs[]
 *   after `--`: all subsequent tokens → passthroughArgs verbatim
 *
 * Tests:
 *   L1-L15: parseAdhocArgs shape + classification (per contracts)
 *   C2 (real): --new-pane flag parsed on /agents:start maps to forceSpawn: true
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { parseAdhocArgs, resolveForceNewPane } from "../extensions/subagent/agents-command.js";
import { synthesizeAdhocAgent } from "../extensions/subagent/agents.js";
import { shouldAdhocFallbackToBg } from "../extensions/subagent/agents.js";
import { writeLauncher } from "../extensions/subagent/pane.js";

const rootTmp = join(import.meta.dir, "..", "..", "..", "tmp", "adhoc-slash-tests");

function resetTmp(): void {
	rmSync(rootTmp, { force: true, recursive: true });
	mkdirSync(rootTmp, { recursive: true });
}

beforeEach(() => {
	resetTmp();
});

afterEach(() => {
	rmSync(rootTmp, { force: true, recursive: true });
});

// L1 — parseAdhocArgs("foo") → { name: "foo" } (empty pi)
test("parse-args-name-only", () => {
	const parsed = parseAdhocArgs("foo", rootTmp);
	expect(parsed.name).toBe("foo");
	expect(parsed.systemPromptSources).toEqual([]);
	expect(parsed.userSources).toEqual([]);
	expect(parsed.passthroughArgs).toEqual([]);
});

// L2 — parseAdhocArgs("foo #./base.md") → { name, systemPromptSources: [{type:"file", path:"./base.md"}] }
test("parse-args-system-file-unquoted", () => {
	mkdirSync(join(rootTmp, "frags"), { recursive: true });
	writeFileSync(join(rootTmp, "frags", "base.md"), "BASE", "utf8");
	const parsed = parseAdhocArgs("foo #./frags/base.md", rootTmp);
	expect(parsed.name).toBe("foo");
	expect(parsed.systemPromptSources.length).toBe(1);
	const src = parsed.systemPromptSources[0]!;
	expect(src.type).toBe("file");
	expect(src.path).toBe("./frags/base.md");
});

// L3 — parseAdhocArgs("foo #\"./with space.md\"") → file if exists, else inline string
test("parse-args-system-quoted-ambiguous", () => {
	const quoted = `foo #"./with space.md"`;
	const parsed = parseAdhocArgs(quoted, rootTmp);
	expect(parsed.name).toBe("foo");
	expect(parsed.systemPromptSources.length).toBe(1);
	const src = parsed.systemPromptSources[0]!;
	// file doesn't exist (./with space.md not on disk) → type=inline
	expect(src.type).toBe("inline");
});

// L4 — parseAdhocArgs("foo #\"a-system-prompt.md\"") quoted → fs.statSync().isFile() check → file
test("parse-args-system-quoted-file-resolves", () => {
	writeFileSync(join(rootTmp, "a-system-prompt.md"), "SYSTEM", "utf8");
	const parsed = parseAdhocArgs(`foo #"a-system-prompt.md"`, rootTmp);
	expect(parsed.systemPromptSources.length).toBe(1);
	const src = parsed.systemPromptSources[0]!;
	expect(src.type).toBe("file");
	expect(src.path).toBe("a-system-prompt.md");
});

// L5 — parseAdhocArgs("foo #\"a-system-prompt.md\"") quoted not on disk → inline string
test("parse-args-system-quoted-fallback-inline", () => {
	// a-system-prompt.md does NOT exist on disk
	const parsed = parseAdhocArgs(`foo #"a-system-prompt.md"`, rootTmp);
	expect(parsed.systemPromptSources.length).toBe(1);
	const src = parsed.systemPromptSources[0]!;
	expect(src.type).toBe("inline");
	expect((src as { value: string }).value).toBe("a-system-prompt.md");
});

// L6 — parseAdhocArgs("foo #./base.md #\"missing.md\"") mixed
test("parse-args-mixed-system-sources", () => {
	mkdirSync(join(rootTmp, "frags"), { recursive: true });
	writeFileSync(join(rootTmp, "frags", "base.md"), "BASE", "utf8");
	const parsed = parseAdhocArgs(`foo #./frags/base.md #"missing.md"`, rootTmp);
	expect(parsed.systemPromptSources.length).toBe(2);
	// First: unquoted #path → file
	expect(parsed.systemPromptSources[0]!.type).toBe("file");
	expect(parsed.systemPromptSources[0]!.path).toBe("./frags/base.md");
	// Second: quoted #"..." not on disk → inline
	expect(parsed.systemPromptSources[1]!.type).toBe("inline");
});

// L7 — parseAdhocArgs("foo @./task.md") → file if exists else inline string
test("parse-args-user-file-or-string", () => {
	writeFileSync(join(rootTmp, "task.md"), "TASK", "utf8");
	const parsed = parseAdhocArgs("foo @./task.md", rootTmp);
	expect(parsed.userSources.length).toBe(1);
	const src = parsed.userSources[0]!;
	expect(src.type).toBe("file");
	expect(src.path).toBe("./task.md");
});

// L8 — parseAdhocArgs("foo @./missing.md") → fallback to literal "@./missing.md" inline
test("parse-args-user-fallback", () => {
	const parsed = parseAdhocArgs("foo @./missing.md", rootTmp);
	expect(parsed.userSources.length).toBe(1);
	const src = parsed.userSources[0]!;
	expect(src.type).toBe("inline");
	expect((src as { value: string }).value).toBe("@./missing.md");
});

// L9 — parseAdhocArgs("foo @./task.md \"additional user prompt\"") → both user sources concatenated
test("parse-args-user-multi-concat", () => {
	writeFileSync(join(rootTmp, "task.md"), "TASK-FILE", "utf8");
	const parsed = parseAdhocArgs(`foo @./task.md "additional user prompt"`, rootTmp);
	expect(parsed.userSources.length).toBe(2);
	expect(parsed.userSources[0]!.type).toBe("file");
	expect(parsed.userSources[1]!.type).toBe("inline");
});

// L10 — parseAdhocArgs("foo --replace") → { mode: "replace" }
test("parse-args-replace-mode", () => {
	const parsed = parseAdhocArgs("foo --replace", rootTmp);
	expect(parsed.mode).toBe("replace");
});

// L11 — parseAdhocArgs("foo --model MiniMax-M2.7") → { model: "MiniMax-M2.7" }
test("parse-args-model", () => {
	const parsed = parseAdhocArgs("foo --model MiniMax-M2.7", rootTmp);
	expect(parsed.model).toBe("MiniMax-M2.7");
});

// L12 — parseAdhocArgs("foo --cwd /tmp/work") → { cwd: "/tmp/work" }
test("parse-args-cwd", () => {
	const parsed = parseAdhocArgs("foo --cwd /tmp/work", rootTmp);
	expect(parsed.cwd).toBe("/tmp/work");
});

// L13 — parseAdhocArgs("foo --temperature 0.7") → passthroughArgs = ["--temperature", "0.7"]
test("parse-args-passthrough-flag-value", () => {
	const parsed = parseAdhocArgs("foo --temperature 0.7", rootTmp);
	expect(parsed.passthroughArgs).toEqual(["--temperature", "0.7"]);
});

// L14 — parseAdhocArgs("foo --no-history") → passthroughArgs = ["--no-history"]
test("parse-args-passthrough-bare-flag", () => {
	const parsed = parseAdhocArgs("foo --no-history", rootTmp);
	expect(parsed.passthroughArgs).toEqual(["--no-history"]);
});

// L15 — Missing name → empty name (handler surfaces usage error)
test("parse-args-missing-name", () => {
	const parsed = parseAdhocArgs("", rootTmp);
	expect(parsed.name).toBe("");
});

// C2 — /agents:start alpha --new-pane → stops existing + creates fresh (forceSpawn: true)
// PR 8 cycle 1: C2 transitions from test.todo (PR 7) to real test.
// --new-pane on /agents:start sets forceSpawn: true; the slash handler
// invokes stopPersistentPane + re-dispatches with the fresh session.
test("bugfix-c2-reuse-escape", () => {
	// Parser-level assertion: --new-pane is recognized as the start-flag
	// (not passthrough) and the parsed object carries newPane: true.
	const parsed = parseAdhocArgs("alpha --new-pane", rootTmp);
	expect(parsed.name).toBe("alpha");
	expect(parsed.newPane).toBe(true);
	// Without --new-pane, the flag is false.
	const noFlag = parseAdhocArgs("alpha", rootTmp);
	expect(noFlag.newPane).toBe(false);

	// PR8-E2 handler-level: the handler's force-new-pane decision is made
	// by resolveForceNewPane (shared by discovered + ad-hoc paths), so
	// --new-pane actually reaches stop-then-create instead of being
	// parsed-and-dropped. forceSpawn = (command === 'new') OR newPaneFlag.
	expect(resolveForceNewPane("start", parsed.newPane)).toBe(true);
	expect(resolveForceNewPane("start", noFlag.newPane)).toBe(false);
	expect(resolveForceNewPane("new", noFlag.newPane)).toBe(true);
	expect(resolveForceNewPane("resume", noFlag.newPane)).toBe(false);
	expect(resolveForceNewPane("resume", parsed.newPane)).toBe(true);
	// Discovered-path detection: /agents:start alpha --new-pane means the
	// trailing token appears in parts (this is what the handler feeds into
	// resolveForceNewPane for discovered agents).
	const discoveredParts = ["start", "alpha", "--new-pane"];
	expect(resolveForceNewPane(discoveredParts[0]!, discoveredParts.includes("--new-pane"))).toBe(true);
	const noNewPaneParts = ["start", "alpha"];
	expect(resolveForceNewPane(noNewPaneParts[0]!, noNewPaneParts.includes("--new-pane"))).toBe(false);
});

// D8 (round 3 + PR8-E4) — passthroughArgs reach the spawned pi argv.
// The parser preserves unrecognized --flag <value> tokens; the
// launcher script wraps each with shellQuote before joining into
// pi argv. This test runs writeLauncher for real and asserts the
// generated launcher's `exec` line contains the passthrough tokens,
// each shell-escaped (spec 001 §4.7). A value needing escaping
// (x;y) must appear in single-quoted form — proving shellQuote ran.
test("dispatch-round3-passthrough-launcher", async () => {
	const parsed = parseAdhocArgs("foo --danger x;y --no-history", rootTmp);
	expect(parsed.passthroughArgs).toEqual(["--danger", "x;y", "--no-history"]);
	const agent = await synthesizeAdhocAgent({ name: "foo", cwd: rootTmp, pane: true, passthroughArgs: parsed.passthroughArgs });
	// 1) AgentConfig preserves passthroughArgs (PR 6 S10 contract).
	expect((agent as unknown as { passthroughArgs?: string[] }).passthroughArgs).toEqual([
		"--danger",
		"x;y",
		"--no-history",
	]);
	// 2) writeLauncher writes a launcher whose `exec` line contains the
	//    passthrough tokens, shell-escaped. writeLauncher needs a real
	//    runtimeRoot; reuse rootTmp and let it create the dirs.
	const { launcherFile } = await writeLauncher(rootTmp, "parentSession", rootTmp, agent, undefined, undefined);
	const script = readFileSync(launcherFile, "utf8");
	const execLine = script.split("\n").find((line) => line.startsWith("exec ")) ?? "";
	// Passthrough tokens present, each shell-quoted. x;y needs escaping
	// so shellQuote wraps it in single quotes ('x;y') — the raw unquoted
	// `;y` form must NOT appear (that would be a shell injection hole).
	expect(execLine).toContain("--danger");
	expect(execLine).toContain("'x;y'");
	expect(execLine).not.toContain("--danger x;y");
	expect(execLine).toContain("--no-history");
});
