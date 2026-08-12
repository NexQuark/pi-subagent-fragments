// E2E for spec 001: fragments-based systemPrompt composition.
// Verifies load-time + spawn-time chain via writeLauncher().

import { mkdtempSync, readFileSync, rmSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgents } from "../extensions/subagent/agents.js";
import { writeLauncher } from "../extensions/subagent/pane.js";

const FIXTURE_DIR = join(import.meta.dirname, "fixtures");

// Build a fake project layout under a fresh tmp dir:
//   FAKE_PROJECT/.pi/agents/test-frag-agent.md
//   FAKE_PROJECT/.pi/agents/test-frag-role.md
//   FAKE_PROJECT/.pi/agents/test-frag-style.md
const FAKE_PROJECT = mkdtempSync(join(tmpdir(), "pi-e2e-001-"));
const PROJECT_AGENTS_DIR = join(FAKE_PROJECT, ".pi", "agents");
mkdirSync(PROJECT_AGENTS_DIR, { recursive: true });
copyFileSync(join(FIXTURE_DIR, "test-frag-agent.md"), join(PROJECT_AGENTS_DIR, "test-frag-agent.md"));
copyFileSync(join(FIXTURE_DIR, "test-frag-role.md"), join(PROJECT_AGENTS_DIR, "test-frag-role.md"));
copyFileSync(join(FIXTURE_DIR, "test-frag-style.md"), join(PROJECT_AGENTS_DIR, "test-frag-style.md"));

console.log("[E2E-001] FAKE_PROJECT:", FAKE_PROJECT);
console.log("[E2E-001] PROJECT_AGENTS_DIR:", PROJECT_AGENTS_DIR);

// Step 1: discover agents
const result = discoverAgents(FAKE_PROJECT, "project");
const agent = result.agents.find((a) => a.name === "e2e-frag-test");
if (!agent) {
	console.error("[E2E-001] FAIL: agent not discovered");
	console.error("[E2E-001] discovered:", result.agents.map((a) => a.name));
	console.error("[E2E-001] projectAgentsDir:", result.projectAgentsDir);
	rmSync(FAKE_PROJECT, { force: true, recursive: true });
	process.exit(1);
}

console.log("[E2E-001] discovered:", agent.name);
console.log("[E2E-001] systemPromptFragments:", agent.systemPromptFragments);
console.log("[E2E-001] systemPromptMode:", agent.systemPromptMode);
console.log("[E2E-001] composed systemPrompt length:", agent.systemPrompt.length);
console.log("[E2E-001] === composed systemPrompt (from load-time compose) ===");
console.log(agent.systemPrompt);
console.log("[E2E-001] === end ===");

// Step 2: writeLauncher → spawn artifacts.
const RUNTIME_ROOT = mkdtempSync(join(tmpdir(), "pi-e2e-001-runtime-"));
console.log("[E2E-001] RUNTIME_ROOT:", RUNTIME_ROOT);
try {
	const paths = await writeLauncher(
		RUNTIME_ROOT,
		"e2e-parent-session-id",
		FAKE_PROJECT,
		agent,
		undefined,
		"high",
		["read"],
	);
	console.log("[E2E-001] wrote:", paths);

	const promptContent = readFileSync(paths.promptFile, "utf8");
	console.log("[E2E-001] === prompt file content ===");
	console.log(promptContent);
	console.log("[E2E-001] === end prompt file ===");

	// Step 3: assert markers + order
	const checks = [
		{ needle: "FRAGMENT-A-START", desc: "fragment A start marker" },
		{ needle: "FRAGMENT-A-END", desc: "fragment A end marker" },
		{ needle: "FRAGMENT-B-START", desc: "fragment B start marker" },
		{ needle: "FRAGMENT-B-END", desc: "fragment B end marker" },
		{ needle: "AGENT-BODY-START", desc: "body start marker" },
		{ needle: "AGENT-BODY-END", desc: "body end marker" },
		{ needle: "\n\n---\n\n", desc: "default separator" },
	];
	let pass = 0;
	let fail = 0;
	for (const c of checks) {
		if (promptContent.includes(c.needle)) {
			console.log("[E2E-001] OK  : " + c.desc);
			pass += 1;
		} else {
			console.log("[E2E-001] FAIL: " + c.desc);
			fail += 1;
		}
	}

	// Order check
	const idx = (s) => promptContent.indexOf(s);
	const order = [
		"FRAGMENT-A-START",
		"FRAGMENT-A-END",
		"FRAGMENT-B-START",
		"FRAGMENT-B-END",
		"AGENT-BODY-START",
		"AGENT-BODY-END",
	];
	let lastIdx = -1;
	let orderOk = true;
	for (const m of order) {
		const i = idx(m);
		if (i < 0 || i <= lastIdx) {
			orderOk = false;
			console.log(`[E2E-001] ORDER FAIL at ${m} (idx=${i}, lastIdx=${lastIdx})`);
			break;
		}
		lastIdx = i;
	}
	if (orderOk) console.log("[E2E-001] OK  : order is fragments-then-body");

	// Also check that the body is the LAST non-separator content
	const bodyStartIdx = idx("AGENT-BODY-START");
	const sepAfterBody = promptContent.indexOf("\n\n---\n\n", bodyStartIdx);
	if (sepAfterBody !== -1) {
		console.log(`[E2E-001] FAIL: body has content after it (sep at idx=${sepAfterBody})`);
		fail += 1;
	} else {
		console.log("[E2E-001] OK  : body is the last segment (no separator after)");
	}

	if (fail === 0 && orderOk) {
		console.log(`[E2E-001] PASS: ${pass} markers present, order correct, body last`);
		rmSync(FAKE_PROJECT, { force: true, recursive: true });
		rmSync(RUNTIME_ROOT, { force: true, recursive: true });
		process.exit(0);
	} else {
		console.log(`[E2E-001] FAIL: ${fail} missing, orderOk=${orderOk}`);
		rmSync(FAKE_PROJECT, { force: true, recursive: true });
		rmSync(RUNTIME_ROOT, { force: true, recursive: true });
		process.exit(1);
	}
} catch (err) {
	console.error("[E2E-001] threw:", err);
	rmSync(FAKE_PROJECT, { force: true, recursive: true });
	rmSync(RUNTIME_ROOT, { force: true, recursive: true });
	process.exit(2);
}
