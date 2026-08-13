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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgentsCommands } from "../extensions/subagent/agents-command.js";
import { setSingleAgentSpawnForTests } from "../extensions/subagent/runner.js";
import { setPaneExecCaptureForTests } from "../extensions/subagent/pane.js";
import { runtimeSessionId, sessionRuntimeDir } from "../extensions/subagent/settings.js";
import { inboxDir, registryPath } from "../extensions/subagent/paths.js";
import { injectStatePathFor } from "../extensions/subagent/prompt-inject.js";
import { promptHistoryPathFor } from "../extensions/subagent/prompt-history.js";

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

// Invoke a captured handler and return the LATEST content it sends via
// sendMessage during THIS call (multi-invoke safe: each call appends to the
// shared message log, so we only look at messages added after the snapshot).
async function invoke(handler: RegisteredHandlers[keyof RegisteredHandlers] | undefined, args: string): Promise<string> {
	expect(handler).toBeDefined();
	const { messages } = lastCapture!;
	const before = messages.length;
	await (handler as (a: string, c: ExtensionCommandContext) => Promise<void>)(args, ctx());
	const newOnes = messages.slice(before).filter((m) => m.content && !m.content.startsWith("Error"));
	return newOnes[newOnes.length - 1]?.content ?? "";
}

// Invoke and return the RAW last message content (including Error messages).
async function invokeRaw(handler: RegisteredHandlers[keyof RegisteredHandlers] | undefined, args: string): Promise<string> {
	expect(handler).toBeDefined();
	const { messages } = lastCapture!;
	const before = messages.length;
	await (handler as (a: string, c: ExtensionCommandContext) => Promise<void>)(args, ctx());
	return messages[messages.length - 1]?.content ?? "";
}

// Deterministic runtime root for the handler-test session.
function handlerRuntimeRoot(): string {
	return sessionRuntimeDir(runtimeSessionId(ctx()));
}

// Seed a live pane registry entry so the inject mutation path sees a live target.
function seedLivePane(agent: string, paneId = "%99"): void {
	const runtimeRoot = handlerRuntimeRoot();
	mkdirSync(runtimeRoot, { recursive: true });
	writeFileSync(
		registryPath(runtimeRoot),
		JSON.stringify({
			[agent]: {
				agent,
				paneId,
				windowName: `agent:${agent}`,
				cwd: rootTmp,
				sessionFile: `${agent}.jsonl`,
				promptFile: "p",
				launcherFile: "l",
				startedAt: new Date().toISOString(),
			},
		}),
		"utf8",
	);
}

