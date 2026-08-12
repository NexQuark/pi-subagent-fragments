/**
 * spec 002 §4.6 synth tests (S1–S10) — see tests/__contracts__/002-adhoc-pane-agent.md.
 *
 * PR 6 TDD plan: one cycle (red → green → optional refactor) per S-row.
 * Each test name maps 1:1 to a row in tests/__contracts__/002.md so the
 * reviewer can audit coverage against the contract.
 *
 * Per charter §4.5: red must fail for the expected reason. S1 was
 * initially red because the stub threw "not implemented"; subsequent
 * S-rows go red with assertion mismatches against the partial
 * implementation, then turn green one at a time.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { synthesizeAdhocAgent } from "../extensions/subagent/agents.js";

const rootTmp = join(import.meta.dir, "..", "..", "..", "tmp", "adhoc-synth-tests");

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

// S1 — empty systemPrompt + no fragments → empty composed
test("synth-empty-pi", async () => {
	const agent = await synthesizeAdhocAgent({
		name: "foo",
		cwd: rootTmp,
		pane: true,
	});
	expect(agent.name).toBe("foo");
	expect(agent.pane).toBe(true);
	expect(agent.systemPrompt).toBe("");
	expect(agent.source).toBe("user");
	expect(agent.description).toContain("(ad-hoc");
});

// S2 — inline systemPrompt + no fragments → composed === systemPrompt
test("synth-inline-only", async () => {
	const agent = await synthesizeAdhocAgent({
		name: "foo",
		cwd: rootTmp,
		pane: true,
		systemPrompt: "be terse",
	});
	expect(agent.systemPrompt).toBe("be terse");
});

// S3 — systemPromptFiles[0..n] resolved relative to cwd
test("synth-fragments-cwd-relative", async () => {
	const fragDir = join(rootTmp, "frags");
	mkdirSync(fragDir, { recursive: true });
	writeFileSync(join(fragDir, "a.md"), "A-CONTENT", "utf8");
	writeFileSync(join(fragDir, "b.md"), "B-CONTENT", "utf8");
	const agent = await synthesizeAdhocAgent({
		name: "foo",
		cwd: rootTmp,
		pane: true,
		systemPromptFiles: ["./frags/a.md", "./frags/b.md"],
	});
	expect(agent.systemPrompt).toBe(`A-CONTENT\n\n---\n\nB-CONTENT`);
});

// S4 — unreadable fragment path → error naming agent + path
test("synth-fragment-unreadable-throws", async () => {
	await expect(
		synthesizeAdhocAgent({
			name: "foo",
			cwd: rootTmp,
			pane: true,
			systemPromptFiles: ["./does-not-exist.md"],
		}),
	).rejects.toThrow(/foo.*does-not-exist\.md|does-not-exist\.md.*foo/);
});

// S5 — non-regular file (e.g. directory) → error
test("synth-fragment-not-regular-throws", async () => {
	const dirAsFragment = join(rootTmp, "is-a-directory");
	mkdirSync(dirAsFragment, { recursive: true });
	await expect(
		synthesizeAdhocAgent({
			name: "foo",
			cwd: rootTmp,
			pane: true,
			systemPromptFiles: ["./is-a-directory"],
		}),
	).rejects.toThrow(/not a regular file/);
});

// S6 — `name` matching `^[A-Za-z0-9_-]+$` → accepted
test("synth-name-valid", async () => {
	const agent = await synthesizeAdhocAgent({
		name: "alpha-beta_1",
		cwd: rootTmp,
		pane: true,
	});
	expect(agent.name).toBe("alpha-beta_1");
});

// S7 — `name` containing spaces / shell metacharacters → rejected
test("synth-name-invalid-throws", async () => {
	const invalidNames = [
		"with space",
		"with;semi",
		"with|pipe",
		"with$dollar",
		"with`backtick",
		"with(paren)",
		"with{brace}",
		"with'quote'",
		'with"dquote"',
		"with\nnewline",
	];
	for (const badName of invalidNames) {
		await expect(
			synthesizeAdhocAgent({
				name: badName,
				cwd: rootTmp,
				pane: true,
			}),
		).rejects.toThrow(/invalid|Use only \[A-Za-z0-9_-\]/);
	}
});

// S8 — composed prompt goes to `systemPrompt`; original `systemPromptFiles` preserved for `/agents show`
test("synth-preserves-fragment-paths", async () => {
	const fragDir = join(rootTmp, "frags");
	mkdirSync(fragDir, { recursive: true });
	writeFileSync(join(fragDir, "x.md"), "X", "utf8");
	const agent = await synthesizeAdhocAgent({
		name: "foo",
		cwd: rootTmp,
		pane: true,
		systemPromptFiles: ["./frags/x.md"],
	});
	expect(agent.systemPrompt).toBe("X");
	expect(agent.systemPromptFragments).toEqual(["./frags/x.md"]);
});

// S9 — `mode: "replace"` → composed === last fragment + body, earlier fragments dropped (round 3)
test("synth-replace-mode", async () => {
	const fragDir = join(rootTmp, "frags");
	mkdirSync(fragDir, { recursive: true });
	writeFileSync(join(fragDir, "a.md"), "A", "utf8");
	writeFileSync(join(fragDir, "b.md"), "B", "utf8");
	const agent = await synthesizeAdhocAgent({
		name: "foo",
		cwd: rootTmp,
		pane: true,
		systemPrompt: "BODY",
		systemPromptFiles: ["./frags/a.md", "./frags/b.md"],
		replace: true,
	});
	// Earlier fragment ("A") dropped; last fragment + body kept.
	expect(agent.systemPrompt).toBe(`B\n\n---\n\nBODY`);
	expect(agent.systemPromptMode).toBe("replace");
});

// S10 — synthesizer preserves `passthroughArgs` on returned `AgentConfig` (round 3)
test("synth-passthrough-preserved", async () => {
	const agent = await synthesizeAdhocAgent({
		name: "foo",
		cwd: rootTmp,
		pane: true,
		passthroughArgs: ["--temperature", "0.7", "--no-history"],
	});
	expect((agent as unknown as { passthroughArgs?: string[] }).passthroughArgs).toEqual([
		"--temperature",
		"0.7",
		"--no-history",
	]);
});
