/**
 * Agent discovery and configuration for the project-local Pi subagent extension.
 *
 * Supported locations:
 * - ~/.claude/agents/*.md         user-level Claude compatibility agents
 * - ~/.pi/agent/agents/*.md       user-level Pi agents
 * - .pi/agents/*.md               project-level Pi agents
 * - .claude/agents/*.md           project-level compatibility import
 *
 * When duplicate names exist, precedence is:
 * user .claude < user .pi < project .claude < project .pi.
 */

import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { effortFromModelId, normalizeReasoningEffort } from "./settings.js";
import { composeAgentPrompt, type SystemPromptMode } from "./prompt-compose.js";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	color?: string;
	denyTools?: string[];
	/**
	 * Allowlist for the restricted delegation tool. When non-empty the agent
	 * can call `delegate_subagent` targeting any of the listed agents; when
	 * empty/undefined the tool refuses and is denied at install time.
	 */
	allowedSubagents?: string[];
	model?: string;
	effort?: string;
	pane: boolean;
	/**
 *   Optional frontmatter fragments that are joined with the markdown body at
 *   load time to form the effective `systemPrompt`. Paths are resolved
 *   relative to the agent file's directory. See
 *   `specs/001-multi-prompt-injection.md`.
 */
	systemPromptFragments?: string[];
	/**
 *   How fragments are combined with the body. For v1 both modes produce
 *   identical output; the field is captured so v2 can differentiate
 *   semantics without changing the `AgentConfig` shape.
 */
	systemPromptMode?: SystemPromptMode;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function normalizeModel(model: unknown): string | undefined {
	if (typeof model !== "string" || model.trim().length === 0) return undefined;
	const trimmed = model.trim();
	// "anthropic/<alias>" (not a bare id) so Pi's own model resolver keeps
	// picking the newest non-dated alias in that provider as Anthropic ships
	// new generations, instead of drifting stale like the old hardcoded id.
	if (trimmed === "sonnet") return "anthropic/sonnet";
	if (trimmed.startsWith("opus")) return "claude-opus-4-5";
	if (trimmed === "haiku") return "claude-haiku-4-5";
	return trimmed;
}

/**
 * Parse the `systemPromptFragments` frontmatter (and aliases) into a
 * normalized array of fragment paths. Accepts both kebab-case and
 * camelCase keys to match the vstack frontmatter convention.
 */
function parseSystemPromptFragments(frontmatter: Record<string, unknown>): string[] {
	const keys = ["system-prompt-fragments", "systemPromptFragments"];
	for (const key of keys) {
		if (!(key in frontmatter)) continue;
		const value = frontmatter[key];
		if (Array.isArray(value)) {
			return value
				.map((p) => (typeof p === "string" ? p.trim() : ""))
				.filter(Boolean);
		}
		if (typeof value === "string") {
			return parseStringFragmentList(value);
		}
		return [];
	}
	return [];
}

/**
 * Normalize a string-encoded fragment list into an array of paths.
 *
 * Recognizes two shapes:
 *   1. Inline YAML array (when the parent frontmatter parser already
 *      stripped the surrounding `[]`): `["./a.md", "./b.md"]`
 *   2. Comma-separated paths (a user-friendly escape hatch):
 *      `./a.md, ./b.md`
 *
 * The two shapes are tried in order; only if neither matches does the
 * input fall back to treating the raw string as a single path.
 */
