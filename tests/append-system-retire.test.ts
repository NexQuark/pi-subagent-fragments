/**
 * spec 005 R2 — retire the APPEND_SYSTEM.md channel.
 *
 * package.json must have no `pi.appendSystem`, no postinstall/preuninstall
 * referencing append-system, and the vendored `scripts/append-system.mjs`
 * must be gone from the shipped tree.
 *
 * RED: package.json still declares `pi.appendSystem` and the
 * postinstall/preuninstall scripts, and scripts/append-system.mjs exists.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const ROOT = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

describe("spec 005 R2 — APPEND_SYSTEM.md retired", () => {
	test("package.json has no pi.appendSystem", () => {
		expect(pkg.pi?.appendSystem).toBeUndefined();
	});

	test("no install/uninstall script references append-system", () => {
		const scripts = pkg.scripts ?? {};
		const values = Object.entries(scripts).map(([k, v]) => `${k}:${String(v)}`).join("\n");
		expect(values).not.toContain("append-system");
		expect(values).not.toContain("append_system");
	});

	test("scripts/append-system.mjs is removed from the tree", () => {
		expect(existsSync(join(ROOT, "scripts", "append-system.mjs"))).toBe(false);
	});
});
