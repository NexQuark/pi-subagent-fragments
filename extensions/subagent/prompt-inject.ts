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

import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { safeFileName } from "./names.js";
import { composeAgentPrompt, DEFAULT_PROMPT_SEPARATOR } from "./prompt-compose.js";
import { PromptHistory, promptHistoryPathFor } from "./prompt-history.js";
import type { AdhocSystemSource } from "./agents-command.js";
import type { BeforeAgentStartEvent, BeforeAgentStartEventResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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
	/** mode selector; `rollback` installs the single restored fragment verbatim. */
	mode: "replace" | "append" | "add" | "rollback";
	/** resolved source contents only — the hook composes against the real
	 *  current (`event.systemPrompt`), never launch config (reviewer F2). */
	fragments: string[];
	queuedAt: string;
	queuedBy: string | null;
}

/**
 * Write a pending injection state file (write side of the hook contract).
 * The `before_agent_start` hook reads and consumes it one-shot. Lives
 * beside the pane registry under the session runtime dir (OQ2/A3).
 *
 * PR 11: stores `{ mode, fragments }` only; the final effective prompt is
 * composed at hook-apply time against the agent's real current prompt.
 */
export async function writeInjectionState(
	runtimeRoot: string,
	agentName: string,
	state: Pick<InjectionState, "mode" | "fragments">,
	queuedBy: string | null = null,
): Promise<string> {
	const file = injectStatePathFor(runtimeRoot, agentName);
	const { mkdir, writeFile } = await import("node:fs/promises");
	await mkdir(join(runtimeRoot, "inject"), { recursive: true });
	const full: InjectionState = {
		mode: state.mode,
		fragments: state.fragments,
		queuedAt: new Date().toISOString(),
		queuedBy,
	};
	await writeFile(file, JSON.stringify(full, null, 2), "utf8");
	return file;
}

/**
 * Read a pending injection state file, or null if none. Does NOT consume.
 */
export async function readInjectionState(runtimeRoot: string, agentName: string): Promise<InjectionState | null> {
	const file = injectStatePathFor(runtimeRoot, agentName);
	const { readFile } = await import("node:fs/promises");
	try {
		return JSON.parse(await readFile(file, "utf8")) as InjectionState;
	} catch {
		return null;
	}
}

/**
 * Read + unlink a pending injection state file one-shot (A5 consumed marker).
 * Returns null when there is nothing pending.
 */
export async function consumeInjectionState(runtimeRoot: string, agentName: string): Promise<InjectionState | null> {
	const state = await readInjectionState(runtimeRoot, agentName);
	if (!state) return null;
	const { rm } = await import("node:fs/promises");
	await rm(injectStatePathFor(runtimeRoot, agentName), { force: true });
	return state;
}

/**
 * Hook-side application of a pending injection for a session.
 *
 * Composes the final effective prompt against the REAL current
 * (`event.systemPrompt` — the chained prompt as of this handler), pushes
 * the applied version to history (on-apply, reviewer PR 11), and consumes
 * the state file one-shot. Returns the `{ systemPrompt }` modifier the
 * `before_agent_start` hook returns, or null when nothing is pending.
 */
export async function installPendingInjection(input: {
	runtimeRoot: string;
	sessionName: string;
	eventSystemPrompt: string;
}): Promise<{ systemPrompt: string } | null> {
	const state = await consumeInjectionState(input.runtimeRoot, input.sessionName);
	if (!state) return null;
	// rollback installs a full restored prompt (single fragment) verbatim →
	// reuse replace semantics (new-only).
	const mode = state.mode === "rollback" ? "replace" : state.mode;
	const sources: AdhocSystemSource[] = state.fragments.map((value) => ({ type: "inline", value }));
	const composed = composeInjection({ mode, sources, current: input.eventSystemPrompt });
	// Push the APPLIED version (prev = real current, new = effective).
	const hist = new PromptHistory(promptHistoryPathFor(input.runtimeRoot, input.sessionName));
	hist.push({
		prev: input.eventSystemPrompt,
		new: composed.effective,
		mode: state.mode,
		timestamp: new Date().toISOString(),
		source: null,
	});
	return { systemPrompt: composed.effective };
}

/**
 * Hook deps for `registerInjectionHook`.
 */
export interface ToolInjectSource {
	kind: "file" | "string";
	value: string;
}

export interface ToolInjectInput {
	runtimeRoot: string;
	name: string;
	mode?: "replace" | "append" | "add" | "rollback" | "history";
	sources?: ToolInjectSource[];
	rollback?: number;
	history?: boolean;
	cwd?: string;
}

