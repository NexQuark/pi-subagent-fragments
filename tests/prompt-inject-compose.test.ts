/**
 * spec 003 PR 10 — composeInjection + parseInjectArgs + prompt-history.
 *
 * Pure-helper tests for the runtime prompt-injection core (round 1 review
 * A1-A6 / OQ 2-5 rulings applied). Red-before-green per commit.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeInjection, injectStatePathFor } from "../extensions/subagent/prompt-inject.js";
import { PromptHistory, promptHistoryPathFor, MAX_HISTORY } from "../extensions/subagent/prompt-history.js";
import { parseInjectArgs } from "../extensions/subagent/agents-command.js";

const tmpDirs: string[] = [];
function tempDir(tag: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pi-inject-${tag}-`));
	tmpDirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of tmpDirs) rmSync(dir, { force: true, recursive: true });
});

describe("composeInjection (spec 003 §4.1 + OQ3/A2)", () => {
	test("replace: effective = new only; prev undefined", () => {
		const r = composeInjection({
			mode: "replace",
			sources: [{ type: "inline", value: "be terse" }],
			current: "old base",
		});
		expect(r.effective).toBe("be terse");
		expect(r.prev).toBeUndefined();
		expect(r.bytes).toBe(Buffer.byteLength("be terse", "utf-8"));
	});

	test("append: effective = current + separator + new (OQ3/A2)", () => {
		const r = composeInjection({
			mode: "append",
			sources: [{ type: "inline", value: "new part" }],
			current: "base prompt",
		});
		expect(r.effective).toBe("base prompt\n\n---\n\nnew part");
		expect(r.prev).toBe("base prompt");
	});

	test("add is an alias of append in v1 (OQ3/A2)", () => {
		const add = composeInjection({ mode: "add", sources: [{ type: "inline", value: "x" }], current: "base" });
		const append = composeInjection({ mode: "append", sources: [{ type: "inline", value: "x" }], current: "base" });
		expect(add.effective).toBe(append.effective);
	});

	test("append with no current → new only (no leading separator)", () => {
		const r = composeInjection({ mode: "append", sources: [{ type: "inline", value: "solo" }], current: undefined });
		expect(r.effective).toBe("solo");
	});

	test("file sources contribute content (already-resolved content)", () => {
		const r = composeInjection({
			mode: "append",
			sources: [
				{ type: "file", path: "a.md", content: "file-a" },
				{ type: "inline", value: "inline-b" },
			],
			current: "base",
		});
		expect(r.effective).toContain("file-a");
		expect(r.effective).toContain("inline-b");
	});
});

describe("parseInjectArgs (spec 003 §3.1 + OQ5/A1)", () => {
	test("parses name + bare inline source, default mode append", () => {
		const p = parseInjectArgs("reviewer \"be thorough\"", "/tmp");
		expect(p.name).toBe("reviewer");
		expect(p.mode).toBe("append");
		expect(p.sources).toEqual([{ type: "inline", value: "be thorough" }]);
	});

	test("--replace sets mode replace", () => {
		const p = parseInjectArgs("x --replace \"new\"", "/tmp");
		expect(p.mode).toBe("replace");
	});

	test("mutually exclusive: --replace + --append → error", () => {
		expect(() => parseInjectArgs("x --replace --append \"a\"", "/tmp")).toThrow(/mutually exclusive/);
	});

	test("mutually exclusive: --history + --add → error", () => {
		expect(() => parseInjectArgs("x --history --add \"a\"", "/tmp")).toThrow(/mutually exclusive/);
	});

	test("--rollback N parses N; --rollback alone defaults to 1", () => {
		expect(parseInjectArgs("x --rollback 3", "/tmp").rollback).toBe(3);
		expect(parseInjectArgs("x --rollback", "/tmp").rollback).toBe(1);
		expect(parseInjectArgs("x --rollback", "/tmp").mode).toBe("rollback");
	});

	test("--history mode; --replace + --rollback → error", () => {
		expect(parseInjectArgs("x --history", "/tmp").mode).toBe("history");
		expect(() => parseInjectArgs("x --replace --rollback", "/tmp")).toThrow(/mutually exclusive/);
	});

	// PR 11 F1: rollback N must be >= 1 (explicit guard, not the
	// ambiguous "no prior versions" path).
	test("F1: --rollback 0 / negative N → explicit error (N must be >= 1)", () => {
		expect(() => parseInjectArgs("x --rollback 0", "/tmp")).toThrow(/N must be >= 1/);
	});

	test("#<file> resolves as file source (must exist)", () => {
		const root = tempDir("parse");
		writeFileSync(join(root, "sys.md"), "system-body", "utf8");
		const p = parseInjectArgs(`x --append #sys.md`, root);
		expect(p.sources).toEqual([{ type: "file", path: "sys.md", content: "system-body" }]);
	});

	test('#"quoted" is file-or-inline', () => {
		const root = tempDir("parse");
		writeFileSync(join(root, "sys.md"), "file-body", "utf8");
		const asFile = parseInjectArgs(`x #"sys.md"`, root);
		expect(asFile.sources).toEqual([{ type: "file", path: "sys.md", content: "file-body" }]);
		const asInline = parseInjectArgs(`x #"inline text"`, root);
		expect(asInline.sources).toEqual([{ type: "inline", value: "inline text" }]);
	});

	test("--cwd is source-resolution root only (OQ5)", () => {
		const root = tempDir("parse");
		const other = tempDir("parse");
		writeFileSync(join(other, "remote.md"), "remote-body", "utf8");
		const p = parseInjectArgs(`x --cwd ${other} #remote.md`, root);
		expect(p.cwd).toBe(other);
		expect(p.sources).toEqual([{ type: "file", path: "remote.md", content: "remote-body" }]);
	});

	test("passthrough via -- separator", () => {
		const p = parseInjectArgs(`x --replace "a" -- --temperature 0.7`, "/tmp");
		expect(p.passthroughArgs).toEqual(["--temperature", "0.7"]);
	});

	test("missing #<file> throws", () => {
		const root = tempDir("parse");
		expect(() => parseInjectArgs("x #nope.md", root)).toThrow(/must be a regular file/);
	});
});

describe("prompt-history (spec 003 §3.4 + OQ2)", () => {
	const mk = () => {
		const root = tempDir("hist");
		const file = promptHistoryPathFor(root, "reviewer");
		return { root, file, hist: new PromptHistory(file) };
	};

	test("push/list round-trips; empty history is []", () => {
		const { hist } = mk();
		expect(hist.list()).toEqual([]);
		hist.push({ timestamp: "t1", mode: "replace", prev: "a", new: "b", source: null });
		expect(hist.list()).toHaveLength(1);
		expect(hist.list()[0]!.new).toBe("b");
	});

	test("get(n) is 1-indexed: get(1) = immediately previous", () => {
		const { hist } = mk();
		hist.push({ timestamp: "t1", mode: "append", prev: "a", new: "b", source: null });
		hist.push({ timestamp: "t2", mode: "append", prev: "b", new: "c", source: null });
		expect(hist.get(1)!.new).toBe("c");
		expect(hist.get(2)!.new).toBe("b");
		expect(hist.get(3)).toBeUndefined();
	});

	test("cap 10 evicts oldest", () => {
		const { hist } = mk();
		for (let i = 0; i < 12; i++) hist.push({ timestamp: `t${i}`, mode: "append", prev: `p${i}`, new: `n${i}`, source: null });
		expect(hist.list()).toHaveLength(MAX_HISTORY);
		expect(hist.list()[0]!.new).toBe("n2");
		expect(hist.list().at(-1)!.new).toBe("n11");
	});

	test("state path helper (A3 shared, single source)", () => {
		const root = tempDir("path");
		const p = injectStatePathFor(root, "reviewer");
		expect(p.endsWith(join("inject", "reviewer.json"))).toBe(true);
		expect(p.startsWith(root)).toBe(true);
	});
});
