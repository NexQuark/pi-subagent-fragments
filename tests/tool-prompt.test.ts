/**
 * spec 005 R1 — every registered tool carries promptSnippet + curated
 * promptGuidelines (structured tool prompting; retire APPEND_SYSTEM.md).
 *
 * Captures the REAL registerTool definitions from subagentExtension(mockPi)
 * and asserts each of the 7 tools ships both fields, plus that the subagent
 * guidelines carry the curated core calling rules (not the full prose).
 *
 * RED: the tool definitions have no promptSnippet/promptGuidelines yet.
 * Expect all 7 to fail.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import subagentExtension from "../extensions/subagent/index.js";

const tmpDirs: string[] = [];
function tempDir(tag: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pi-toolprompt-${tag}-`));
	tmpDirs.push(dir);
	return dir;
}
beforeAll(() => {
	process.env.PI_CODING_AGENT_DIR = tempDir("user");
});
afterAll(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	for (const dir of tmpDirs) rmSync(dir, { force: true, recursive: true });
});

const ALL_TOOLS = [
	"subagent",
	"delegate_subagent",
	"steer_subagent",
	"get_subagent_result",
	"wait_for_subagent_idle",
	"stop_subagent",
	"complete_subagent",
] as const;

function captureToolDefs(): Map<string, any> {
	const defs = new Map<string, any>();
	const bus = new EventEmitter();
	const pi = {
		appendEntry: () => undefined,
		events: { emit: bus.emit.bind(bus), on: bus.on.bind(bus) },
		getActiveTools: () => [],
		getThinkingLevel: () => undefined,
		on: () => undefined,
		registerCommand: () => undefined,
		registerMessageRenderer: () => undefined,
		registerShortcut: () => undefined,
		registerTool: (def: any) => defs.set(def.name, def),
		sendMessage: () => undefined,
		sendUserMessage: async () => undefined,
	} as any;
	subagentExtension(pi);
	return defs;
}

describe("spec 005 R1 — structured tool prompting", () => {
	test("each of the 7 tools carries a non-empty promptSnippet", () => {
		const defs = captureToolDefs();
		for (const name of ALL_TOOLS) {
			const def = defs.get(name);
			expect(def, `${name} tool registered`).toBeDefined();
			expect(def.promptSnippet, `${name}.promptSnippet`).toBeTruthy();
		}
	});

	test("each of the 7 tools carries non-empty promptGuidelines", () => {
		const defs = captureToolDefs();
		for (const name of ALL_TOOLS) {
			const def = defs.get(name);
			expect(def, `${name} tool registered`).toBeDefined();
			expect(Array.isArray(def.promptGuidelines) && def.promptGuidelines.length > 0, `${name}.promptGuidelines`).toBe(true);
		}
	});

	test("subagent guidelines carry the curated core calling rules", () => {
		const defs = captureToolDefs();
		const guidelines = (defs.get("subagent")?.promptGuidelines ?? []).join("\n").toLowerCase();
		expect(guidelines).toContain("self-contained");
		expect(guidelines).toContain("end your turn");
		expect(guidelines).toContain("do not use");
	});

	test("delegate_subagent guidelines carry its restricted single-dispatch rules", () => {
		const defs = captureToolDefs();
		const guidelines = (defs.get("delegate_subagent")?.promptGuidelines ?? []).join("\n").toLowerCase();
		expect(guidelines).toContain("single dispatch");
		expect(guidelines).toContain("allowed-subagents");
	});
});
