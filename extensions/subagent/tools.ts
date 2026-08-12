import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	sessionKey: Type.Optional(Type.String({ description: "Optional lane id for resuming a bg (non-pane) agent across calls. Omit for a fresh one-shot lane; same key + agent => same persisted pi session. Ignored for pane agents." })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	sessionKey: Type.Optional(Type.String({ description: "Optional lane id for resuming a bg (non-pane) agent across calls. Omit for a fresh one-shot lane; same key + agent => same persisted pi session. Ignored for pane agents." })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "project" (nearest project .pi/agents plus .claude/agents). Use "both" to include user-level agents from ~/.pi/agent/agents and ~/.claude/agents too.',
	default: "project",
});

export const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution. Dispatch uses a flat worker pool capped at maxConcurrency; caller does not need to split." })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: false.", default: false }),
	),
	// spec 002 §4.1 — round 2 + round 3 ad-hoc dispatch fields:
	pane: Type.Optional(
		Type.Boolean({
			description:
				"Override pane-vs-bg for this dispatch. Ad-hoc defaults to true (pane); discovered agents keep their frontmatter pane flag when omitted. See § 4.4 for the strict-precedence resolution.",
		}),
	),
	systemPrompt: Type.Optional(
		Type.String({
			description:
				"Inline system prompt body joined with systemPromptFiles at spawn time. Mutually independent of agent frontmatter; ignored when the name resolves to a discovered agent.",
		}),
	),
	systemPromptFiles: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Paths to markdown files whose contents are joined with systemPrompt via composeAgentPrompt (spec 001 semantics). Paths resolve relative to the calling session's cwd. Ignored when the name resolves to a discovered agent.",
		}),
	),
	taskFile: Type.Optional(
		Type.String({
			description:
				"Path to a file whose contents become the task. Overrides `task` when both are provided. Resolves relative to the calling session's cwd.",
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description:
				"Override the cwd for fragment resolution and pane spawn. Absolute path; used both as the base for `path.resolve` when reading fragments and as the pane's cwd for `tmux split-window -c`. Default: ctx.cwd.",
		}),
	),
	// Round 3 additions:
	model: Type.Optional(
		Type.String({
			description:
				"Override agent.model at call time. Same shape as the frontmatter `model` field. Falls through to the parent session's model if omitted.",
		}),
	),
	replace: Type.Optional(
		Type.Boolean({
			description:
				"Compose-mode override for ad-hoc dispatch. true → composeAgentPrompt with mode: 'replace' (last non-empty fragment becomes canonical, earlier fragments dropped). false / omitted → mode: 'append' (default).",
		}),
	),
	passthroughArgs: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Unrecognized --flag values forwarded verbatim to the spawned pi argv. The launcher script appends these after the recognized flags. Used for pi options not yet first-classed in the dispatcher.",
		}),
	),
	sessionKey: Type.Optional(
		Type.String({
			description:
				"For bg (non-pane) agents only, single mode. Optional lane id used as the resumed pi session file name; omit for a fresh one-shot lane. Use a stable workflow-scoped id like 'review-issue-123' when you want continuity. Ignored for pane agents (panes already persist via their own session file).",
		}),
	),
	forceSpawn: Type.Optional(
		Type.Boolean({
			description:
				"For pane-mode agents only. When true and a live pane exists, the call errors instead of reusing it. When no live pane exists, the previous session file is archived before launch so the next pane starts fresh. Omit/false resumes or reuses the existing pane session.",
			default: false,
		}),
	),
	resumeSession: Type.Optional(
		Type.String({
			description:
				"For pane-mode agents only. Restore an archived pane session before launching. Use 'latest'/'latest-archived' or an archived session filename/path from sessions/archived. Cannot be combined with forceSpawn.",
		}),
	),
});

export const GetSubagentResultParams = Type.Object({
	taskId: Type.Optional(Type.String({ description: "Persistent pane task ID to retrieve" })),
	agent: Type.Optional(Type.String({ description: "Persistent pane agent name; selects that agent's latest task when taskId is omitted" })),
	wait: Type.Optional(Type.Boolean({ description: "Poll for completion until timeout before returning", default: false })),
	waitFor: Type.Optional(StringEnum(["completion", "idle"] as const, { description: "Wait target when wait=true. completion polls task status; idle waits for pane bridge isIdle=true after an observed busy state and reports never-busy distinctly.", default: "completion" })),
	timeoutMs: Type.Optional(Type.Number({ description: "Maximum wait time when wait=true", default: 30000 })),
	verbose: Type.Optional(Type.Boolean({ description: "Include registry and artifact paths", default: false })),
});

export const WaitForSubagentIdleParams = Type.Object({
	agent: Type.String({ description: "Persistent pane agent name to wait for" }),
	timeoutMs: Type.Optional(Type.Number({ description: "Maximum wait time for isIdle=true after an observed busy state; returns never-busy if pane never leaves idle", default: 30000 })),
});

export const SteerSubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Persistent pane agent name" })),
	taskId: Type.Optional(Type.String({ description: "Task ID whose agent should be steered" })),
	message: Type.String({ description: "Steering message to send" }),
	deliverAs: Type.Optional(StringEnum(["steer", "send", "follow-up"] as const, { description: "Bridge delivery mode", default: "steer" })),
});

export const StopSubagentParams = Type.Object({
	agent: Type.String({ description: "Persistent pane agent name to stop" }),
});

export const CompleteSubagentParams = Type.Object({
	status: StringEnum(["completed", "blocked", "failed"] as const, { description: "Final task status" }),
	summary: Type.String({ description: "1-3 sentence result summary" }),
	filesChanged: Type.Optional(Type.Array(Type.String(), { description: "Changed files, or empty if none" })),
	validation: Type.Optional(Type.Array(Type.String(), { description: "Validation performed, or empty if none" })),
	notes: Type.Optional(Type.String({ description: "Optional concise notes" })),
});

/**
 * Restricted exploratory delegation. Mirrors the single-mode shape of
 * `subagent` but deliberately omits `tasks`, `chain`, `agentScope`,
 * `sessionKey`, `forceSpawn`, and `resumeSession` — child dev agents should
 * think "ask scout to map an unknown area", not "manage an agent fleet".
 */
export const DelegateSubagentParams = Type.Object({
	agent: Type.String({
		description:
			"Name of the child agent to delegate to. Must be listed in the caller's allowed-subagents frontmatter; unknown or unlisted targets fail with an explicit inventory error.",
	}),
	task: Type.String({
		description:
			"Standalone task for the child. Include every fact and constraint the child needs — parent conversation context is not shared. Use only for context-protecting exploratory or reconnaissance work; read exact files yourself before editing.",
	}),
	cwd: Type.Optional(
		Type.String({
			description: "Optional working directory for the child process. Defaults to the caller's cwd.",
		}),
	),
});
