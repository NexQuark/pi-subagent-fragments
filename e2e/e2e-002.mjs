// E2E for spec 002 (R4 / e2e-002): ad-hoc pane launch surface.
// Verifies the real (non-mocked) chain:
//   parseAdhocArgs (full grammar) → synthesizeAdhocAgent → writeLauncher
// against the real @earendil-works/pi-* peers (resolved via NODE_PATH),
// mirroring e2e-001's driver pattern.
//
// Run: NODE_PATH=./e2e/local_node_modules bun run e2e/e2e-002.mjs

import { mkdtempSync, readFileSync, rmSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAdhocArgs } from "../extensions/subagent/agents-command.js";
import { synthesizeAdhocAgent } from "../extensions/subagent/agents.js";
import { writeLauncher } from "../extensions/subagent/pane.js";

const FIXTURE_DIR = join(import.meta.dirname, "fixtures");
const SEP = "\n\n---\n\n";

// Build a fake project layout under a fresh tmp dir so the real parser
// resolves ./adhoc-*.md relative to FAKE_PROJECT without contaminating any
// real project.
const FAKE_PROJECT = mkdtempSync(join(tmpdir(), "pi-e2e-002-"));
copyFileSync(join(FIXTURE_DIR, "adhoc-sys.md"), join(FAKE_PROJECT, "adhoc-sys.md"));
copyFileSync(join(FIXTURE_DIR, "adhoc-task.md"), join(FAKE_PROJECT, "adhoc-task.md"));
console.log("[E2E-002] FAKE_PROJECT:", FAKE_PROJECT);

let fail = 0;
function check(ok, desc) {
	if (ok) console.log("[E2E-002] OK  : " + desc);
	else { console.log("[E2E-002] FAIL: " + desc); fail += 1; }
}

try {
	// Step 1: parse the full ad-hoc grammar.
	const grammar =
		`myagent #./adhoc-sys.md #"E2E-INLINE-SYS" @./adhoc-task.md ` +
		`--model gpt-4 --replace --danger x;y --no-history`;
	const parsed = parseAdhocArgs(grammar, FAKE_PROJECT);
	console.log("[E2E-002] parsed.name:", parsed.name);
	console.log("[E2E-002] parsed.mode:", parsed.mode);
	console.log("[E2E-002] parsed.systemPromptSources:", JSON.stringify(parsed.systemPromptSources, null, 1));
	console.log("[E2E-002] parsed.userSources:", JSON.stringify(parsed.userSources, null, 1));
	console.log("[E2E-002] parsed.passthroughArgs:", parsed.passthroughArgs);

	check(parsed.name === "myagent", "name parsed");
	check(parsed.mode === "replace", "--replace → mode=replace");
	const sysFiles = parsed.systemPromptSources.filter((s) => s.type === "file");
	const sysInline = parsed.systemPromptSources.filter((s) => s.type === "inline");
	check(sysFiles.length === 1 && sysFiles[0].path === "./adhoc-sys.md", "system file source path parsed");
	check(
		sysFiles[0].content.includes("E2E-ADHOC-SYS-START"),
		"system file source content read (real parser, file resolved)",
	);
	check(sysInline.length === 1 && sysInline[0].value === "E2E-INLINE-SYS", "#\"...\" inline system source parsed");
	const userFiles = parsed.userSources.filter((s) => s.type === "file");
	check(
		userFiles.length === 1 && userFiles[0].content.includes("E2E-ADHOC-TASK-START"),
		"@./adhoc-task.md user file source content read",
	);
	check(parsed.model === "gpt-4", "--model gpt-4 parsed");
	check(
		parsed.passthroughArgs.join(" ") === "--danger x;y --no-history",
		"passthrough args preserved verbatim",
	);

	// Step 2: synthesize the ad-hoc agent (mirror handler wiring at
	// agents-command.ts:123 — file sources → systemPromptFiles, inline system
	// sources → systemPrompt joined by separator).
	const agent = await synthesizeAdhocAgent({
		name: parsed.name,
		cwd: FAKE_PROJECT,
		systemPromptFiles: sysFiles.map((s) => s.path),
		systemPrompt: sysInline.map((s) => s.value).join(SEP),
		pane: true,
		replace: parsed.mode === "replace",
		model: parsed.model,
		passthroughArgs: parsed.passthroughArgs,
	});
	console.log("[E2E-002] synthesized:", agent.name, "model:", agent.model);
	console.log("[E2E-002] systemPromptMode:", agent.systemPromptMode);
	check(agent.systemPromptMode === "replace", "--replace → AgentConfig.systemPromptMode=replace");
	check(
		agent.systemPrompt.includes("E2E-ADHOC-SYS-START") && agent.systemPrompt.includes("E2E-ADHOC-SYS-END"),
		"system fragment content composed into systemPrompt",
	);
	check(agent.systemPrompt.includes("E2E-INLINE-SYS"), "inline system source composed into systemPrompt");
	check(agent.systemPrompt.includes(SEP), "default separator between fragment and body");

	// Step 3: writeLauncher → spawn artifacts (promptFile + launcher exec).
	const RUNTIME_ROOT = mkdtempSync(join(tmpdir(), "pi-e2e-002-runtime-"));
	const paths = await writeLauncher(RUNTIME_ROOT, "e2e-parent-session-id", FAKE_PROJECT, agent, agent.model, "high", ["read"]);
	console.log("[E2E-002] wrote:", paths);

	const promptContent = readFileSync(paths.promptFile, "utf8");
	console.log("[E2E-002] === prompt file content ===");
	console.log(promptContent);
	console.log("[E2E-002] === end prompt file ===");
	check(promptContent.includes("E2E-ADHOC-SYS-START"), "prompt file contains system fragment START");
	check(promptContent.includes("E2E-ADHOC-SYS-END"), "prompt file contains system fragment END");
	check(promptContent.includes("E2E-INLINE-SYS"), "prompt file contains inline system body");

	// Passthrough args must reach the spawned pi argv, shell-quoted.
	const script = readFileSync(paths.launcherFile, "utf8");
	const execLine = script.split("\n").find((line) => line.startsWith("exec ")) ?? "";
	console.log("[E2E-002] exec line:", execLine);
	check(execLine.includes("--danger"), "passthrough --danger reaches launcher exec");
	check(execLine.includes("'x;y'"), "passthrough value needing escaping is shell-quoted");
	check(!execLine.includes("--danger x;y"), "raw unquoted passthrough value not present (shell injection guard)");

	rmSync(FAKE_PROJECT, { force: true, recursive: true });
	rmSync(RUNTIME_ROOT, { force: true, recursive: true });
	if (fail === 0) {
		console.log("[E2E-002] PASS: full ad-hoc grammar → synthesize → launcher (prompt + passthrough)");
		process.exit(0);
	}
	console.log(`[E2E-002] FAIL: ${fail} check(s) failed`);
	process.exit(1);
} catch (err) {
	console.error("[E2E-002] threw:", err);
	rmSync(FAKE_PROJECT, { force: true, recursive: true });
	process.exit(2);
}