function parseStringFragmentList(raw: string): string[] {
	const trimmed = raw.trim();
	if (!trimmed) return [];

	// Shape 1: inline YAML list (any of `[a]`, `[a, b]`, `[ a , b ]`).
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		const inner = trimmed.slice(1, -1);
		if (!inner.trim()) return [];
		return parseStringFragmentList(inner);
	}

	// Shape 2: comma-separated list.
	if (trimmed.includes(",")) {
		return trimmed
			.split(",")
			.map((p) => p.trim().replace(/^["']|["']$/g, ""))
			.filter(Boolean);
	}

	// Fallback: single path, strip any leftover quotes.
	return [trimmed.replace(/^["']|["']$/g, "")];
}

/**
 * Parse the `systemPromptMode` frontmatter (and aliases). Unknown values
 * fall back to `"append"` with a one-time warning. Both modes produce
 * identical output in v1; see `specs/001-multi-prompt-injection.md` §11.
 */
function parseSystemPromptMode(frontmatter: Record<string, unknown>): SystemPromptMode {
	const keys = ["system-prompt-mode", "systemPromptMode"];
	for (const key of keys) {
		if (!(key in frontmatter)) continue;
		const value = frontmatter[key];
		if (typeof value !== "string") return "append";
		const normalized = value.trim().toLowerCase();
		if (normalized === "replace") return "replace";
		if (normalized === "append") return "append";
		console.warn(
			`[pi-subagent-fragments] Unknown systemPromptMode "${value}" in agent frontmatter; falling back to "append".`,
		);
		return "append";
	}
	return "append";
}

/**
 * Resolve and read each fragment path synchronously. Throws on the first
 * unreadable file so that agent load fails loudly — silent omission would
 * make debugging prompt content drift extremely painful.
 *
 * Resolution: `path.resolve(agentDir, fragmentPath)`. Paths may escape
 * `agentDir` (sibling `fragments/` directories are a legitimate common
 * layout); we deliberately keep escape policy loose in v1. See spec §3.5.
 */
function loadFragmentStrings(agentFilePath: string, fragmentPaths: string[]): string[] {
	if (fragmentPaths.length === 0) return [];
	const agentDir = path.dirname(agentFilePath);
	const out: string[] = [];
	for (const fragmentPath of fragmentPaths) {
		const resolved = path.resolve(agentDir, fragmentPath);
		try {
			const stat = fs.statSync(resolved);
			if (!stat.isFile()) {
				throw new Error(`fragment path is not a regular file: ${resolved}`);
			}
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			throw new Error(
				`[pi-subagent-fragments] Failed to read fragment "${fragmentPath}" for agent "${path.basename(agentFilePath)}": ${message}`,
			);
		}
		try {
			out.push(fs.readFileSync(resolved, "utf-8"));
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			throw new Error(
				`[pi-subagent-fragments] Failed to read fragment "${fragmentPath}" for agent "${path.basename(agentFilePath)}": ${message}`,
			);
		}
	}
	return out;
}

function parseToolList(value: unknown): string[] | undefined {
	if (typeof value === "string" && value.trim().length > 0) {
		return value
			.split(",")
			.map((tool) => tool.trim())
			.filter(Boolean);
	}
	if (Array.isArray(value)) {
		const tools = value
			.map((tool) => (typeof tool === "string" ? tool.trim() : ""))
			.filter(Boolean);
		return tools.length > 0 ? tools : undefined;
	}
	return undefined;
}

/**
 * Parse the `allowed-subagents` frontmatter (and its aliases) into a
 * normalized array. Unlike `parseToolList`, an explicit empty list is
 * preserved as `[]` so callers can distinguish "user disabled delegation"
 * from "user did not set this field". Returns undefined only when no key
 * was present at all.
 */
function parseAllowedSubagents(frontmatter: Record<string, unknown>): string[] | undefined {
	const keys = ["allowed-subagents", "allowedSubagents", "subagent-agents", "subagent_agents"];
	for (const key of keys) {
		if (!(key in frontmatter)) continue;
		const value = frontmatter[key];
		if (typeof value === "string") {
			const names = value
				.split(",")
				.map((name) => name.trim())
				.filter(Boolean);
			return names;
		}
		if (Array.isArray(value)) {
			const names = value
				.map((name) => (typeof name === "string" ? name.trim() : ""))
				.filter(Boolean);
			return names;
		}
		return [];
	}
	return undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

// spec 002 §3.3 — PR 6 cycle 1: S1 green (synth-empty-pi). Subsequent
// cycles add fragment reads, name regex, replace mode, passthrough
// preservation, C3 warn (one S-row at a time per charter §4).

const AD_HOC_NAME_RE = /^[A-Za-z0-9_-]+$/;

export interface SynthesizeAdhocAgentInput {
	name: string;
	cwd: string;
	systemPrompt?: string;
	systemPromptFiles?: string[];
	pane: boolean;
	// Round 3 additions (S9 / S10 / C3):
	replace?: boolean;
	model?: string;
	passthroughArgs?: string[];
	nearestDiscoveredName?: { name: string; distance: number };
}

export async function synthesizeAdhocAgent(input: SynthesizeAdhocAgentInput): Promise<AgentConfig> {
	if (!AD_HOC_NAME_RE.test(input.name)) {
		throw new Error(
			`[pi-subagent-fragments] Ad-hoc agent name "${input.name}" is invalid. Use only [A-Za-z0-9_-].`,
		);
	}
	const fragmentPaths = input.systemPromptFiles ?? [];
	const fragments: string[] = [];
	for (const fragmentPath of fragmentPaths) {
		const resolved = path.resolve(input.cwd, fragmentPath);
		let stat: fs.Stats;
		try {
			stat = await fs.promises.stat(resolved);
		} catch (cause) {
			throw new Error(
				`[pi-subagent-fragments] Failed to read fragment "${fragmentPath}" for ad-hoc agent "${input.name}": ${cause instanceof Error ? cause.message : String(cause)}`,
			);
		}
		if (!stat.isFile()) {
			throw new Error(`[pi-subagent-fragments] Ad-hoc agent "${input.name}": fragment path is not a regular file: ${resolved}`);
		}
		try {
			fragments.push(await fs.promises.readFile(resolved, "utf-8"));
		} catch (cause) {
			throw new Error(
				`[pi-subagent-fragments] Failed to read fragment "${fragmentPath}" for ad-hoc agent "${input.name}": ${cause instanceof Error ? cause.message : String(cause)}`,
			);
		}
	}
	// Round 3 / S9: replace mode keeps only the last non-empty fragment,
	// drops earlier ones. Filter here (not in composeAgentPrompt) so
	// spec 001's "reserved for v2" semantics on discovered agents
	// remain untouched (R3-E1 HIGH fix). Contract test S9 verifies.
	const effectiveFragments = input.replace && fragments.length > 0
		? fragments.slice(-1)
		: fragments;
	// Round 3 / C3: emit "did you mean" warn when synthesis has no
	// system sources AND the requested name is near a discovered
	// agent (distance ≤ 2). The dispatcher computes the nearest match
	// (computeNearestDiscoveredName at § 4.3) and passes it as the
	// typed `input.nearestDiscoveredName` field; the synthesizer does
	// not import discoverAgents itself (stays a pure function).
	// Contract test C3 + C3' verify fire / no-fire.
	if (
		fragmentPaths.length === 0 &&
		!(input.systemPrompt?.trim()) &&
		input.nearestDiscoveredName &&
		input.nearestDiscoveredName.distance <= 2
	) {
		const nearest = input.nearestDiscoveredName;
		console.warn(
			`[pi-subagent-fragments] Ad-hoc agent "${input.name}" synthesized with no system sources. Did you mean "${nearest.name}"? (existing agent file)`,
		);
	}
	const composed = composeAgentPrompt({
		body: input.systemPrompt ?? "",
		fragments: effectiveFragments,
		mode: input.replace ? "replace" : "append",
	});
	return {
		name: input.name,
		description: "(ad-hoc, ephemeral — synthesized at call time)",
		pane: input.pane,
		// Round 3: model override flows from caller through to
		// AgentConfig.model. Falls through to the parent session's
		// selectedModelForAgent if undefined. Contract test D7 verifies.
		model: input.model,
		systemPrompt: composed,
		systemPromptFragments: fragmentPaths.length > 0 ? fragmentPaths : undefined,
		systemPromptMode: input.replace ? "replace" : "append",
		source: "user",
		filePath: "",
		// Round 3 / S10: preserve passthroughArgs on the returned
		// AgentConfig so the launcher script can append unrecognized
		// --flag values to the spawned pi argv (wrapped with
		// shellQuote per spec 001 §4.7 + R3-E9).
		passthroughArgs: input.passthroughArgs && input.passthroughArgs.length > 0
			? [...input.passthroughArgs]
			: undefined,
	} as AgentConfig;
}

/**
 * spec 002 §3.8 / §4.3 — Round 3 / C1 tmux-availability helper.
 * Returns true when an ad-hoc agent with pane: true default should
 * fall back to bg dispatch because $TMUX is unset. Discovered
 * agents are NOT affected (they keep their own pane decision).
 */
export function shouldAdhocFallbackToBg(tmuxAvailable: boolean, paneOverride: boolean | undefined): boolean {
	return tmuxAvailable === false && paneOverride !== false;
}

/**
 * spec 002 §3.8 / §4.5 — Round 3 / PR8-E1 shared pane decision.
 * Resolves whether an ad-hoc agent should run in a tmux pane lane.
 * --no-pane forces bg regardless of tmux availability; otherwise a
 * missing tmux falls back to bg; otherwise pane.
 *
 * Single source of truth for BOTH the handler (agents-command.ts) and
 * the C1 warn-scope test (adhoc-bugfix.test.ts), so the test never
 * drifts from the handler's `pane:` decision again (PR8-E3).
 *
 * truth table (tmux × noPane):
 *   (false,false) -> false  bg (no tmux)
 *   (false,true ) -> false  bg (no tmux + explicit --no-pane)
 *   (true ,false) -> true   pane
 *   (true ,true ) -> false  bg (explicit --no-pane overrides tmux)
 */
export function resolveAdhocPane(tmux: boolean, noPane: boolean): boolean {
	return noPane ? false : tmux;
}

/**
 * spec 002 §3.8 / §4.3 — Round 3 / C3 nearest-name helper.
 * Computes the nearest discovered agent name by Levenshtein distance
 * (≤ 2). Returns undefined when no discovered agent is within range.
 * Used by the ad-hoc dispatcher to pass a typed
 * `input.nearestDiscoveredName` to the synthesizer so the C3
 * "did you mean" warn fires.
 */
export function computeNearestDiscoveredName(
	requestedName: string,
	discoveredAgents: ReadonlyArray<{ name: string }>,
): { name: string; distance: number } | undefined {
	let nearest: { name: string; distance: number } | undefined;
	for (const agent of discoveredAgents) {
		const d = levenshteinDistance(requestedName, agent.name);
		if (d <= 2 && (nearest === undefined || d < nearest.distance)) {
			nearest = { name: agent.name, distance: d };
		}
	}
	return nearest;
}

function levenshteinDistance(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const cur = [i];
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			cur.push(Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost));
		}
		prev = cur;
	}
	return prev[b.length];
}

/**
 * spec 002 §4.5 — Round 3 / C4a helper.
 * Pure filter that removes the `-p <N>` flag (and its value) from
 * a tmux split-window arg array. Used as the retry path when tmux
 * returns "size missing" — fall back to tmux's default 50/50 split
 * without specifying percentage. Tests in tests/adhoc-bugfix.test.ts
 * (bugfix-c4a-size-missing-retry + bugfix-c4a-retry-default-split)
 * exercise the helper in isolation; PR 8 C4a integration wires it
 * into pane.ts:810-820 tmux split-window invocation.
 */
export function applyC4aRetry(args: string[]): string[] {
	const result: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "-p") {
			i++; // skip the value following -p
			continue;
		}
		result.push(args[i]);
	}
	return result;
}

function asBoolean(value: unknown): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "true" || normalized === "yes" || normalized === "1" || normalized === "pane";
}

