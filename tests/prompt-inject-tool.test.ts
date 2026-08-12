/**
 * spec 003 PR 12 — subagent tool `inject` param + subprocess-side
 * integration (red tests).
 *
 * The `subagent` tool gains an `inject` param (spec §3.6): a standalone
 * action that writes the injection state for a target agent's session
 * (same `writeInjectionState` the slash handler uses), so the
 * `before_agent_start` hook applies it on the target's next turn.
 *
 * RED: SubagentParams has no `inject` field and the subagent tool execute
 * does not handle it → modeCount is 0 → returns "Invalid parameters"
 * instead of writing state.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import subagentExtension from "../extensions/subagent/index.js";
import { sessionRuntimeDir } from "../extensions/subagent/settings.js";
import { injectStatePathFor, installPendingInjection } from "../extensions/subagent/prompt-inject.js";
import { promptHistoryPathFor } from "../extensions/subagent/prompt-history.js";

const tmpDirs: string[] = [];
let userDir: string;
let rootTmp: string;
let runtimeRoot: string;

function tempDir(tag: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pi-tool-${tag}-`));
	tmpDirs.push(dir);
	return dir;
}

beforeAll(() => {
	userDir = tempDir("user");
	process.env.PI_CODING_AGENT_DIR = userDir;
});

afterAll(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	for (const dir of tmpDirs) rmSync(dir, { force: true, recursive: true });
});

beforeEach(() => {
	rootTmp = tempDir("tool");
	mkdirSync(join(rootTmp, ".pi", "agents"), { recursive: true });
	runtimeRoot = sessionRuntimeDir("tool-test-session");
});

type SubagentExecute = (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: ExtensionContext) => Promise<any>;

function captureSubagentTool(): { execute: SubagentExecute; pi: any } {
	let execute: SubagentExecute | undefined;
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
		registerTool: (def: any) => {
			if (def.name === "subagent") execute = def.execute;
		},
		sendMessage: () => undefined,
		sendUserMessage: async () => undefined,
	} as any;
	subagentExtension(pi);
	expect(execute).toBeDefined();
	return { execute: execute!, pi };
}

function toolCtx(): ExtensionContext {
	return {
		cwd: rootTmp,
		model: undefined,
		sessionManager: { getSessionId: () => "tool-test-session" },
	} as unknown as ExtensionContext;
}

describe("subagent tool inject (spec 003 PR 12)", () => {
	test("inject replace writes state + returns result (standalone, no agent/task)", async () => {
		const { execute } = captureSubagentTool();
		const res = await execute("1", { inject: { name: "toolAgent", mode: "replace", sources: [{ kind: "string", value: "NEW" }] } }, undefined, undefined, toolCtx());
		expect(res?.content?.[0]?.text).toContain("Injected into toolAgent");
		const stateFile = injectStatePathFor(runtimeRoot, "toolAgent");
		expect(existsSync(stateFile)).toBe(true);
		const state = JSON.parse(readFileSync(stateFile, "utf8"));
		expect(state.mode).toBe("replace");
		expect(state.fragments).toEqual(["NEW"]);
	});

	test("inject append writes fragments (compose deferred to hook)", async () => {
		const { execute } = captureSubagentTool();
		await execute("2", { inject: { name: "toolApp", mode: "append", sources: [{ kind: "string", value: "part" }] } }, undefined, undefined, toolCtx());
		const state = JSON.parse(readFileSync(injectStatePathFor(runtimeRoot, "toolApp"), "utf8"));
		expect(state.mode).toBe("append");
		expect(state.fragments).toEqual(["part"]);
	});

	test("inject file source resolves content relative to inject.cwd (R2 file source)", async () => {
		const { execute } = captureSubagentTool();
		const src = join(rootTmp, "extra.md");
		writeFileSync(src, "FILE-CONTENT", "utf8");
		await execute("3", { inject: { name: "toolFile", mode: "replace", sources: [{ kind: "file", value: src }] } }, undefined, undefined, toolCtx());
		const state = JSON.parse(readFileSync(injectStatePathFor(runtimeRoot, "toolFile"), "utf8"));
		expect(state.fragments).toEqual(["FILE-CONTENT"]);
	});

	test("read on next turn: hook applies the tool-written state", async () => {
		const { execute } = captureSubagentTool();
		await execute("4", { inject: { name: "toolTurn", mode: "append", sources: [{ kind: "string", value: "B" }] } }, undefined, undefined, toolCtx());
		const res = await installPendingInjection({ runtimeRoot, sessionName: "toolTurn", eventSystemPrompt: "A" });
		expect(res?.systemPrompt).toBe("A\n\n---\n\nB");
		expect(existsSync(injectStatePathFor(runtimeRoot, "toolTurn"))).toBe(false);
	});

	test("inject history mode returns the markdown table (no state write)", async () => {
		// Pre-seed one applied version.
		const histFile = promptHistoryPathFor(runtimeRoot, "toolHist");
		mkdirSync(join(runtimeRoot, "prompt-history"), { recursive: true });
		writeFileSync(histFile, JSON.stringify([{ prev: "BASE", new: "BASE\n\n---\n\nX", mode: "append", timestamp: "2026-08-12T00:00:00Z", source: null }]), "utf8");
		const { execute } = captureSubagentTool();
		const res = await execute("5", { inject: { name: "toolHist", history: true } }, undefined, undefined, toolCtx());
		expect(res?.content?.[0]?.text).toContain("Prompt history for toolHist");
		expect(res?.content?.[0]?.text).toContain("| 1 |");
	});

	test("inject rollback 1 writes restored prior to state", async () => {
		const histFile = promptHistoryPathFor(runtimeRoot, "toolRoll");
		mkdirSync(join(runtimeRoot, "prompt-history"), { recursive: true });
		writeFileSync(histFile, JSON.stringify([{ prev: "BASE", new: "BASE\n\n---\n\nX", mode: "append", timestamp: "2026-08-12T00:00:00Z", source: null }]), "utf8");
		const { execute } = captureSubagentTool();
		const res = await execute("6", { inject: { name: "toolRoll", rollback: 1 } }, undefined, undefined, toolCtx());
		expect(res?.content?.[0]?.text).toContain("Rolled back toolRoll");
		const state = JSON.parse(readFileSync(injectStatePathFor(runtimeRoot, "toolRoll"), "utf8"));
		expect(state.mode).toBe("rollback");
		expect(state.fragments).toEqual(["BASE"]);
	});
});
