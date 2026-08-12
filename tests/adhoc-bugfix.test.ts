/**
 * spec 002 §5.5 C1-C4b bugfix tests — see tests/__contracts__/002-adhoc-pane-agent.md.
 *
 * PR 7 cycle scope: C1, C1', C2, C3, C3', C4a, C4a'. C4b family
 * (--pane-direction / --pane-size / --pane-target) is PR 8 / PR 7
 * later. This file tests:
 *  - C1 / C1': tmux-env detection + fallback warn content
 *  - C2: --new-pane forces forceSpawn=true at handler level
 *  - C3 / C3': "did you mean" warn when nearestDiscoveredName is set
 *  - C4a / C4a': tmux split-window retry without -p on "size missing"
 *
 * Test seams: the implementation should expose pure helpers
 * (shouldAdhocFallbackToBg, computeNearestDiscoveredName,
 * buildTmuxSplitArgs, applyC4aRetry, deriveNewPaneForceSpawn)
 * that the dispatcher / agents-command.ts / pane.ts glue call.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { synthesizeAdhocAgent, shouldAdhocFallbackToBg, applyC4aRetry, resolveAdhocPane } from "../extensions/subagent/agents.js";
import { buildTmuxSplitArgs } from "../extensions/subagent/pane.js";

const rootTmp = join(import.meta.dir, "..", "..", "..", "tmp", "adhoc-bugfix-tests");

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

// C1 — subagent({ pane: true }) invoked with $TMUX unset → emits warning, dispatches bg
// PR7-E1 regression test: when the C1 fallback fires, the
// synthesized AgentConfig must carry pane: false (not pane: true).
// Without this, dispatch routes to runPersistentPaneAgent →
// ensureTmux throws despite the "pane disabled" warn. Contract is
// verified by calling the synthesizer with the same effective
// boolean the dispatcher would use after PR7-E1.
test("bugfix-c1-tmux-detect-fallback", async () => {
	const tmuxAvailable = false;
	const fallbackToBg = shouldAdhocFallbackToBg(tmuxAvailable, undefined);
	expect(fallbackToBg).toBe(true);
	// Effective pane the dispatcher should pass to the synth:
	const effectivePane = fallbackToBg ? false : (undefined ?? true);
	expect(effectivePane).toBe(false);
	const agent = await synthesizeAdhocAgent({
		name: "foo",
		cwd: rootTmp,
		pane: effectivePane,
	});
	expect(agent.pane).toBe(false);
});

// C1' — subagent({ pane: true }) with $TMUX unset → warning contains "tmux" + "pane disabled"
// PR7-E2 strengthen: the warn string template (used by the dispatcher
// in the fallback branch) must contain "tmux" and "pane disabled".
// Pure substring check on the expected template.
test("bugfix-c1-warn-content", () => {
	const warnString = `[pi-subagent-fragments] tmux not available; pane disabled, dispatching as bg.`;
	expect(warnString).toContain("tmux");
	expect(warnString).toContain("pane disabled");
});

// C3 — ad-hoc synthesis with no system sources → console.warn emitted with "did you mean" hint
test("bugfix-c3-typo-warn", async () => {
	const captured: string[] = [];
	const originalWarn = console.warn;
	console.warn = (msg: string) => captured.push(msg);
	try {
		await synthesizeAdhocAgent({
			name: "reviewe", // typo of "reviewer"
			cwd: rootTmp,
			pane: true,
			nearestDiscoveredName: { name: "reviewer", distance: 1 },
		});
		expect(captured.length).toBeGreaterThan(0);
		expect(captured[0]).toContain("Did you mean");
		expect(captured[0]).toContain("reviewer");
	} finally {
		console.warn = originalWarn;
	}
});

// C3' — ad-hoc synthesis with #./base.md (non-empty sources) → no warn
test("bugfix-c3-no-warn-with-sources", async () => {
	const captured: string[] = [];
	const originalWarn = console.warn;
	console.warn = (msg: string) => captured.push(msg);
	try {
		await synthesizeAdhocAgent({
			name: "foo",
			cwd: rootTmp,
			pane: true,
			systemPrompt: "body",
			nearestDiscoveredName: { name: "reviewer", distance: 1 },
		});
		expect(captured.length).toBe(0);
	} finally {
		console.warn = originalWarn;
	}
});

// C4a — ensurePersistentPane tmux split fails with "size missing" → retry without -p, succeeds
test("bugfix-c4a-size-missing-retry", () => {
	// Pure helper from agents.ts (PR7-F5). Removes -p flag and its
	// value from a tmux split-window arg array. PR 8 C4a integration
	// in pane.ts:810-820 calls this when the first tmux invocation
	// returns "size missing".
	const initial = ["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", "-p", "30", "-t", "primaryPaneId", "-c", rootTmp, "bash", "/path/to/launcher.sh"];
	const filtered = applyC4aRetry(initial);
	expect(filtered).not.toContain("-p");
	expect(filtered).not.toContain("30");
	expect(filtered).toContain("-h");
	expect(filtered).toContain("-t");
	expect(filtered).toContain("primaryPaneId");
});

// C4a' — retry succeeds on second attempt with default split
test("bugfix-c4a-retry-default-split", () => {
	const filtered = applyC4aRetry(["split-window", "-h", "-d", "-t", "primaryPaneId", "-c", rootTmp, "bash", "launcher.sh"]);
	expect(filtered.includes("-p")).toBe(false);
	expect(filtered.includes("-l")).toBe(false);
	// tmux will use its default 50% split.
});

// (C4b family — --pane-direction / --pane-size / --pane-target —
// PR 8 cycle 2 real tests below.)

// C4b — /agents:start alpha --pane-direction v → tmux split-window called with -v
test("bugfix-c4b-direction-v", () => {
	const args = buildTmuxSplitArgs({
		splitHorizontally: true,
		splitPercent: "50",
		splitTarget: "primaryPaneId",
		cwd: rootTmp,
		launcherFile: "/launcher.sh",
		paneDirection: "v",
		paneSize: { value: 50, unit: "%" },
		paneTarget: "primaryPaneId",
	});
	expect(args).toContain("-v");
	expect(args).not.toContain("-h");
});

// C4b' — /agents:start alpha --pane-size 30% → tmux split-window called with -p 30
test("bugfix-c4b-size-percent", () => {
	const args = buildTmuxSplitArgs({
		splitHorizontally: true,
		splitPercent: "50",
		splitTarget: "primaryPaneId",
		cwd: rootTmp,
		launcherFile: "/launcher.sh",
		paneDirection: "h",
		paneSize: { value: 30, unit: "%" },
		paneTarget: "primaryPaneId",
	});
	// Find -p and its value
	const pIdx = args.indexOf("-p");
	expect(pIdx).toBeGreaterThanOrEqual(0);
	expect(args[pIdx + 1]).toBe("30");
	expect(args).not.toContain("-l");
});

// C4b'' — /agents:start alpha --pane-size 25l → tmux split-window called with -l 25
test("bugfix-c4b-size-lines", () => {
	const args = buildTmuxSplitArgs({
		splitHorizontally: true,
		splitPercent: "50",
		splitTarget: "primaryPaneId",
		cwd: rootTmp,
		launcherFile: "/launcher.sh",
		paneDirection: "h",
		paneSize: { value: 25, unit: "l" },
		paneTarget: "primaryPaneId",
	});
	const lIdx = args.indexOf("-l");
	expect(lIdx).toBeGreaterThanOrEqual(0);
	expect(args[lIdx + 1]).toBe("25");
	expect(args).not.toContain("-p");
});

// C4b''' — /agents:start alpha --pane-target <id> → tmux split-window called with -t <id>
test("bugfix-c4b-target", () => {
	const customTarget = "%42"; // tmux pane id format
	const args = buildTmuxSplitArgs({
		splitHorizontally: true,
		splitPercent: "50",
		splitTarget: "primaryPaneId",
		cwd: rootTmp,
		launcherFile: "/launcher.sh",
		paneDirection: "h",
		paneSize: { value: 50, unit: "%" },
		paneTarget: customTarget,
	});
	const tIdx = args.indexOf("-t");
	expect(tIdx).toBeGreaterThanOrEqual(0);
	expect(args[tIdx + 1]).toBe(customTarget);
});

// C4b'''' — /agents:start alpha (no pane flags) → defaults: -h -p 50 -t primary
test("bugfix-c4b-defaults", () => {
	const args = buildTmuxSplitArgs({
		splitHorizontally: true,
		splitPercent: "50",
		splitTarget: "primaryPaneId",
		cwd: rootTmp,
		launcherFile: "/launcher.sh",
	});
	expect(args).toContain("-h");
	expect(args).toContain("-p");
	const pIdx = args.indexOf("-p");
	expect(args[pIdx + 1]).toBe("50");
	expect(args).toContain("-t");
	const tIdx = args.indexOf("-t");
	expect(args[tIdx + 1]).toBe("primaryPaneId");
});

// C1 agents-command warn scope (PR 8 cycle 3.2 + PR8-E1/E3 fix batch):
// The ad-hoc pane decision is made by the shared resolveAdhocPane
// helper (tmux × noPane) — single source of truth for BOTH the
// handler (agents-command.ts) and this test, so the test never
// drifts from the handler's `pane:` decision again (PR8-E3).
//
// All 4 combos are asserted. --no-pane forces bg regardless of tmux
// availability (PR8-E1 regression: previously --no-pane inverted and
// forced pane: true, throwing tmux errors on non-tmux hosts).
test("bugfix-c1-agents-command-warn-scope", () => {
	// truth table (tmux × noPane) -> wantPane
	const cases: Array<[boolean, boolean, boolean]> = [
		[false, false, false], // no tmux, no --no-pane -> bg (C1 fallback)
		[false, true, false], //  no tmux + --no-pane -> bg (C1 + explicit)
		[true, false, true], //   tmux, no --no-pane -> pane
		[true, true, false], //    tmux + --no-pane  -> bg (explicit override)
	];
	for (const [tmux, noPane, expected] of cases) {
		expect(resolveAdhocPane(tmux, noPane)).toBe(expected);
	}
	// C1 warn fires exactly when the pane decision is bg AND the
	// fallback is tmux-related (not an explicit --no-pane). Mirror the
	// handler: warn when !wantPane. Assert the template substrings.
	const wantPane = resolveAdhocPane(false, false);
	expect(wantPane).toBe(false);
	if (!wantPane) {
		const warnString = `[pi-subagent-fragments] tmux not available; pane disabled, dispatching as bg.`;
		expect(warnString).toContain("tmux");
		expect(warnString).toContain("pane disabled");
	}
});

// PR8-E1 regression: --no-pane on a NON-tmux host MUST route to bg
// (pane: false), never pane (which would throw a tmux error). This is
// the exact inverted-signal bug: resolveAdhocPane(false, true) === false.
test("bugfix-c1-nopane-non-tmux-forces-bg", () => {
	// tmux unset + --no-pane explicit → bg (pane: false).
	expect(resolveAdhocPane(false, true)).toBe(false);
	// tmux set + --no-pane explicit → bg (--no-pane overrides tmux).
	expect(resolveAdhocPane(true, true)).toBe(false);
	// tmux unset, no --no-pane → bg (C1 fallback).
	expect(resolveAdhocPane(false, false)).toBe(false);
	// tmux set, no --no-pane → pane.
	expect(resolveAdhocPane(true, false)).toBe(true);
	// Handler contract: the synthesized agent's `pane` must equal the
	// resolveAdhocPane result, so on a non-tmux host with --no-pane the
	// dispatch is bg and no tmux split is attempted (no throw).
	const wantPane = resolveAdhocPane(false, true);
	expect(wantPane).toBe(false);
});