function loadAgentsFromDir(dir: string, source: "user" | "project", blockedSourceDirs: string[] = []): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		if (source === "project" && isSameOrDescendantOfAny(filePath, blockedSourceDirs)) {
			continue;
		}
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
		const name = asString(frontmatter.name);
		const description = asString(frontmatter.description);

		if (!name || !description) {
			continue;
		}

		const model = normalizeModel(frontmatter.model);
		const effort = normalizeReasoningEffort(frontmatter["model-reasoning-effort"] ?? frontmatter.modelReasoningEffort ?? frontmatter.effort) ?? effortFromModelId(model);

		const fragmentPaths = parseSystemPromptFragments(frontmatter);
		const mode = parseSystemPromptMode(frontmatter);
		const resolvedFragments = loadFragmentStrings(filePath, fragmentPaths);
		const composedPrompt = composeAgentPrompt({
			body,
			fragments: resolvedFragments,
			mode,
		});

		agents.push({
			name,
			description,
			color: asString(frontmatter.color),
			denyTools: parseToolList(frontmatter["deny-tools"] ?? frontmatter.denyTools ?? frontmatter.disallowedTools),
			allowedSubagents: parseAllowedSubagents(frontmatter),
			model,
			// Reasoning effort lives under different keys depending on harness
			// (Claude `effort`, OpenCode/Codex `model-reasoning-effort`). Both
			// resolve to the same display token (low|medium|high|xhigh|max).
			effort,
			pane: asBoolean(frontmatter.pane ?? frontmatter.persistentPane),
			systemPromptFragments: fragmentPaths.length > 0 ? fragmentPaths : undefined,
			systemPromptMode: mode,
			systemPrompt: composedPrompt,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function userHomeDir(): string {
	const home = process.env.HOME?.trim();
	return home ? home : homedir();
}

function userAgentSourceDirs(): string[] {
	return [
		path.join(userHomeDir(), ".claude", "agents"),
		path.join(getAgentDir(), "agents"),
	];
}

function realpathOrResolve(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

function isSameOrDescendant(candidate: string, root: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function isSameOrDescendantOfAny(candidate: string, roots: string[]): boolean {
	const realCandidate = realpathOrResolve(candidate);
	return roots.some((root) => isSameOrDescendant(realCandidate, root));
}

function findNearestProjectAgentDirs(cwd: string, blockedSourceDirs: string[]): string[] {
	const home = realpathOrResolve(userHomeDir());
	let currentDir = path.resolve(cwd);
	while (true) {
		const isHome = realpathOrResolve(currentDir) === home;
		if (isHome) return [];

		const claudeDir = path.join(currentDir, ".claude", "agents");
		const piDir = path.join(currentDir, ".pi", "agents");
		const dirs = [claudeDir, piDir]
			.filter(isDirectory)
			.filter((dir) => !isSameOrDescendantOfAny(dir, blockedSourceDirs));
		if (dirs.length > 0) return dirs;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return [];
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userAgentDirs = userAgentSourceDirs();
	const userAgentRealDirs = userAgentDirs.map(realpathOrResolve);
	const projectAgentDirs = findNearestProjectAgentDirs(cwd, userAgentRealDirs);

	const userAgents = scope === "project" ? [] : userAgentDirs.flatMap((dir) => loadAgentsFromDir(dir, "user"));
	const projectAgents =
		scope === "user" ? [] : projectAgentDirs.flatMap((dir) => loadAgentsFromDir(dir, "project", userAgentRealDirs));

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return {
		agents: Array.from(agentMap.values()).sort((a, b) => a.name.localeCompare(b.name)),
		projectAgentsDir: projectAgentDirs.length > 0 ? projectAgentDirs.join(", ") : null,
	};
}

export function formatAgentList(agents: AgentConfig[], maxItems = Number.POSITIVE_INFINITY): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
