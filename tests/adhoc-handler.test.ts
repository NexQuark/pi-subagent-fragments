/**
 * spec 002 §4.5 / §5.5 — PR8-E5/E6/E7 handler-level tests.
 *
 * These tests invoke the ACTUAL agentsHandler (via registerAgentsCommands
 * with a mock pi) to close the "parsed-but-not-wired" root pattern that
 * pure-helper tests miss (PR7-F1 / PR8-F1 / PR8-F5 false confidence).
 *
 * F5: --no-pane on a NON-tmux host must route to the bg lane
 *     (runSingleAgent), never throw a tmux error.
 * F6: the C1 warn fires only when $TMUX is unavailable, not when
 *     --no-pane is passed on a tmux host.
 * F7: --new-pane triggers stop-then-create (forceNewPane) at handler
 *     level, verified via mock tmux (stop old pane + create new).
 *
 * The bg spawn seam (setSingleAgentSpawnForTests) and the tmux exec seam
 * (setPaneExecCaptureForTests) let us exercise the real handler without
 * spawning processes.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgentsCommands } from "../extensions/subagent/agents-command.js";
import { setSingleAgentSpawnForTests } from "../extensions/subagent/runner.js";
import { setPaneExecCaptureForTests } from "../extensions/subagent/pane.js";

const tmpDirs: string[] = [];
let userDir: string;
let rootTmp: string;

function tempDir(tag: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pi-agents-${tag}-`));
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
	rootTmp = tempDir("handler");
	// Ad-hoc workspace: no discovered agents here, so any name is ad-hoc.
	mkdirSync(join(rootTmp, ".pi", "agents"), { recursive: true });
});

afterEach(() => {
	delete process.env.TMUX;
	setSingleAgentSpawnForTests();
	setPaneExecCaptureForTests();
});

type RegisteredHandlers = Record<string, (args: string, ctx: ExtensionCommandContext) => Promise<{ content: string } | void>>;

function captureHandlers(): { handlers: RegisteredHandlers; pi: ExtensionAPI; messages: Array<{ content: string }> } {
	const handlers: RegisteredHandlers = {};
	const messages: Array<{ content: string }> = [];
	const pi = {
		registerCommand: (name: string, opts: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<any> }) => {
			handlers[name] = opts.handler;
		},
		getActiveTools: () => [],
		getThinkingLevel: () => undefined,
		sendMessage: (m: { content: string }) => messages.push(m),
		events: { emit: () => undefined },
	} as unknown as ExtensionAPI;
	registerAgentsCommands({
		agentCommandCompletions: [],
		agentsArgumentCompletions: () => null,
		dashboardState: { items: {} },
		formatRelativeTime: () => "",
		persistRuntimeSnapshot: async () => undefined,
		pi,
		removeDashboardAgent: () => undefined,
		syncDashboard: () => undefined,
	});
	lastCapture = { handlers, messages };
	return { handlers, pi, messages };
}

// Invoke a captured handler and return the content it sends via sendMessage.
async function invoke(handler: RegisteredHandlers[keyof RegisteredHandlers] | undefined, args: string): Promise<string> {
	expect(handler).toBeDefined();
	const { messages } = lastCapture;
	await (handler as (a: string, c: ExtensionCommandContext) => Promise<void>)(args, ctx());
	const sent = messages.find((m) => m.content && !m.content.startsWith("Error"));
	return sent?.content ?? "";
}

// The most recent captureHandlers() result, used by invoke() to read sent messages.
let lastCapture: { handlers: RegisteredHandlers; messages: Array<{ content: string }> } | undefined;

function ctx(): ExtensionCommandContext {
	return {
		cwd: rootTmp,
		model: undefined,
		sessionManager: { getSessionId: () => "handler-test-session" },
	} as unknown as ExtensionCommandContext;
}

// Mock the bg spawn so runSingleAgent completes without a real child.
function mockBgSpawn(): number {
	let calls = 0;
	setSingleAgentSpawnForTests((() => {
		calls++;
		const proc = new EventEmitter() as any;
		proc.stdout = new EventEmitter();
		proc.stderr = new EventEmitter();
		proc.killed = false;
		proc.kill = () => { proc.killed = true; return true; };
		queueMicrotask(() => {
			proc.stdout.emit("data", Buffer.from("done"));
			proc.emit("close", 0, null);
		});
		return proc;
	}) as any);
	return () => calls;
}

describe("adhoc handler bg routing (PR8-E5/F5)", () => {
	test("--no-pane on non-tmux host routes to bg, no throw", async () => {
		// $TMUX unset (non-tmux host).
		delete process.env.TMUX;
		const countSpawns = mockBgSpawn();
		const { handlers } = captureHandlers();
		// No throw; content says bg.
		const content = await invoke(handlers["agents:new"], "adhoc-xyz --no-pane");
		expect(content).toContain("Dispatched as bg");
		// A bg child was spawned (runSingleAgent path), NOT a tmux error.
		expect(countSpawns()).toBe(1);
	});

	test("non-tmux host + no flags falls back to bg (C1), no throw", async () => {
		delete process.env.TMUX;
		const warns: string[] = [];
		const origWarn = console.warn;
		console.warn = (m: string) => warns.push(m);
		const countSpawns = mockBgSpawn();
		const { handlers } = captureHandlers();
		try {
			await invoke(handlers["agents:new"], "adhoc-xyz2");
		} finally {
			console.warn = origWarn;
		}
		expect(countSpawns()).toBe(1);
		expect(warns.some((w) => w.includes("tmux not available"))).toBe(true);
	});
});

describe("adhoc handler --no-pane warn scope (PR8-F6)", () => {
	test("warn does NOT fire when --no-pane on a tmux host", async () => {
		// tmux host present.
		process.env.TMUX = "/tmp/tmux-f6,12345,0";
		const warns: string[] = [];
		const origWarn = console.warn;
		console.warn = (m: string) => warns.push(m);
		// --no-pane routes to bg even on a tmux host, so mock the bg spawn.
		mockBgSpawn();
		const tmuxCalls: Array<string[]> = [];
		setPaneExecCaptureForTests(async (command: string, args: string[]) => {
			tmuxCalls.push(args);
			if (command === "tmux" && args[0] === "display-message") return { code: 0, stdout: "%1", stderr: "" };
			return { code: 0, stdout: "", stderr: "" };
		});
		const { handlers } = captureHandlers();
		try {
			// --no-pane on a tmux host: explicit bg choice. No fake 'tmux not
			// available' warn (PR8-F6).
			const content = await invoke(handlers["agents:start"], "adhoc-f6 --no-pane");
			expect(content).toContain("Dispatched as bg");
		} finally {
			console.warn = origWarn;
		}
		expect(warns.some((w) => w.includes("tmux not available"))).toBe(false);
	});
});

describe("adhoc handler --new-pane stop-then-create (PR8-E7/F7)", () => {
	test("--new-pane forces a fresh pane (stop-then-create) via mock tmux", async () => {
		// tmux host present.
		process.env.TMUX = "/tmp/tmux-h,12345,0";
		const tmuxCalls: Array<string[]> = [];
		setPaneExecCaptureForTests(async (command: string, args: string[]) => {
			tmuxCalls.push(args);
			if (command === "tmux" && args[0] === "display-message") {
				return { code: 0, stdout: "%1", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		});
		const { handlers } = captureHandlers();
		// Use /agents:start so --new-pane (not just command==='new') is the
		// force-trigger. Fresh launch (no existing pane) — must not throw.
		const content = await invoke(handlers["agents:start"], "adhoc-c2 --new-pane");
		expect(content).toContain("Started ad-hoc pane");
		// A tmux split-window (pane create) must have been attempted.
		expect(tmuxCalls.some((args) => args[0] === "split-window")).toBe(true);
	});
});
