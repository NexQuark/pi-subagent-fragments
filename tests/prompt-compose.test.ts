import { describe, expect, test } from "bun:test";
import {
	composeAgentPrompt,
	DEFAULT_PROMPT_SEPARATOR,
	type SystemPromptMode,
} from "../extensions/subagent/prompt-compose.js";

describe("composeAgentPrompt", () => {
	test("empty fragments returns trimmed body", () => {
		const out = composeAgentPrompt({
			body: "  hello world  ",
			fragments: [],
			mode: "append",
		});
		expect(out).toBe("hello world");
	});

	test("empty body and empty fragments returns empty string", () => {
		const out = composeAgentPrompt({
			body: "",
			fragments: [],
			mode: "append",
		});
		expect(out).toBe("");
	});

	test("single fragment precedes body, joined with default separator", () => {
		const out = composeAgentPrompt({
			body: "BODY",
			fragments: ["FRAGMENT"],
			mode: "append",
		});
		expect(out).toBe(`FRAGMENT${DEFAULT_PROMPT_SEPARATOR}BODY`);
	});

	test("multiple fragments joined in declared order, body last", () => {
		const out = composeAgentPrompt({
			body: "B",
			fragments: ["F1", "F2", "F3"],
			mode: "append",
		});
		expect(out).toBe(`F1${DEFAULT_PROMPT_SEPARATOR}F2${DEFAULT_PROMPT_SEPARATOR}F3${DEFAULT_PROMPT_SEPARATOR}B`);
	});

	test("empty fragment strings are silently skipped (no double separator)", () => {
		const out = composeAgentPrompt({
			body: "B",
			fragments: ["F1", "", "   ", "F2"],
			mode: "append",
		});
		expect(out).toBe(`F1${DEFAULT_PROMPT_SEPARATOR}F2${DEFAULT_PROMPT_SEPARATOR}B`);
	});

	test("empty body is dropped; fragments remain joined", () => {
		const out = composeAgentPrompt({
			body: "   ",
			fragments: ["F1", "F2"],
			mode: "append",
		});
		expect(out).toBe(`F1${DEFAULT_PROMPT_SEPARATOR}F2`);
	});

	test("custom separator is honored", () => {
		const out = composeAgentPrompt({
			body: "B",
			fragments: ["F1", "F2"],
			mode: "append",
			separator: "\n\n",
		});
		expect(out).toBe("F1\n\nF2\n\nB");
	});

	test("v1: append and replace produce identical output (mode is inert)", () => {
		const modes: SystemPromptMode[] = ["append", "replace"];
		const results = modes.map((mode) =>
			composeAgentPrompt({
				body: "B",
				fragments: ["F1", "F2"],
				mode,
			}),
		);
		expect(results[0]).toBe(results[1]);
	});
});