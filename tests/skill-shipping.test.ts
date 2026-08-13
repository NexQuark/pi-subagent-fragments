/**
 * spec 005 R3 — optional skill shipped, never auto-installed.
 *
 * The full usage rules ship as `skills/subagent-usage/SKILL.md`; it is
 * packaged (in package.json `files`) but NOT auto-installed by any
 * postinstall script and NOT registered/loaded by the extension at load time
 * (Pi loads skills only on explicit user request).
 *
 * RED: package.json `files` does not yet include the skill, and/or the skill
 * is referenced by the extension.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SKILL = join(ROOT, "skills", "subagent-usage", "SKILL.md");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

describe("spec 005 R3 — optional subagent-usage skill", () => {
	test("the skill file ships in the tree", () => {
		expect(existsSync(SKILL)).toBe(true);
		const frontmatter = readFileSync(SKILL, "utf8").slice(0, 400);
		expect(frontmatter).toContain("name: subagent-usage");
		expect(frontmatter).toContain("description:");
	});

	test("the skill is in package.json `files` (ships in the tarball)", () => {
		expect(pkg.files).toContain("skills/");
	});

	test("no install/uninstall script auto-installs the skill", () => {
		const scripts = Object.entries(pkg.scripts ?? {});
		for (const [k, v] of scripts) {
			expect(String(v), `${k} must not auto-install the skill`).not.toContain("skills");
		}
	});

	test("the extension does not load the skill implicitly", () => {
		// No extension source should reference the skill path (Pi loads skills
		// only on explicit request, not from extension registration).
		const indexSrc = readFileSync(join(ROOT, "extensions", "subagent", "index.ts"), "utf8");
		expect(indexSrc).not.toContain("skills/subagent-usage");
	});
});