/**
 * subagent tool `inject` (spec 003 §3.6 / §4.3) — a standalone action that
 * writes the target agent's injection state (same writeInjectionState the
 * /agents:inject slash handler uses; single source of truth for the state
 * schema). The `before_agent_start` hook applies it on the target's next
 * turn. `cwd` is the source-resolution root only (OQ5), not a chdir.
 *
 * Returns the tool result text; emits the same console.warn as the handler.
 */
export async function runToolInject(input: ToolInjectInput): Promise<string> {
	const name = input.name;
	const hist = new PromptHistory(promptHistoryPathFor(input.runtimeRoot, name));

	const historyRequested = input.history === true || input.mode === "history";
	if (historyRequested) {
		const versions = hist.list();
		const lines =
			versions.length === 0
				? [`No prompt history for ${name}.`]
				: [
						"| # | mode | bytes | timestamp |",
						"|---|---|---|---|",
						...versions.map((v, i) => `| ${versions.length - i} | ${v.mode} | ${Buffer.byteLength(v.new, "utf-8")} | ${v.timestamp} |`),
				  ];
		return `# Prompt history for ${name}\n\n` + lines.join("\n");
	}

	const rollbackRequested = input.mode === "rollback" || (input.rollback !== undefined && input.rollback !== null);
	if (rollbackRequested) {
		const n = input.rollback ?? 1;
		if (n < 1) throw new Error("inject: --rollback N must be >= 1");
		const target = hist.get(n);
		if (!target) throw new Error("inject: no prior versions to roll back to");
		await writeInjectionState(input.runtimeRoot, name, { mode: "rollback", fragments: [target.prev] });
		const bytes = Buffer.byteLength(target.prev, "utf-8");
		const hlen = hist.list().length;
		console.warn(`[pi-subagent-fragments] inject: ${name} mode=rollback bytes=${bytes} history=${hlen}`);
		return `Rolled back ${name} to version ${n} (bytes=${bytes}).`;
	}

	const modeRaw = input.mode ?? "append";
	// history/rollback returned above, so the mutation mode can never be either;
	// narrow the union so writeInjectionState's mode param accepts it.
	const mode: "replace" | "append" | "add" = modeRaw === "history" || modeRaw === "rollback" ? "append" : modeRaw;
	// Resolve sources → fragments (file content read at resolution root).
	const root = input.cwd ?? process.cwd();
	const fragments = (input.sources ?? []).map((s) => {
		if (s.kind === "string") return s.value;
		const filePath = resolve(root, s.value);
		try {
			return readFileSync(filePath, "utf8");
		} catch (err) {
			const code = (err as NodeJS.ErrnoException | undefined)?.code;
			throw new Error(
				`inject: file source "${s.value}" ${code === "ENOENT" ? "not found" : "unreadable"} (resolved to "${filePath}" relative to root "${root}")`,
			);
		}
	});
	const bytes = fragments.reduce((n, f) => n + Buffer.byteLength(f, "utf-8"), 0);
	await writeInjectionState(input.runtimeRoot, name, { mode, fragments });
	const hlen = hist.list().length;
	console.warn(`[pi-subagent-fragments] inject: ${name} mode=${mode} bytes=${bytes} history=${hlen}`);
	return `Injected into ${name}. mode=${mode} bytes=${bytes} history=${hlen}`;
}

export interface InjectionHookDeps {
	/** Derive the session runtime root from the hook ctx (OQ2). */
	runtimeRootForContext: (ctx: ExtensionContext) => string;
}

/**
 * Register the `before_agent_start` injection handler. Keyed by
 * `ctx.sessionManager.getSessionName()` (round 1 review A1). Chains cleanly
 * beside the existing agent-list handler (pi calls each listener with the
 * evolving chained `event.systemPrompt`).
 *
 * Uses the pi-exported `BeforeAgentStartEvent`/`ExtensionContext` types so an
 * upstream API change is a compile-time failure, not a runtime crash (PR 11
 * F1). installPendingInjection returns null when nothing is pending; the
 * hook contract wants void in that case, so map null → undefined.
 */
export function registerInjectionHook(pi: ExtensionAPI, deps: InjectionHookDeps): void {
	pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx: ExtensionContext): Promise<BeforeAgentStartEventResult | void> => {
		const sessionName = ctx.sessionManager.getSessionName();
		if (!sessionName) return;
		const runtimeRoot = deps.runtimeRootForContext(ctx);
		const result = await installPendingInjection({
			runtimeRoot,
			sessionName,
			eventSystemPrompt: event.systemPrompt,
		});
		return result ?? undefined;
	});
}
