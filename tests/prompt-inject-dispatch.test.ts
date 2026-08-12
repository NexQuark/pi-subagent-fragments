/**
 * spec 003 PR 11 — before_agent_start hook consumption + child-session
 * one-shot behavior (reviewer-mandated red tests).
 *
 * The write side (`/agents:inject`) now stores `{ mode, fragments }` only;
 * the hook side composes the final effective prompt against the REAL
 * `event.systemPrompt` (never `findAgent.systemPrompt` — launch config lacks
 * the pane.ts fragment composition, reviewer F2), pushes history ON APPLY,
 * and unlinks the state file one-shot.
 *
 * RED: prompt-inject.ts lacks `consumeInjectionState` / `readInjectionState` /
 * `installPendingInjection` / `registerInjectionHook`, and `InjectionState`
 * still uses `effective` not `fragments` → these tests fail to compile.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	installPendingInjection,
	registerInjectionHook,
	readInjectionState,
	writeInjectionState,
} from "../extensions/subagent/prompt-inject.js";
import { PromptHistory, promptHistoryPathFor } from "../extensions/subagent/prompt-history.js";

const tmpDirs: string[] = [];
function tempRoot(tag: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pi-inject-${tag}-`));
	tmpDirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of tmpDirs) rmSync(dir, { force: true, recursive: true });
});

// --- helper: capture a before_agent_start handler from registerInjectionHook
type HookHandler = (event: { systemPrompt: string }, ctx: { sessionManager: { getSessionName: () => string } }) => Promise<{ systemPrompt: string } | undefined>;

function captureInjectionHook(runtimeRoot: string): { handlers: Map<string, HookHandler>; pi: any; invoke: (sessionName: string, systemPrompt: string) => Promise<{ systemPrompt: string } | undefined> } {
	const handlers = new Map<string, HookHandler>();
	const pi = { on: (name: string, handler: HookHandler) => handlers.set(name, handler) };
	registerInjectionHook(pi as any, { runtimeRootForContext: () => runtimeRoot });
	const handler = handlers.get("before_agent_start")!;
	expect(handler).toBeDefined();
	return {
		handlers,
		pi,
		invoke: (sessionName: string, systemPrompt: string) =>
			handler({ systemPrompt }, { sessionManager: { getSessionName: () => sessionName } }),
	};
}

describe("inject hook consume (spec 003 PR 11)", () => {
	test("no pending state → installPendingInjection returns null (no-op)", async () => {
		const rt = tempRoot("none");
		expect(await installPendingInjection({ runtimeRoot: rt, sessionName: "ghost", eventSystemPrompt: "BASE" })).toBeNull();
	});

	test("--replace installs the fragment verbatim (current discarded)", async () => {
		const rt = tempRoot("replace");
		await writeInjectionState(rt, "agentA", { mode: "replace", fragments: ["NEW"] });
		const res = await installPendingInjection({ runtimeRoot: rt, sessionName: "agentA", eventSystemPrompt: "BASE" });
		expect(res?.systemPrompt).toBe("NEW");
	});

	test("--append uses event.systemPrompt (real current), NOT launch config (F2)", async () => {
		const rt = tempRoot("append");
		await writeInjectionState(rt, "agentA", { mode: "append", fragments: ["B"] });
		const res = await installPendingInjection({ runtimeRoot: rt, sessionName: "agentA", eventSystemPrompt: "A" });
		expect(res?.systemPrompt).toBe("A\n\nB");
	});

	test("applying consumes the state one-shot (file unlinked, A5 consumed marker)", async () => {
		const rt = tempRoot("consume");
		await writeInjectionState(rt, "agentA", { mode: "replace", fragments: ["NEW"] });
		expect(await readInjectionState(rt, "agentA")).not.toBeNull();
		await installPendingInjection({ runtimeRoot: rt, sessionName: "agentA", eventSystemPrompt: "BASE" });
		expect(await readInjectionState(rt, "agentA")).toBeNull();
	});

	test("hook on-apply pushes history with real prev = event.systemPrompt (test b)", async () => {
		const rt = tempRoot("hist");
		await writeInjectionState(rt, "agentA", { mode: "append", fragments: ["X"] });
		await installPendingInjection({ runtimeRoot: rt, sessionName: "agentA", eventSystemPrompt: "BASE" });
		const hist = new PromptHistory(promptHistoryPathFor(rt, "agentA"));
		const list = hist.list();
		expect(list.length).toBe(1);
		expect(list[0]!.prev).toBe("BASE");
		expect(list[0]!.new).toBe("BASE\n\nX");
		expect(list[0]!.mode).toBe("append");
	});

	test("reviewer-mandated child-session: hook fires + consumes + 2nd turn no re-inject", async () => {
		const rt = tempRoot("child");
		const hook = captureInjectionHook(rt);
		await writeInjectionState(rt, "childAgent", { mode: "append", fragments: ["SURGEON"] });
		// 1st turn: hook fires for the child session, injects, consumes.
		const first = await hook.invoke("childAgent", "child-base");
		expect(first?.systemPrompt).toBe("child-base\n\nSURGEON");
		expect(await readInjectionState(rt, "childAgent")).toBeNull();
		// 2nd turn: state is gone → no re-inject.
		const second = await hook.invoke("childAgent", "child-base\n\nSURGEON");
		expect(second).toBeUndefined();
	});

	test("A1: hook keyed by session name — other session untouched", async () => {
		const rt = tempRoot("key");
		await writeInjectionState(rt, "childA", { mode: "replace", fragments: ["A-PROMPT"] });
		const hook = captureInjectionHook(rt);
		// Invoke for a different session name → no-op, childA state intact.
		const res = await hook.invoke("childB", "B-base");
		expect(res).toBeUndefined();
		expect(await readInjectionState(rt, "childA")).not.toBeNull();
	});

	test("test (a): two sequential --add accumulate (current grows)", async () => {
		const rt = tempRoot("accum");
		const hook = captureInjectionHook(rt);
		await writeInjectionState(rt, "agentA", { mode: "add", fragments: ["A"] });
		const first = await hook.invoke("agentA", "BASE");
		expect(first?.systemPrompt).toBe("BASE\n\nA");
		// 2nd add builds on the applied result (what the agent now has).
		await writeInjectionState(rt, "agentA", { mode: "add", fragments: ["B"] });
		const second = await hook.invoke("agentA", "BASE\n\nA");
		expect(second?.systemPrompt).toBe("BASE\n\nA\n\nB");
		expect(second!.systemPrompt.length).toBeGreaterThan(first!.systemPrompt.length);
	});

	test("rollback state installs the restored prompt verbatim (test b)", async () => {
		const rt = tempRoot("roll");
		await writeInjectionState(rt, "agentA", { mode: "rollback", fragments: ["BASE"] });
		const res = await installPendingInjection({ runtimeRoot: rt, sessionName: "agentA", eventSystemPrompt: "BASE\n\nX" });
		expect(res?.systemPrompt).toBe("BASE");
	});
});
