/**
 * A1 — file-lock diagnostics (red tests).
 *
 * Two diagnostic enhancements to `extensions/subagent/file-lock.ts`:
 *   1. `FileLockTimeoutError` should include the holder from the lock dir's
 *      owner.json ("held by pid <pid> on <host> since <acquiredAt>") instead
 *      of only the timeout — contention debugging relies on knowing WHO holds
 *      the lock. Backward compatible when owner.json is missing (no clause).
 *   2. Retry should use exponential backoff (base retryMs, doubling, capped at
 *      retryMs*32, plus jitter) instead of a fixed retryMs+jitter.
 *
 * RED: the timeout message has no holder clause and `backoffDelayMs` does not
 * exist. Expect 4 fail.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	backoffDelayMs,
	FileLockTimeoutError,
	isFileLockTimeoutError,
	setFileLockOptionsForTests,
	withCrossProcessFileLock,
} from "../file-lock.js";

const tmpDirs: string[] = [];
function tempDir(tag: string): string {
	const dir = mkdtempSync(join(tmpdir(), `pi-filelock-${tag}-`));
	tmpDirs.push(dir);
	return dir;
}
beforeEach(() => {
	setFileLockOptionsForTests(undefined);
});
afterAll(() => {
	for (const dir of tmpDirs) rmSync(dir, { force: true, recursive: true });
});

describe("file-lock diagnostics (A1)", () => {
	test("timeout error includes holder from owner.json (pid/host/since)", async () => {
		const filePath = join(tempDir("holder"), "target.json");
		const lockDir = `${filePath}.lock`;
		mkdirSync(lockDir, { recursive: true });
		writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: 12345, host: "holder-host", acquiredAt: 1700000000000 }), "utf8");
		// Simulate a live holder that keeps refreshing the lock mtime so it is
		// never reaped as stale before the (short) timeout fires.
		const touch = setInterval(() => {
			const now = Date.now() / 1000;
			utimesSync(lockDir, now, now);
		}, 15);
		setFileLockOptionsForTests({ staleMs: 120, retryMs: 5, timeoutMs: 80 });
		try {
			// withCrossProcessFileLock applies fileLockOptionsForTests to the
			// underlying acquire; the fn is unreachable because acquire throws.
			await expect(withCrossProcessFileLock(filePath, async () => undefined)).rejects.toThrow(/held by pid 12345 on holder-host since 1700000000000/);
		} finally {
			clearInterval(touch);
			setFileLockOptionsForTests(undefined);
		}
	});

	test("timeout error without owner.json stays backward-compatible (no holder clause)", async () => {
		const filePath = join(tempDir("noholder"), "target.json");
		const lockDir = `${filePath}.lock`;
		mkdirSync(lockDir, { recursive: true });
		const touch = setInterval(() => {
			const now = Date.now() / 1000;
			utimesSync(lockDir, now, now);
		}, 15);
		setFileLockOptionsForTests({ staleMs: 120, retryMs: 5, timeoutMs: 80 });
		try {
			await expect(withCrossProcessFileLock(filePath, async () => undefined)).rejects.toThrow(/^Timed out acquiring file lock for .* after \d+ms$/);
		} finally {
			clearInterval(touch);
			setFileLockOptionsForTests(undefined);
		}
	});

	test("backoffDelayMs doubles from base, capped at retryMs*32", () => {
		expect(backoffDelayMs(0, 100)).toBe(100);
		expect(backoffDelayMs(1, 100)).toBe(200);
		expect(backoffDelayMs(2, 100)).toBe(400);
		expect(backoffDelayMs(3, 100)).toBe(800);
		expect(backoffDelayMs(5, 100)).toBe(3200); // capped at 100*32
		expect(backoffDelayMs(10, 100)).toBe(3200); // stays capped
		expect(backoffDelayMs(0, 10)).toBe(10);
	});

	test("isFileLockTimeoutError remains a compatible guard (name check)", () => {
		const err = new FileLockTimeoutError("/x", 45_000);
		expect(isFileLockTimeoutError(err)).toBe(true);
		expect(isFileLockTimeoutError(new Error("Timed out acquiring file lock for /x after 45000ms"))).toBe(false);
		const plain = new Error("boom");
		expect(isFileLockTimeoutError(plain)).toBe(false);
	});
});
