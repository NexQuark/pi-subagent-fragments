/**
 * spec 004 R6 — running agent instance cap (default 40, configurable).
 *
 * Handler-level tests (real registerAgentsCommands with mock pi) verifying
 * /agents:new / /agents:start refuse to launch another instance once
 * maxAgents is met; stopped/dead instances are not counted; maxAgents<=0 is
 * unlimited; the error carries count + resource summary + remediation; and
 * management ops are never blocked at the cap.
 *
 * RED: the handler has no cap yet — new/start over the limit succeeds instead
 * of rejecting. Expect the cap-rejection tests to fail.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgentsCommands } from "../extensions/subagent/agents-command.js";
import { setSingleAgentSpawnForTests } from "../extensions/subagent/runner.js";
import { setPaneExecCaptureForTests } from "../extensions/subagent/pane.js";
import { runtimeSessionId, sessionRuntimeDir } from "../extensions/subagent/settings.js";
import { registryPath, taskRegistryPath } from "../extensions/subagent/paths.js";
import { CONFIG_ID } from "../extensions/subagent/types.js";

const tmpDirs: string[] = [];
let userDir: string;
let rootTmp: string;
function tempDir(tag: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pi-instcap-${tag}-`));
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
	rootTmp = tempDir("cap");
	mkdirSync(join(rootTmp, ".pi", "agents"), { recursive: true });
	rmSync(join(userDir, "settings.json"), { force: true });
	// Fresh registries per test (same session runtime root across the file).
	rmSync(registryPath(capRuntimeRoot()), { force: true });
	rmSync(taskRegistryPath(capRuntimeRoot()), { force: true });
});
afterEach(() => {
	delete process.env.TMUX;
	setSingleAgentSpawnForTests();
	setPaneExecCaptureForTests();
	rmSync(join(userDir, "settings.json"), { force: true });
});

function setMaxAgents(n: number): void {
	writeFileSync(
		join(userDir, "settings.json"),
		JSON.stringify({ vstack: { extensionManager: { config: { [CONFIG_ID]: { maxAgents: n } } } } }),
		"utf8",
	);
}

function capRuntimeRoot(): string {
	return sessionRuntimeDir(runtimeSessionId(capCtx()));
}
function capCtx(): ExtensionCommandContext {
	return { cwd: rootTmp, model: undefined, sessionManager: { getSessionId: () => "instance-cap-session" } } as unknown as ExtensionCommandContext;
}

// Seed N live panes + M bg one-shots into the runtime registries.
function seedInstances(panes: number, bg: number): void {
	const rt = capRuntimeRoot();
	mkdirSync(rt, { recursive: true });
	const paneRegistry: Record<string, unknown> = {};
	for (let i = 0; i < panes; i += 1) {
		const agent = `pane${i}`;
		paneRegistry[agent] = { agent, paneId: `%p${i}`, windowName: `agent:${agent}`, cwd: rootTmp, sessionFile: `${agent}.jsonl`, promptFile: "p", launcherFile: "l", startedAt: new Date().toISOString() };
	}
	writeFileSync(registryPath(rt), JSON.stringify(paneRegistry), "utf8");
	const taskRegistry: Record<string, unknown> = {};
	for (let i = 0; i < bg; i += 1) {
		const taskId = `t${i}`;
		taskRegistry[taskId] = { taskId, agent: `bg${i}`, task: "x", status: "running", kind: "oneshot", createdAt: new Date().toISOString() };
	}
	writeFileSync(taskRegistryPath(rt), JSON.stringify(taskRegistry), "utf8");
}

// tmux mock where paneExists(id) is true unless id ∈ deadPanes.
function mockTmux(deadPanes: Set<string> = new Set()): void {
	setPaneExecCaptureForTests(async (command: string, args: string[]) => {
		if (command !== "tmux") return { code: 0, stdout: "", stderr: "" };
		const [sub, ...rest] = args;
		if (sub === "display-message") {
			const tIdx = rest.indexOf("-t");
			if (tIdx >= 0) {
				const target = rest[tIdx + 1];
				if (deadPanes.has(target)) return { code: 0, stdout: "not-the-same", stderr: "" };
				return { code: 0, stdout: target, stderr: "" };
			}
			return { code: 0, stdout: "%1", stderr: "" };
		}
		if (sub === "split-window") return { code: 0, stdout: "%50", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	});
}

type RegisteredHandlers = Record<string, (args: string, ctx: ExtensionCommandContext) => Promise<{ content: string } | void>>;
let lastCapture: { handlers: RegisteredHandlers; messages: Array<{ content: string }> } | undefined;

function captureHandlers(): { handlers: RegisteredHandlers; messages: Array<{ content: string }> } {
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
	return { handlers, messages };
}
async function invokeRaw(handler: RegisteredHandlers[keyof RegisteredHandlers] | undefined, args: string): Promise<string> {
	expect(handler).toBeDefined();
	const { messages } = lastCapture!;
	const before = messages.length;
	await (handler as (a: string, c: ExtensionCommandContext) => Promise<void>)(args, capCtx());
	return messages[messages.length - 1]?.content ?? "";
}
async function invokeOk(handler: RegisteredHandlers[keyof RegisteredHandlers] | undefined, args: string): Promise<string> {
	const raw = await invokeRaw(handler, args);
	return raw.startsWith("Error") ? "" : raw;
}

describe("running instance cap (spec 004 R6)", () => {
	test("over-limit rejects pane lane with friendly error (count + panes/bg + remediation)", async () => {
		process.env.TMUX = "/tmp/tmux-cap,12345,0";
		mockTmux();
		setMaxAgents(1);
		seedInstances(1, 0); // 1 live pane → at cap
		const { handlers } = captureHandlers();
		const raw = await invokeRaw(handlers["agents:new"], "cap-pane");
		expect(raw.startsWith("Error")).toBe(true);
		expect(raw).toContain("1 running agent instances");
		expect(raw).toContain("maxAgents=1");
		expect(raw).toContain("1 panes, 0 bg");
		expect(raw).toContain("/agents:stop <name>");
		expect(raw).toContain("maxAgents");
	});

	test("over-limit rejects bg lane (--no-pane)", async () => {
		delete process.env.TMUX;
		setMaxAgents(1);
		seedInstances(0, 1); // 1 bg running → at cap
		const { handlers } = captureHandlers();
		const raw = await invokeRaw(handlers["agents:new"], "cap-bg --no-pane");
		expect(raw.startsWith("Error")).toBe(true);
		expect(raw).toContain("1 running agent instances");
		expect(raw).toContain("0 panes, 1 bg");
	});

	test("at cap with margin → still launches (N effective)", async () => {
		process.env.TMUX = "/tmp/tmux-cap2,12345,0";
		mockTmux();
		setMaxAgents(3);
		seedInstances(1, 1); // 2 running < 3
		const { handlers } = captureHandlers();
		const ok = await invokeOk(handlers["agents:new"], "cap-ok");
		expect(ok).toContain("Started ad-hoc pane");
	});

	test("stopped/dead instances are NOT counted", async () => {
		process.env.TMUX = "/tmp/tmux-cap3,12345,0";
		mockTmux(new Set(["%dead"])); // paneExists("%dead") === false
		setMaxAgents(1);
		// A dead pane registry entry + no bg → 0 live instances → launch allowed.
		const rt = capRuntimeRoot();
		mkdirSync(rt, { recursive: true });
		writeFileSync(registryPath(rt), JSON.stringify({ ghost: { agent: "ghost", paneId: "%dead", windowName: "x", cwd: rootTmp, sessionFile: "g.jsonl", promptFile: "p", launcherFile: "l", startedAt: new Date().toISOString() } }), "utf8");
		const { handlers } = captureHandlers();
		const ok = await invokeOk(handlers["agents:new"], "cap-dead");
		expect(ok).toContain("Started ad-hoc pane");
	});

	test("maxAgents=0 means unlimited", async () => {
		process.env.TMUX = "/tmp/tmux-cap4,12345,0";
		mockTmux();
		setMaxAgents(0);
		seedInstances(5, 5); // 10 running, but unlimited
		const { handlers } = captureHandlers();
		const ok = await invokeOk(handlers["agents:new"], "cap-unlim");
		expect(ok).toContain("Started ad-hoc pane");
	});

	test("management ops are never blocked at the cap", async () => {
		process.env.TMUX = "/tmp/tmux-cap5,12345,0";
		mockTmux();
		setMaxAgents(1);
		seedInstances(1, 0); // at cap
		const { handlers } = captureHandlers();
		// status (via the base `agents` handler) should NOT be a cap error.
		const statusRaw = await invokeRaw(handlers["agents"], "status");
		expect(statusRaw.startsWith("Error")).toBe(false);
		// stop for an unknown agent must fail with a non-cap error (still not blocked).
		const stopRaw = await invokeRaw(handlers["agents:stop"], "cap-x");
		expect(stopRaw.startsWith("Error")).toBe(true);
		expect(stopRaw).not.toContain("running agent instances");
	});
});
