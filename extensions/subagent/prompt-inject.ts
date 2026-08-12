/**
 * spec 003 — runtime prompt injection core.
 *
 * `composeInjection` is the pure composition helper shared by the
 * `/agents:inject` write side and any future callers. It operates on
 * already-resolved sources (the parser's `tryResolveAsFile` reads file
 * content), so it has no I/O and is trivially unit-testable in isolation.
 *
 * `injectStatePathFor` is the SINGLE shared path helper between the write
 * side (`/agents:inject`) and the read side (the `before_agent_start`
 * hook). Per spec 003 round 1 review A3 (PR8-E3 regression guard), no
 * duplicated path construction.
 */

import { join } from "node:path";
import { safeFileName } from "./names.js";
import { composeAgentPrompt, DEFAULT_PROMPT_SEPARATOR } from "./prompt-compose.js";
import type { AdhocSystemSource } from "./agents-command.js";

export type InjectMode = "replace" | "append" | "add";

export interface InjectComposeInput {
	mode: InjectMode;
	/** R2 grammar system sources, already resolved (files carry content). */
	sources: AdhocSystemSource[];
	/** Current effective system prompt of the target (for append/add). */
	current?: string;
}

export interface InjectComposeResult {
	/** Fully composed effective prompt (what the hook installs). */
	effective: string;
	/** Previous effective prompt (for history push), if any. */
	prev: string | undefined;
	/** UTF-8 byte length of `effective`. */
	bytes: number;
}

/**
 * Compose the new effective prompt from the mode + resolved sources.
 *
 * spec 003 §4.1 / round 1 review OQ3 + A2: `--append` and `--add` are
 * ALIASES in v1 — both compose `current + separator + new`. `--replace`
 * is `new` only (discards current). When `current` is absent (no prior
 * prompt), append/add degrade to `new` with no leading separator.
 */
export function composeInjection(input: InjectComposeInput): InjectComposeResult {
	const fragments = input.sources.map((s) => (s.type === "inline" ? s.value : s.content));
	const newPart = composeAgentPrompt({ body: "", fragments, mode: "append" });
	let effective: string;
	let prev: string | undefined;
	switch (input.mode) {
		case "replace":
			effective = newPart;
			prev = undefined;
			break;
		case "append":
		case "add":
			effective = input.current ? `${input.current}${DEFAULT_PROMPT_SEPARATOR}${newPart}` : newPart;
			prev = input.current;
			break;
	}
	return { effective, prev, bytes: Buffer.byteLength(effective, "utf-8") };
}

/**
 * Single shared state-file path for a pending injection. Written by the
 * `/agents:inject` handler, consumed (unlinked) one-shot by the
 * `before_agent_start` hook. Lives under the session runtime dir (OQ2).
 */
export function injectStatePathFor(runtimeRoot: string, agentName: string): string {
	return join(runtimeRoot, "inject", `${safeFileName(agentName)}.json`);
}

export interface InjectionState {
	mode: "replace" | "append" | "add" | "rollback";
	effective: string;
	queuedAt: string;
	queuedBy: string | null;
}

/**
 * Write a pending injection state file (write side of the hook contract).
 * The `before_agent_start` hook reads and consumes it one-shot. Lives
 * beside the pane registry under the session runtime dir (OQ2/A3).
 */
export async function writeInjectionState(
	runtimeRoot: string,
	agentName: string,
	state: Pick<InjectionState, "mode" | "effective">,
	queuedBy: string | null = null,
): Promise<string> {
	const file = injectStatePathFor(runtimeRoot, agentName);
	const { mkdir, writeFile } = await import("node:fs/promises");
	await mkdir(join(runtimeRoot, "inject"), { recursive: true });
	const full: InjectionState = {
		mode: state.mode,
		effective: state.effective,
		queuedAt: new Date().toISOString(),
		queuedBy,
	};
	await writeFile(file, JSON.stringify(full, null, 2), "utf8");
	return file;
}
