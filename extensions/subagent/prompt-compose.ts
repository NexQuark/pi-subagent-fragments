/**
 * Pure helper for composing a subagent's effective system prompt from a
 * body string and zero or more fragment strings.
 *
 * This module deliberately has no I/O and no side effects: it operates on
 * already-loaded strings so it is trivially unit-testable in isolation,
 * and so the same join rule can be re-used by spawn-time code paths and
 * (in v2) by runtime-switching code without duplicating logic.
 *
 * See specs/001-multi-prompt-injection.md for the full design.
 */

export type SystemPromptMode = "append" | "replace";

export const DEFAULT_PROMPT_SEPARATOR = "\n\n---\n\n";

export interface ComposeAgentPromptInput {
	body: string;
	fragments: string[];
	mode: SystemPromptMode;
	/** Defaults to DEFAULT_PROMPT_SEPARATOR. */
	separator?: string;
}

/**
 * Join fragments and body into a single prompt string.
 *
 * v1 invariant: both `"append"` and `"replace"` modes produce identical
 * output. The `mode` argument is accepted and recorded by callers so that
 * future versions can differentiate behavior without changing the
 * signature. See spec § 11 (Deferred features, v2) for what v2 plans to
 * do with this distinction.
 */
export function composeAgentPrompt(input: ComposeAgentPromptInput): string {
	const sep = input.separator ?? DEFAULT_PROMPT_SEPARATOR;
	const parts = [...input.fragments, input.body]
		.map((s) => (typeof s === "string" ? s.trim() : ""))
		.filter((s) => s.length > 0);
	return parts.join(sep);
}