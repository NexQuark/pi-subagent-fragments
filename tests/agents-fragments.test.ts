import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverAgents } from "../extensions/subagent/agents.js";

// NOTE: The test suite uses bun's `mock.module` to replace
// `@earendil-works/pi-coding-agent` with a simplified line-based parser
// (see tests/preload.ts). That mock does NOT understand multi-line YAML
// block lists — it treats `systemPromptFragments:` as a top-level key
// with empty-string value and ignores subsequent indented `- ./x.md`
// lines. We therefore express fragment lists as inline YAML arrays in
// the agent frontmatter. The production YAML parser handles both shapes
// identically, so this only affects test fixtures.

const rootTmp = join(import.meta.dir, "..", "..", "..", "tmp", "pi-agents-fragments-tests");
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

function writeFragment(dir: string, name: string, content: string): string {
	mkdirSync(dir, { recursive: true });
	const filePath = join(dir, name);
	writeFileSync(filePath, content, "utf8");
	return filePath;
}

function writeAgent(dir: string, name: string, frontmatter: string, body: string): string {
	mkdirSync(dir, { recursive: true });
	const filePath = join(dir, name + ".md");
	writeFileSync(
		filePath,
		`---
${frontmatter}
---

${body}
`,
		"utf8",
	);
	return filePath;
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

test("agent with no fragments leaves systemPrompt equal to body", () => {
	const home = process.env.HOME!;
	const dir = join(home, ".pi", "agent", "agents");
	writeAgent(
		dir,
		"plain",
		"name: plain\ndescription: plain agent",
		"You are a plain agent.",
	);

	const agents = discoverAgents(process.env.HOME!, "user").agents;
	const plain = agents.find((a) => a.name === "plain");
	expect(plain).toBeDefined();
	expect(plain!.systemPrompt).toBe("You are a plain agent.");
	expect(plain!.systemPromptFragments).toBeUndefined();
	expect(plain!.systemPromptMode ?? "append").toBe("append");
});

test("agent with single fragment joins it before the body", () => {
	const home = process.env.HOME!;
	const agentDir = join(home, ".pi", "agent", "agents");
	const fragDir = join(agentDir, "fragments");
	writeFragment(fragDir, "base.md", "BASE-CONTENT");
	writeAgent(
		agentDir,
		"with-fragment",
		`name: with-fragment
description: has one fragment
systemPromptFragments: ["./fragments/base.md"]`,
		"BODY-CONTENT",
	);

	const agents = discoverAgents(home, "user").agents;
	const a = agents.find((x) => x.name === "with-fragment");
	expect(a).toBeDefined();
	expect(a!.systemPromptFragments).toEqual(["./fragments/base.md"]);
	expect(a!.systemPromptMode ?? "append").toBe("append");
	expect(a!.systemPrompt).toBe(`BASE-CONTENT\n\n---\n\nBODY-CONTENT`);
});

test("agent with multiple fragments joins them in declared order before body", () => {
	const home = process.env.HOME!;
	const agentDir = join(home, ".pi", "agent", "agents");
	const fragDir = join(agentDir, "fragments");
	writeFragment(fragDir, "a.md", "A");
	writeFragment(fragDir, "b.md", "B");
	writeFragment(fragDir, "c.md", "C");
	writeAgent(
		agentDir,
		"multi",
		`name: multi
description: multiple fragments
systemPromptFragments: ["./fragments/a.md", "./fragments/b.md", "./fragments/c.md"]`,
		"END",
	);

	const a = discoverAgents(home, "user").agents.find((x) => x.name === "multi");
	expect(a).toBeDefined();
	expect(a!.systemPrompt).toBe(`A\n\n---\n\nB\n\n---\n\nC\n\n---\n\nEND`);
});

test("missing fragment file fails agent load with a clear error", () => {
	const home = process.env.HOME!;
	const agentDir = join(home, ".pi", "agent", "agents");
	writeAgent(
		agentDir,
		"bad",
		`name: bad
description: references a missing fragment
systemPromptFragments: ["./fragments/does-not-exist.md"]`,
		"BODY",
	);

	expect(() => discoverAgents(home, "user")).toThrow(/does-not-exist\.md/);
});

test("empty fragment file is treated as empty (no double separator)", () => {
	const home = process.env.HOME!;
	const agentDir = join(home, ".pi", "agent", "agents");
	const fragDir = join(agentDir, "fragments");
	writeFragment(fragDir, "empty.md", "");
	writeAgent(
		agentDir,
		"empty-frag",
		`name: empty-frag
description: empty fragment
systemPromptFragments: ["./fragments/empty.md"]`,
		"BODY",
	);

	const a = discoverAgents(home, "user").agents.find((x) => x.name === "empty-frag");
	expect(a).toBeDefined();
	expect(a!.systemPrompt).toBe("BODY");
});

test("systemPromptMode=replace is accepted and produces identical output to append", () => {
	const home = process.env.HOME!;
	const agentDir = join(home, ".pi", "agent", "agents");
	const fragDir = join(agentDir, "fragments");
	writeFragment(fragDir, "f.md", "F");
	writeAgent(
		agentDir,
		"replace-mode",
		`name: replace-mode
description: replace mode
systemPromptMode: replace
systemPromptFragments: ["./fragments/f.md"]`,
		"BODY",
	);

	const a = discoverAgents(home, "user").agents.find((x) => x.name === "replace-mode");
	expect(a).toBeDefined();
	expect(a!.systemPromptMode).toBe("replace");
	expect(a!.systemPrompt).toBe(`F\n\n---\n\nBODY`);
});

test("kebab-case and camelCase systemPromptFragments keys are both accepted", () => {
	const home = process.env.HOME!;
	const agentDir = join(home, ".pi", "agent", "agents");
	const fragDir = join(agentDir, "fragments");
	writeFragment(fragDir, "k.md", "K");
	writeFragment(fragDir, "c.md", "C");

	writeAgent(
		agentDir,
		"kebab",
		`name: kebab
description: kebab key
system-prompt-fragments: ["./fragments/k.md"]`,
		"BODY",
	);
	writeAgent(
		agentDir,
		"camel",
		`name: camel
description: camel key
systemPromptFragments: ["./fragments/c.md"]`,
		"BODY",
	);

	const agents = discoverAgents(home, "user").agents;
	expect(agents.find((x) => x.name === "kebab")!.systemPrompt).toBe(`K\n\n---\n\nBODY`);
	expect(agents.find((x) => x.name === "camel")!.systemPrompt).toBe(`C\n\n---\n\nBODY`);
});

test("unknown systemPromptMode value falls back to append with a warning", () => {
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
	try {
		const home = process.env.HOME!;
		const agentDir = join(home, ".pi", "agent", "agents");
		writeAgent(
			agentDir,
			"badmode",
			`name: badmode
description: bad mode value
systemPromptMode: enrage`,
			"BODY",
		);
		const a = discoverAgents(home, "user").agents.find((x) => x.name === "badmode");
		expect(a).toBeDefined();
		expect(a!.systemPromptMode ?? "append").toBe("append");
		expect(a!.systemPrompt).toBe("BODY");
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings[0]).toMatch(/enrage/);
	} finally {
		console.warn = originalWarn;
	}
});