// Mock tmux so paneExists(<id>) is true (echoes the id back).
function mockLiveTmux(): void {
	setPaneExecCaptureForTests(async (command: string, args: string[]) => {
		if (command !== "tmux") return { code: 0, stdout: "", stderr: "" };
		const [sub, ...rest] = args;
		if (sub === "display-message") {
			const tIdx = rest.indexOf("-t");
			if (tIdx >= 0) return { code: 0, stdout: rest[tIdx + 1] ?? "", stderr: "" };
			return { code: 0, stdout: "%1", stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	});
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

// Stateful tmux mock: echoes pane ids back for paneExists, returns a fresh
// pane id per split-window, and lets callers observe split/kill ordering.
function installStatefulTmuxMock(): { tmuxCalls: Array<string[]>; splitCount: () => number } {
	const tmuxCalls: Array<string[]> = [];
	let panesCreated = 0;
	setPaneExecCaptureForTests(async (command: string, args: string[]) => {
		tmuxCalls.push(args);
		if (command !== "tmux") return { code: 0, stdout: "", stderr: "" };
		const [sub, ...rest] = args;
		if (sub === "list-panes") {
			// Skip paneContainingProcess so getPrimaryPaneId falls through.
			return { code: 1, stdout: "", stderr: "" };
		}
		if (sub === "split-window") {
			panesCreated++;
			return { code: 0, stdout: `%${10 + panesCreated}0`, stderr: "" };
		}
		if (sub === "display-message") {
			const tIdx = rest.indexOf("-t");
			if (tIdx >= 0) {
				const target = rest[tIdx + 1];
				// paneExists: display-message -p -t <id> #{pane_id} must echo the id
				// back (code 0 + stdout === paneId) for the pane to count as live.
				if (rest.some((t) => t.includes("pane_id")) && target && !target.includes(":")) {
					return { code: 0, stdout: target, stderr: "" };
				}
				return { code: 0, stdout: "", stderr: "" };
			}
			// No -t: getPrimaryPaneId fallback (primary pane) or session name.
			if (rest.some((t) => t.includes("pane_id"))) return { code: 0, stdout: "%1", stderr: "" };
			return { code: 0, stdout: "test-session", stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	});
	return { tmuxCalls, splitCount: () => panesCreated };
}

describe("adhoc handler --new-pane with pre-existing pane (PR8-F8)", () => {
	test("F8: --new-pane stops old pane then creates a fresh one", async () => {
		process.env.TMUX = "/tmp/tmux-f8,12345,0";
		const { tmuxCalls, splitCount } = installStatefulTmuxMock();
		const { handlers } = captureHandlers();
		// 1. Plain start → live pane.
		const c1 = await invoke(handlers["agents:start"], "adhoc-f8");
		expect(c1).toContain("Started ad-hoc pane");
		expect(splitCount()).toBe(1);
		// 2. --new-pane → stop the old pane, then create a fresh one.
		const c2 = await invoke(handlers["agents:start"], "adhoc-f8 --new-pane");
		expect(c2).toContain("Started ad-hoc pane");
		expect(splitCount()).toBe(2);
		// A kill-pane (stop old) must precede the second split-window (create new).
		const killIdx = tmuxCalls.findIndex((a) => a[0] === "kill-pane");
		const split2Idx = tmuxCalls.map((a) => a[0] === "split-window").lastIndexOf(true);
		expect(killIdx).toBeGreaterThan(-1);
		expect(killIdx).toBeLessThan(split2Idx);
	});

	test("F8 control: plain double-start reuses the live pane (no second split)", async () => {
		process.env.TMUX = "/tmp/tmux-f8c,12345,0";
		const { tmuxCalls, splitCount } = installStatefulTmuxMock();
		const { handlers } = captureHandlers();
		const c1 = await invoke(handlers["agents:start"], "adhoc-f8c");
		expect(c1).toContain("Started ad-hoc pane");
		expect(splitCount()).toBe(1);
		// Plain second start must REUSE the live pane: no second split-window
		// and no kill-pane. (On Linux the reuse path also verifies the pane's
		// live cwd via a mocked #{pane_pid}; if that check can't be satisfied
		// it emits a cwd-stale Error AFTER the reuse decision — but crucially
		// NO new pane is created. F8's concern is the second-pane-split, which
		// is what --new-pane vs plain start must differ on.)
		const c2 = await invoke(handlers["agents:start"], "adhoc-f8c");
		void c2;
		expect(splitCount()).toBe(1);
		expect(tmuxCalls.filter((a) => a[0] === "kill-pane").length).toBe(0);
	});
});

describe("adhoc handler inject (spec 003 PR 10)", () => {
	test("--replace on a live pane writes state + warns", async () => {
		process.env.TMUX = "/tmp/tmux-ij,12345,0";
		seedLivePane("injectTgt");
		mockLiveTmux();
		const warns: string[] = [];
		const origWarn = console.warn;
		console.warn = (m: string) => warns.push(m);
		const { handlers } = captureHandlers();
		try {
			const content = await invoke(handlers["agents:inject"], 'injectTgt --replace "new prompt"');
			expect(content).toContain("Injected into injectTgt");
			expect(content).toContain("mode=replace");
		} finally {
			console.warn = origWarn;
		}
		const stateFile = injectStatePathFor(handlerRuntimeRoot(), "injectTgt");
		expect(existsSync(stateFile)).toBe(true);
		const state = JSON.parse(readFileSync(stateFile, "utf8"));
		expect(state.mode).toBe("replace");
		// PR 11: write side stores fragments; compose happens at hook apply.
		expect(state.fragments).toEqual(["new prompt"]);
		expect(warns.some((w) => w.includes("inject: injectTgt mode=replace"))).toBe(true);
	});

	test("--append writes fragments; compose deferred to hook (OQ3/A2/F2)", async () => {
		process.env.TMUX = "/tmp/tmux-ij,12345,0";
		seedLivePane("injectApp");
		mockLiveTmux();
		const { handlers } = captureHandlers();
		// Write side stores only the injected fragments; the hook composes
		// against the real event.systemPrompt (reviewer F2).
		await invoke(handlers["agents:inject"], 'injectApp --append "part"');
		const state = JSON.parse(readFileSync(injectStatePathFor(handlerRuntimeRoot(), "injectApp"), "utf8"));
		expect(state.mode).toBe("append");
		expect(state.fragments).toEqual(["part"]);
	});

	test("--replace on a non-live agent → error (OQ4)", async () => {
		const { handlers } = captureHandlers();
		const raw = await invokeRaw(handlers["agents:inject"], 'ghost --replace "x"');
		expect(raw).toContain("inject: ghost has no live pane session to inject into");
	});

	test("--history on non-live agent shows empty history, no error (OQ4)", async () => {
		const { handlers } = captureHandlers();
		const content = await invoke(handlers["agents:inject"], "ghost --history");
		expect(content).toContain("No prompt history");
	});

	test("--rollback with empty history → error", async () => {
		// Non-live target, empty history file → rollback fails cleanly.
		const { handlers } = captureHandlers();
		const raw = await invokeRaw(handlers["agents:inject"], "ghost --rollback");
		expect(raw).toContain("inject: no prior versions to roll back to");
	});

	// PR 11 F1: --rollback 0 must be rejected explicitly (not fall through
	// to the ambiguous "no prior versions" path).
	test("F1: --rollback 0 on live agent → explicit error (N must be >= 1)", async () => {
		process.env.TMUX = "/tmp/tmux-ij,12345,0";
		seedLivePane("injectF1");
		mockLiveTmux();
		const { handlers } = captureHandlers();
		const raw = await invokeRaw(handlers["agents:inject"], "injectF1 --rollback 0");
		expect(raw).toContain("inject: --rollback N must be >= 1");
	});

	// PR 11 test (b): after one applied mutation, --history lists 1 row and
	// --rollback 1 writes the restored prior prompt to state.
	function seedHistory(agent: string, entries: Array<{ prev: string; new: string; mode: string }>): void {
		const file = promptHistoryPathFor(handlerRuntimeRoot(), agent);
		mkdirSync(join(handlerRuntimeRoot(), "prompt-history"), { recursive: true });
		writeFileSync(
			file,
			JSON.stringify(entries.map((e, i) => ({ ...e, timestamp: `2026-08-12T00:00:0${i}Z`, source: null })), null, 2),
			"utf8",
		);
	}

	test("--history lists applied versions (1 row after one apply)", async () => {
		process.env.TMUX = "/tmp/tmux-ij,12345,0";
		seedLivePane("injectHist");
		mockLiveTmux();
		seedHistory("injectHist", [{ prev: "BASE", new: "BASE\n\nX", mode: "append" }]);
		const { handlers } = captureHandlers();
		const content = await invoke(handlers["agents:inject"], "injectHist --history");
		expect(content).toContain("Prompt history for injectHist");
		expect(content).toContain("append");
		expect(content).toContain("| 1 |");
	});

	test("--rollback 1 restores prior prompt to state (test b)", async () => {
		process.env.TMUX = "/tmp/tmux-ij,12345,0";
		seedLivePane("injectRoll");
		mockLiveTmux();
		seedHistory("injectRoll", [{ prev: "BASE", new: "BASE\n\nX", mode: "append" }]);
		const { handlers } = captureHandlers();
		const content = await invoke(handlers["agents:inject"], "injectRoll --rollback 1");
		expect(content).toContain("Rolled back injectRoll");
		const state = JSON.parse(readFileSync(injectStatePathFor(handlerRuntimeRoot(), "injectRoll"), "utf8"));
		expect(state.mode).toBe("rollback");
		expect(state.fragments).toEqual(["BASE"]);
	});
});

describe("adhoc name-only empty task (spec 003 post contract)", () => {
	// Read the sole delegation task file written to the agent's inbox dir and
	// assert the task segment is EMPTY (compactTask="" — name-only launch).
	function readPaneTaskFile(agent: string): string {
		const inbox = inboxDir(handlerRuntimeRoot(), agent);
		const md = readdirSync(inbox).find((f) => f.endsWith(".md"));
		expect(md).toBeDefined();
		return readFileSync(join(inbox, md!), "utf8");
	}

	function emptyTaskSegment(delegation: string): string {
		const match = delegation.match(/Task ID: \S+\n([\s\S]*?)When done/);
		return match ? match[1]!.trim() : delegation;
	}

	test("/agents:new <name> name-only → bg lane (empty task, no throw)", async () => {
		delete process.env.TMUX;
		const countSpawns = mockBgSpawn();
		const { handlers } = captureHandlers();
		const content = await invoke(handlers["agents:new"], "adhoc-nb --no-pane");
		expect(content).toContain("Dispatched as bg");
		expect(countSpawns()).toBe(1);
	});

	test("/agents:start <name> name-only → pane lane records an EMPTY task", async () => {
		process.env.TMUX = "/tmp/tmux-no1,12345,0";
		installStatefulTmuxMock();
		const { handlers } = captureHandlers();
		const content = await invoke(handlers["agents:start"], "adhoc-no1");
		expect(content).toContain("Started ad-hoc pane");
		const delegation = readPaneTaskFile("adhoc-no1");
		expect(delegation).toContain("Task for adhoc-no1");
		expect(emptyTaskSegment(delegation)).toBe("");
	});

	test("/agents:new <name> name-only → pane lane records an EMPTY task", async () => {
		process.env.TMUX = "/tmp/tmux-no2,12345,0";
		installStatefulTmuxMock();
		const { handlers } = captureHandlers();
		const content = await invoke(handlers["agents:new"], "adhoc-no2");
		expect(content).toContain("Started ad-hoc pane");
		const delegation = readPaneTaskFile("adhoc-no2");
		expect(delegation).toContain("Task for adhoc-no2");
		expect(emptyTaskSegment(delegation)).toBe("");
	});
});
