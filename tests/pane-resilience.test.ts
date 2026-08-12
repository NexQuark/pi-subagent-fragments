/**
 * spec 002 §5.5 C4a — see tests/__contracts__/002-adhoc-pane-agent.md.
 *
 * PR 8 cycle 3: C4a mock tmux server retry integration.
 *
 * C4a: ensurePersistentPane tmux split fails with "size missing"
 * → filter args via applyC4aRetry → retry. Second call succeeds.
 * C4a': retry succeeds with tmux's default split (no -p, no -l).
 *
 * Mock seam: setPaneExecCaptureForTests (extensions/subagent/pane.ts:89)
 * lets tests override the `tmux()` shell call to record + return
 * canned responses. Cleanup in afterEach restores the default.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { setPaneExecCaptureForTests } from "../extensions/subagent/pane.js";

const rootTmp = join(import.meta.dir, "..", "..", "..", "tmp", "pane-resilience-tests");

afterEach(() => {
	// Restore the default exec capture.
	setPaneExecCaptureForTests();
});

describe("C4a — ensurePersistentPane retry on 'size missing'", () => {
	it("bugfix-c4a-mock-tmux-retry", async () => {
		const calls: string[][] = [];
		let splitAttempts = 0;
		setPaneExecCaptureForTests(async (command, args) => {
			if (command === "tmux" && args[0] === "split-window") {
				splitAttempts++;
				calls.push(args);
				if (splitAttempts === 1) {
					// First call: tmux rejects with "size missing"
					return { code: 1, stdout: "", stderr: "size missing" };
				}
				// Second call (after retry): success
				return { code: 0, stdout: "%42", stderr: "" };
			}
			// Mock all other tmux subcommands (display-message for primary
			// pane lookup, select-pane, set-window-option, etc.).
			if (command === "tmux" && args[0] === "display-message") {
				return { code: 0, stdout: "%1", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		});

		// Import ensurePersistentPane dynamically so the test seam is
		// wired before the module's execCapture is captured.
		const { ensurePersistentPane } = await import("../extensions/subagent/pane.js");
		const { writeFileSync, mkdirSync } = await import("node:fs");
		mkdirSync(rootTmp, { recursive: true });
		writeFileSync(join(rootTmp, "AGENT_LAUNCHER.sh"), "#!/bin/sh\n", "utf8");

		// ensurePersistentPane requires $TMUX to be set; we skip that
		// by setting the env var for the test.
		process.env.TMUX = "/tmp/tmux-test-socket,12345,0";
		try {
			const agent = {
				name: "test-agent",
				description: "(ad-hoc)",
				pane: true,
				systemPrompt: "BODY",
				source: "user" as const,
				filePath: "",
			};
			await ensurePersistentPane(
				rootTmp,
				"parent-session",
				rootTmp,
				agent,
				undefined,
				undefined,
			);
		} finally {
			delete process.env.TMUX;
		}

		// Two tmux split-window calls: first fails, second succeeds.
		expect(calls.length).toBeGreaterThanOrEqual(2);
		const firstCall = calls[0]!;
		const secondCall = calls[1]!;
		// First call has -p <value> (the original auto-computed splitPercent).
		expect(firstCall).toContain("-p");
		// Second call (retry) should NOT have -p (filtered via applyC4aRetry).
		expect(secondCall).not.toContain("-p");
		// Second call's args should match applyC4aRetry(first call's args).
		const { applyC4aRetry } = await import("../extensions/subagent/agents.js");
		expect(secondCall).toEqual(applyC4aRetry(firstCall));
	});
});
