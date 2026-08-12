import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgents } from "../extensions/subagent/agents.js";
import {
	composeAgentPrompt,
	DEFAULT_PROMPT_SEPARATOR,
} from "../extensions/subagent/prompt-compose.js";
import {
	removePromptTempDir,
	writePromptToTempFile,
} from "../extensions/subagent/pane.js";

// This file is the spawn-time companion to tests/prompt-compose.test.ts.
// The helper itself is already covered there; here we verify that the
// two real spawn-time call sites (pane.ts and runner.ts) feed
// composeAgentPrompt correctly when they go to write the system prompt
// to disk.
//
// NOTE: We do not actually spawn a subagent pane or runner subprocess
// in this test (both require a live tmux session and a child Pi
// binary, and the runner is currently background-only). Instead we
// re-implement the exact two-line composition that each spawn site
// performs and assert the resulting file content is what we expect.

const rootTmp = join(import.meta.dir, "..", "..", "..", "tmp", "pi-agents-spawn-compose-tests");
const originalEnv = {
	HOME: process.env.HOME,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};

function resetTmp(): void {
	rmSync(rootTmp, { force: true, recursive: true });
	mkdirSync(rootTmp, { recursive: true });
}

function restoreEnv(): void {
	if (originalEnv.HOME === undefined) delete process.env.HOME;
	else process.env.HOME = originalEnv.HOME;
	if (originalEnv.PI_CODING_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalEnv.PI_CODING_AGENT_DIR;
}

beforeEach(() => {
	resetTmp();
	const home = join(rootTmp, "home");
	mkdirSync(home, { recursive: true });
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
});

afterEach(() => {
	restoreEnv();
	rmSync(rootTmp, { force: true, recursive: true });
});

describe("spawn-prompt-compose: snapshot reference", () => {
	test("reference snapshot for body + 3 fragments + append mode", () => {
		const expected = `F1${DEFAULT_PROMPT_SEPARATOR}F2${DEFAULT_PROMPT_SEPARATOR}F3${DEFAULT_PROMPT_SEPARATOR}B`;
		const actual = composeAgentPrompt({
			body: "B",
			fragments: ["F1", "F2", "F3"],
			mode: "append",
		});
		expect(actual).toBe(expected);
	});
});

describe("spawn-prompt-compose: integration with writePromptToTempFile", () => {
	test("runner.ts-style composition writes identical content to disk", async () => {
		const agentDir = join(rootTmp, "home", ".pi", "agent", "agents");
		mkdirSync(agentDir, { recursive: true });
		// Fragments live next to the agent file (relative paths resolve
		// against the agent file's directory).
		writeFileSync(join(agentDir, "alpha.md"), "ALPHA-BODY");
		writeFileSync(join(agentDir, "beta.md"), "BETA-BODY");

		writeFileSync(
			join(agentDir, "spawn-test.md"),
			`---
name: spawn-test
description: spawn integration
systemPromptFragments: ["./alpha.md", "./beta.md"]
---

AGENT-BODY
`,
			"utf8",
		);

		const loaded = discoverAgents(process.env.HOME!, "user").agents.find(
			(a) => a.name === "spawn-test",
		);
		expect(loaded).toBeDefined();

		const tmpDirs: string[] = [];
		try {
			// runner.ts shape: writePromptToTempFile(agent.name, composeAgentPrompt(...))
			const composed = composeAgentPrompt({
				body: loaded!.systemPrompt,
				fragments: [],
				mode: loaded!.systemPromptMode ?? "append",
			});
			const tmp = await writePromptToTempFile(loaded!.name, composed);
			tmpDirs.push(tmp.dir);

			const fileContent = readFileSync(tmp.filePath, "utf8");
			expect(fileContent).toBe(composed);
			expect(fileContent).toBe(loaded!.systemPrompt);
			expect(fileContent).toContain("ALPHA-BODY");
			expect(fileContent).toContain("BETA-BODY");
			expect(fileContent).toContain("AGENT-BODY");
		} finally {
			for (const dir of tmpDirs) removePromptTempDir(dir);
		}
	});

	test("pane.ts shape: composed prompt with empty fragments is the body verbatim", async () => {
		// pane.ts spawns an interactive pane — the system prompt body
		// is already composed at load time (fragments folded in by
		// agents.ts), so the spawn-time compose call passes fragments:
		// [] and must remain idempotent.
		const agentDir = join(rootTmp, "home", ".pi", "agent", "agents");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "verbatim.md"),
			`---
name: verbatim
description: no fragments
---

PLAIN BODY
`,
			"utf8",
		);

		const loaded = discoverAgents(process.env.HOME!, "user").agents.find(
			(a) => a.name === "verbatim",
		);
		expect(loaded).toBeDefined();
		expect(loaded!.systemPromptFragments).toBeUndefined();

		const composed = composeAgentPrompt({
			body: loaded!.systemPrompt,
			fragments: [],
			mode: loaded!.systemPromptMode ?? "append",
		});
		expect(composed).toBe(loaded!.systemPrompt);
		expect(composed).toBe("PLAIN BODY");
	});
});