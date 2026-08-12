/**
 * spec 003 §3.4 — per-agent prompt version history (FIFO, cap 10).
 *
 * Stored beside the pane registry under the session runtime dir (round 1
 * review OQ2): `runtimeRoot/prompt-history/<agent>.json`. Session-scoped so
 * history dies with the parent session and never leaks across machines.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { safeFileName } from "./names.js";

export const MAX_HISTORY = 10;

export interface PromptVersion {
	timestamp: string;
	mode: "replace" | "append" | "add" | "rollback";
	prev: string;
	new: string;
	/** intercom message id, or null for ad-hoc. */
	source: string | null;
}

/** Single shared history-file path helper (round 1 review A3). */
export function promptHistoryPathFor(runtimeRoot: string, agentName: string): string {
	return join(runtimeRoot, "prompt-history", `${safeFileName(agentName)}.json`);
}

export class PromptHistory {
	constructor(private readonly file: string) {}

	push(v: PromptVersion): void {
		const arr = this.read();
		arr.push(v);
		while (arr.length > MAX_HISTORY) arr.shift();
		mkdirSync(dirname(this.file), { recursive: true });
		writeFileSync(this.file, JSON.stringify(arr, null, 2), "utf8");
	}

	/**
	 * 1-indexed, newest-first: get(1) = immediately previous (most recent)
	 * version, get(2) = the one before that, etc. (spec §3.4: `--rollback N`
	 * reverts to queue[N-1]; `--rollback 1` = immediately previous).
	 */
	get(n: number): PromptVersion | undefined {
		const arr = this.read();
		return arr[arr.length - n];
	}

	list(): PromptVersion[] {
		return this.read();
	}

	private read(): PromptVersion[] {
		try {
			return JSON.parse(readFileSync(this.file, "utf8"));
		} catch {
			return [];
		}
	}
}
