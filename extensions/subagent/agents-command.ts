import type { ExtensionCommandContext, ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgents, formatAgentList, resolveAdhocPane, synthesizeAdhocAgent, type AgentScope } from "./agents.js";
import { activeDashboardItems, openAgentsBrowser, openTraceViewer, traceViewerItems } from "./browser.js";
import { cycleAgentDashboard } from "./dashboard-visibility.js";
import { taskNumberById } from "./task-records.js";
import { compactPath, oneLinePreview } from "./format.js";
import { ensurePersistentPane, hasSavedPaneSession, paneExists, queuePersistentPaneTask, resetPersistentPaneSession, restoreArchivedPaneSession, stopPersistentPane, tmux } from "./pane.js";
import { runSingleAgent } from "./runner.js";
import { formatTraceView, recordTraceRef, resolveTraceRecord } from "./renderers.js";
import { pollPaneCompletions, readPaneRegistry, readTaskRegistry, emitSubagentEvent } from "./tasks.js";
import { runtimeSessionId, sessionRuntimeDir } from "./settings.js";
import { assertInstanceCap } from "./instance-cap.js";
import { writeInjectionState } from "./prompt-inject.js";
import { PromptHistory, promptHistoryPathFor } from "./prompt-history.js";
import type { SingleResult, SubagentDashboardItem, SubagentDetails } from "./types.js";

type AgentCommandCompletion = { value: string; label: string; description?: string; pane?: boolean };

interface AgentsCommandDeps {
	[key: string]: any;
	pi: ExtensionAPI;
}

export function registerAgentsCommands(deps: AgentsCommandDeps): void {
	const {
		agentCommandCompletions,
		agentsArgumentCompletions,
		dashboardState,
		formatRelativeTime,
		persistRuntimeSnapshot,
		pi,
		removeDashboardAgent,
		syncDashboard,
	} = deps;
	const agentsHandler = async (args: string, ctx: ExtensionCommandContext) => {
		const parts = args.trim().split(/\s+/).filter(Boolean);
		const scopes = new Set<AgentScope>(["user", "project", "both"]);
		const command = parts[0];
		let scope: AgentScope = "both";
		let content = "";
		let messageDetails: Record<string, unknown> | undefined;

		const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		const parentThinkingLevel = pi.getThinkingLevel();
		const parentSessionId = runtimeSessionId(ctx);
		const runtimeRoot = sessionRuntimeDir(parentSessionId);
		const discovery = discoverAgents(ctx.cwd, scopes.has(parts.at(-1) as AgentScope) ? (parts.at(-1) as AgentScope) : scope);
		const findAgent = (name: string | undefined) => discovery.agents.find((candidate) => candidate.name === name);
		const sendMarkdown = (markdown: string) => {
			pi.sendMessage({ customType: "subagent-trace", content: markdown, display: true });
		};

		try {
			if (command === "start" || command === "new" || command === "resume") {
				// spec 002 §3.6 / round 3: if the name is not in the discovered
				// inventory, treat it as an ad-hoc agent. Parse the R2 grammar,
				// synthesize the AgentConfig, and dispatch (pane lane unless
				// C1 tmux fallback forces bg).
				const discoveredAgent = findAgent(parts[1]);
				if (discoveredAgent) {
					// Existing discovered-agent path (byte-identical to v0).
					const agent = discoveredAgent;
					if (!agent.pane) throw new Error(`Agent ${agent.name} is not configured for persistent panes. Add \`pane: true\` to its frontmatter to enable.`);
					// PR8-E2: --new-pane on /agents:start behaves like /agents:new
					// (stop-then-create). Spec §4.5: forceSpawn = (command === 'new'
					// || parsed.newPane). Here it's parts-level (discovered path has
					// no R2 grammar parse), so detect the trailing --new-pane token.
					const forceNewPane = resolveForceNewPane(command, parts.slice(2).includes("--new-pane"));
					const beforeRegistry = await readPaneRegistry(runtimeRoot);
					const before = beforeRegistry[agent.name];
					const hadLivePane = Boolean(before && (await paneExists(before.paneId)));
					const hadSavedSessionFlag = hasSavedPaneSession(runtimeRoot, agent.name);
					// spec 004 R6 — running instance cap. Reusing a live pane (plain
					// /agents:start) does not create a new instance, so skip the guard
					// for that case; any launch that creates/forces a fresh instance is
					// capped (both the discovered and ad-hoc paths).
					const isPureReuse = hadLivePane && command !== "new" && !forceNewPane;
					if (!isPureReuse) await assertInstanceCap(runtimeRoot, ctx.cwd);
					if (command === "new" || forceNewPane) {
						if (hadLivePane) await stopPersistentPane(runtimeRoot, agent.name);
						removeDashboardAgent(agent.name);
						await resetPersistentPaneSession(runtimeRoot, agent.name);
					} else if (command === "resume") {
						if (hadLivePane) await stopPersistentPane(runtimeRoot, agent.name);							removeDashboardAgent(agent.name);
						await restoreArchivedPaneSession(runtimeRoot, agent.name, parts[2] ?? "latest");
					}
					const pane = await ensurePersistentPane(runtimeRoot, parentSessionId, ctx.cwd, agent, parentModel, parentThinkingLevel, pi.getActiveTools());
					if (!hadLivePane || command === "new") {
						emitSubagentEvent(pi, "subagents:created", {
							mode: "pane",
							agent: agent.name,
							paneId: pane.paneId,
							runtimeRoot,
							transcriptPath: pane.sessionFile,
						});
					}
					const startLabel = command === "new" ? "Started new" : command === "resume" ? "Resumed archived" : hadLivePane ? "Reused live" : hadSavedSessionFlag ? "Resumed saved" : "Started new";
					content = `${startLabel} ${agent.name} (${pane.windowName}).\nSession: ${pane.sessionFile}`;
					messageDetails = { action: "start", agent: agent.name, sessionFile: pane.sessionFile, windowName: pane.windowName, status: startLabel };
					await persistRuntimeSnapshot(ctx, runtimeRoot);
				} else {
					// Ad-hoc path (round 3): name not in discovered inventory.
					const name = parts[1] ?? "";
					if (!name) throw new Error(`Usage: /agents:${command} <name> ...`);
					const parsed = parseAdhocArgs(parts.slice(1).join(" "), ctx.cwd);
					// PR8-E1/E3: resolveAdhocPane is the single source of truth for the
					// pane decision (tmux × noPane). --no-pane forces bg regardless
					// of tmux; missing tmux falls back to bg; otherwise pane.
					const tmuxAvailable = Boolean(process.env.TMUX);
					const wantPane = resolveAdhocPane(tmuxAvailable, parsed.noPane);
					// PR8-F6: C1 warn fires ONLY when tmux is unavailable (the
					// tmux-fallback case). A tmux host passing --no-pane is an
					// explicit bg choice and must NOT get a fake 'tmux not
					// available' message.
					if (!tmuxAvailable) {
						console.warn(`[pi-subagent-fragments] tmux not available; pane disabled, dispatching as bg.`);
					}
					// PR8-E2: forceSpawn is derived from command==='new' OR --new-pane
					// (spec §4.5). Stop an existing live pane so the relaunch is fresh.
					const forceNewPane = resolveForceNewPane(command, parsed.newPane);
					if (forceNewPane && wantPane) {
						const beforeRegistry = await readPaneRegistry(runtimeRoot);
						const before = beforeRegistry[name];
						if (before && (await paneExists(before.paneId))) {
							await stopPersistentPane(runtimeRoot, name);
							removeDashboardAgent(name);
							await resetPersistentPaneSession(runtimeRoot, name);
						}
					}
					// spec 004 R6 — running instance cap (ad-hoc always creates a new
					// instance in either lane; no reuse shortcut).
					await assertInstanceCap(runtimeRoot, ctx.cwd);
					const agent = await synthesizeAdhocAgent({
						name,
						cwd: parsed.cwd ?? ctx.cwd,
						systemPromptFiles: parsed.systemPromptSources.filter((s) => s.type === "file").map((s) => s.path),
						systemPrompt: parsed.systemPromptSources.filter((s) => s.type === "inline").map((s) => s.value).join("\n\n---\n\n"),
						pane: wantPane,
						replace: parsed.mode === "replace",
						model: parsed.model,
						passthroughArgs: parsed.passthroughArgs,
					});
					const task = parsed.userSources.map((s) => s.content ?? s.value).join("\n\n");
					if (wantPane) {
						// Pane lane: queuePersistentPaneTask (existing path).
						const queued = await queuePersistentPaneTask(
							runtimeRoot, parentSessionId, parsed.cwd ?? ctx.cwd, agent, task,
							undefined, parentModel, parentThinkingLevel, pi, pi.getActiveTools(),
							parsed.paneDirection, parsed.paneSize, parsed.paneTarget,
						);
						content = `Started ad-hoc pane ${agent.name} (${queued.sessionMode}).\nArtifacts: inbox=${queued.taskFile} completion=${queued.outboxFile}`;
						messageDetails = { action: command, agent: agent.name, taskId: queued.taskId, task, sessionMode: queued.sessionMode, cwd: parsed.cwd };
					} else {
						// PR8-E5: bg lane MUST route to runSingleAgent (bg dispatch),
						// NOT queuePersistentPaneTask (which would hit ensureTmux and
						// throw on a tmux-less host). Same pattern as the subagent
						// tool's ad-hoc recognition in index.ts: agent.pane === false
						// → runSingleAgent. Reuse runSingleAgent, never copy impl.
						const makeDetails = (results: SingleResult[]): SubagentDetails => ({ mode: "single", agentScope: "both", projectAgentsDir: undefined, results });
						const result = await runSingleAgent(
							parsed.cwd ?? ctx.cwd, runtimeRoot, [agent], agent.name, task,
							parsed.cwd ?? ctx.cwd, parentModel, parentThinkingLevel, undefined,
							pi, undefined, undefined, makeDetails,
						);
						content = `Dispatched as bg ${agent.name} (${result.sessionMode ?? "oneshot"}).\nArtifacts: transcript=${result.transcriptPath}`;
						messageDetails = { action: command, agent: agent.name, taskId: result.taskId ?? agent.name, task, sessionMode: result.sessionMode, cwd: parsed.cwd };
					}
					await persistRuntimeSnapshot(ctx, runtimeRoot);
				}
			} else if (command === "inject") {
				const parsed = parseInjectArgs(parts.slice(1).join(" "), ctx.cwd);
				const name = parsed.name;
				const registry = await readPaneRegistry(runtimeRoot);
				const entry = registry[name];
				const live = Boolean(entry && (await paneExists(entry.paneId)));

				if (parsed.mode === "history") {
					const hist = new PromptHistory(promptHistoryPathFor(runtimeRoot, name));
					const versions = hist.list();
					const lines = versions.length === 0
						? ["No prompt history for " + name + "."]
						: ["| # | mode | bytes | timestamp |", "|---|---|---|---|",
							...versions.map((v, i) => `| ${versions.length - i} | ${v.mode} | ${Buffer.byteLength(v.new, "utf-8")} | ${v.timestamp} |`)];
					content = `# Prompt history for ${name}\n\n` + lines.join("\n");
					messageDetails = { action: "inject", mode: "history", agent: name };
				} else if (parsed.mode === "rollback") {
					if (parsed.rollback < 1) throw new Error("inject: --rollback N must be >= 1");
					const hist = new PromptHistory(promptHistoryPathFor(runtimeRoot, name));
					const target = hist.get(parsed.rollback);
					if (!target) throw new Error(`inject: no prior versions to roll back to`);
					// rollback writes the restored prompt as a single fragment; the
					// hook installs it verbatim (replace semantics).
					await writeInjectionState(runtimeRoot, name, { mode: "rollback", fragments: [target.prev] });
					const bytes = Buffer.byteLength(target.prev, "utf-8");
					const hlen = hist.list().length;
					console.warn(`[pi-subagent-fragments] inject: ${name} mode=rollback bytes=${bytes} history=${hlen}`);
					content = `Rolled back ${name} to version ${parsed.rollback} (bytes=${bytes}).`;
					messageDetails = { action: "inject", mode: "rollback", agent: name, rollback: parsed.rollback };
				} else {
					// replace / append / add are MUTATIONS: they need a live pane
					// session to inject into (OQ4). history/rollback above do not.
					if (!live) {
						throw new Error(`inject: ${name || "(missing)"} has no live pane session to inject into`);
					}
					// PR 11: write side stores ONLY `{ mode, fragments }`. The final
					// effective prompt is composed at hook-apply time against the
					// agent's REAL current (`event.systemPrompt`) — never launch
					// config, which lacks the pane.ts fragment composition (F2).
					const fragments = parsed.sources.map((s) => (s.type === "inline" ? s.value : s.content));
					const bytes = fragments.reduce((n, f) => n + Buffer.byteLength(f, "utf-8"), 0);
					await writeInjectionState(runtimeRoot, name, { mode: parsed.mode, fragments });
					const hist = new PromptHistory(promptHistoryPathFor(runtimeRoot, name));
					const hlen = hist.list().length;
					console.warn(`[pi-subagent-fragments] inject: ${name} mode=${parsed.mode} bytes=${bytes} history=${hlen}`);
					content = `Injected into ${name}. mode=${parsed.mode} bytes=${bytes} history=${hlen}`;
					messageDetails = { action: "inject", mode: parsed.mode, agent: name, bytes, history: hlen };
				}
				await persistRuntimeSnapshot(ctx, runtimeRoot);
			} else if (command === "send") {
				const agent = findAgent(parts[1]);
				if (!agent) throw new Error(`Unknown agent: ${parts[1] ?? "(missing)"}`);
				if (!agent.pane) throw new Error(`Agent ${agent.name} is not configured for persistent panes. Add \`pane: true\` to its frontmatter to enable.`);
				const task = parts.slice(2).join(" ").trim();
				if (!task) throw new Error("Usage: /agents:send <name> <task>");
				const queued = await queuePersistentPaneTask(runtimeRoot, parentSessionId, ctx.cwd, agent, task, undefined, parentModel, parentThinkingLevel, pi, pi.getActiveTools());
				const sessionText = queued.sessionMode === "live" ? "reused live pane" : queued.sessionMode === "resumed" ? "resumed saved pane session" : "started new pane session";
				content = `Queued task for ${agent.name} (${sessionText}).\nArtifacts: inbox=${compactPath(queued.taskFile)} completion=${compactPath(queued.outboxFile)} transcript=${compactPath(queued.pane.sessionFile)}`;
				messageDetails = { action: "send", agent: agent.name, inboxFile: queued.taskFile, outboxFile: queued.outboxFile, taskId: queued.taskId, transcriptPath: queued.pane.sessionFile, status: sessionText };
				await persistRuntimeSnapshot(ctx, runtimeRoot);
			} else if (command === "attach") {
				const registry = await readPaneRegistry(runtimeRoot);
				const entry = registry[parts[1] ?? ""];
				if (!entry || !(await paneExists(entry.paneId))) throw new Error(`No live pane for agent: ${parts[1] ?? "(missing)"}`);
				const result = await tmux(["select-pane", "-t", entry.paneId]);
				if (result.code !== 0) throw new Error(result.stderr || result.stdout || "tmux select-pane failed");
				content = `Attached to ${entry.agent}.`;
				messageDetails = { action: "attach", agent: entry.agent };
			} else if (command === "stop") {
				const stopped = await stopPersistentPane(runtimeRoot, parts[1] ?? "");
				const stoppedAgent = stopped.agent;
				removeDashboardAgent(stoppedAgent);
				content = `Stopped ${stoppedAgent}.`;
				messageDetails = { action: "stop", agent: stoppedAgent };
				await persistRuntimeSnapshot(ctx, runtimeRoot);
			} else if (command === "collect") {
				const collected = await pollPaneCompletions(runtimeRoot, pi, false);
				content = `Collected ${collected} agent completion file${collected === 1 ? "" : "s"}.`;
				messageDetails = { action: "collect", count: collected };
				await persistRuntimeSnapshot(ctx, runtimeRoot);
			} else if (command === "status") {
				const registry = await readPaneRegistry(runtimeRoot);
				const lines = await Promise.all(
					Object.values(registry).map(async (entry) => {
						const live = await paneExists(entry.paneId);
						return `- ${entry.agent}: ${live ? "live" : "dead"} ${entry.windowName} model=${entry.model ?? "default"} lastTask=${entry.lastTaskAt ?? "never"}`;
					}),
				);
				content = [`# Persistent agent panes`, "", lines.join("\n") || "No persistent panes registered."].join("\n");
				messageDetails = { action: "status", count: lines.length };
			} else if (command === "trace") {
				const ref = parts.slice(1).join(" ").trim();
				if (!ref) throw new Error("Usage: /agents:trace <ref>");
				const records = await readTaskRegistry(runtimeRoot);
				const record = resolveTraceRecord(records, ref);
				if (!record) throw new Error(`No agent trace matched: ${ref}`);
				if (ctx.hasUI) {
					const taskNumber = taskNumberById(Object.values(records)).get(record.taskId);
					await openTraceViewer(ctx as ExtensionContext, `Trace ${recordTraceRef(record)}`, await traceViewerItems(record, taskNumber));
					return;
				}
				sendMarkdown(await formatTraceView(record, parts.includes("--verbose")));
				return;
			} else if (command === "toggle") {
				cycleAgentDashboard(dashboardState);
				syncDashboard(ctx as ExtensionContext);
				content = `Agent dashboard ${dashboardState.visible ? `shown (${dashboardState.mode})` : "hidden"}.`;
				messageDetails = { action: "toggle", status: dashboardState.visible ? `shown (${dashboardState.mode})` : "hidden" };
			} else {
				let showName: string | undefined;
				if (command === "show") {
					showName = parts[1];
					if (scopes.has(parts[2] as AgentScope)) scope = parts[2] as AgentScope;
				} else if (scopes.has(command as AgentScope)) {
					scope = command as AgentScope;
				} else if (command) {
					throw new Error(`Unknown /agents action: ${command}`);
				}

				if (ctx.hasUI) {
					await openAgentsBrowser(ctx, scope, showName, runtimeRoot, parentSessionId, parentModel, parentThinkingLevel, pi.getActiveTools(), () => activeDashboardItems(Object.values(dashboardState.items)), removeDashboardAgent);
					return;
				}

				const scopedDiscovery = discoverAgents(ctx.cwd, scope);
				if (showName) {
					const agent = scopedDiscovery.agents.find((candidate) => candidate.name === showName);
					content = agent
						? [
								`# Agent: ${agent.name}`,
								`Source: ${agent.source}`,
								`Path: ${agent.filePath}`,
								`Model: ${agent.model ?? "default"}`,
								`Deny tools: ${agent.denyTools && agent.denyTools.length > 0 ? agent.denyTools.join(", ") : "none"}`,
								`Persistent pane: ${agent.pane ? "yes" : "no"}`,
								"",
								agent.description,
								"",
								"---",
								"",
								agent.systemPrompt.trim(),
							]
							.join("\n")
						: `Unknown agent "${showName}" for scope "${scope}". Available: ${scopedDiscovery.agents
								.map((agent) => agent.name)
								.join(", ") || "none"}.`;
					messageDetails = { action: "show", agent: showName };
				} else {
					const formatted = formatAgentList(scopedDiscovery.agents);
					content = [
						`# Available agents (${scope})`,
						`Project agent dirs: ${scopedDiscovery.projectAgentsDir ?? "none"}`,
						"",
						formatted.text
							.split("; ")
							.map((line) => {
								const name = line.match(/^-?\s*([^ ]+)/)?.[1];
								const agent = scopedDiscovery.agents.find((candidate) => candidate.name === name);
								return `- ${line}${agent?.pane ? " [pane]" : ""}`;
							})
							.join("\n"),
						"",
						"Commands: `/agents show <name>`, `/agents:start <name>` (resume/reuse), `/agents:new <name>` (fresh session), `/agents:resume <name> [latest|archive-file]`, `/agents:send <name> <task>`, `/agents:attach <name>`, `/agents:stop <name>`, `/agents status`, `/agents:trace <ref>`, `/agents:toggle`. The popup's Monitor tab browses past tasks visually.",
					].join("\n");
					messageDetails = { action: "list", count: scopedDiscovery.agents.length };
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			content = `Error: ${message}`;
			messageDetails = { action: "error", error: message };
		}

		pi.sendMessage({ customType: "subagent-agents", content, details: messageDetails, display: true });
	};

	pi.registerCommand("agents", {
		description: "Agent browser and persistent pane manager.",
		getArgumentCompletions: agentsArgumentCompletions,
		handler: agentsHandler,
	});

	const paneAgentNameCompletions = (subcommand: string) => (prefix: string) => {
		const query = prefix.trimStart().toLowerCase();
		const needsPane = subcommand !== "show";
		const items = (agentCommandCompletions as AgentCommandCompletion[])
			.filter((agent) => (!needsPane || agent.pane) && (!query || agent.value.toLowerCase().startsWith(query)))
			.slice(0, 20)
			.map((agent) => ({ value: agent.value, label: agent.label, description: agent.description }));
		return items.length > 0 ? items : null;
	};

	const traceRefCompletions = (prefix: string) => {
		const query = prefix.trimStart().toLowerCase();
		const records = (Object.values(dashboardState.items) as SubagentDashboardItem[]).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		const completions = records
			.filter((item) => !query || item.taskId.toLowerCase().includes(query) || item.agent.toLowerCase().includes(query))
			.slice(0, 20)
			.map((item) => {
				const when = formatRelativeTime(item.completedAt ?? item.startedAt ?? item.updatedAt);
				const summary = oneLinePreview(item.message, 60);
				return {
					value: item.taskId,
					label: `${item.agent} · ${when}`,
					description: summary ? `${item.status} · ${summary}` : item.status,
				};
			});
		return completions.length > 0 ? completions : null;
	};

	pi.registerCommand("agents:toggle", {
		description: "Toggle the agent dashboard",
		handler: async (_args, ctx) => agentsHandler("toggle", ctx),
	});

	for (const sub of ["start", "new", "resume", "send", "attach", "stop"] as const) {
		const description =
			sub === "start" ? "Start or reuse a persistent pane: /agents:start <name>" :
			sub === "new" ? "Start a persistent pane with a fresh session: /agents:new <name>" :
			sub === "resume" ? "Restore an archived pane session: /agents:resume <name> [latest|archive-file]" :
			sub === "send" ? "Queue a task for a persistent pane: /agents:send <name> <task>" :
			sub === "attach" ? "Focus an existing agent pane: /agents:attach <name>" :
			"Stop an agent pane: /agents:stop <name>";
		pi.registerCommand(`agents:${sub}`, {
			description,
			getArgumentCompletions: paneAgentNameCompletions(sub),
			handler: async (args, ctx) => agentsHandler(`${sub} ${args}`.trim(), ctx),
		});
	}

	pi.registerCommand("agents:trace", {
		description: "View an agent trace by ref/task id: /agents:trace <ref>",
		getArgumentCompletions: traceRefCompletions,
		handler: async (args, ctx) => agentsHandler(`trace ${args}`.trim(), ctx),
	});

	pi.registerCommand("agents:inject", {
		description: "Inject a system prompt into a live agent: /agents:inject <name> [--replace|--append|--add] [<sources>...] [--rollback [N]] [--history]",
		getArgumentCompletions: paneAgentNameCompletions("inject"),
		handler: async (args, ctx) => agentsHandler(`inject ${args}`.trim(), ctx),
	});

}

// spec 002 §3.6 — R2 grammar parser for `/agents:new` and `/agents:start`.
// Pure function (modulo fs.statSync file existence checks for `#path`
// and `#"..."`/`@...` source markers). Returns a structured
// AdhocParsedArgs object that the agentsHandler new/start branches
// pass to the synthesizer.

export type AdhocSystemSource =
	| { type: "file"; path: string; content: string }
	| { type: "inline"; value: string };

export type AdhocUserSource =
	| { type: "file"; path: string; content: string }
	| { type: "inline"; value: string };

export interface InjectParsedArgs {
	name: string;
	mode: "replace" | "append" | "add" | "rollback" | "history";
	sources: AdhocSystemSource[];
	rollback: number;
	cwd?: string;
	passthroughArgs: string[];
}

export interface AdhocParsedArgs {
	name: string;
	systemPromptSources: AdhocSystemSource[];
	userSources: AdhocUserSource[];
	mode: "replace" | "append";
	model?: string;
	cwd?: string;
	paneDirection: "h" | "v";
	paneSize: { value: number; unit: "%" | "l" };
	paneTarget: "primary" | "next" | string;
	noPane: boolean;
	newPane: boolean;
	passthroughArgs: string[];
}

const RECOGNIZED_FLAGS_WITH_VALUE = new Set([
	"--model",
	"--cwd",
	"--pane-direction",
	"--pane-size",
	"--pane-target",
]);

const BARE_FLAGS = new Set(["--replace", "--no-pane", "--new-pane"]);

function isQuotedToken(token: string): boolean {
	return token.length >= 2 && token.startsWith('"') && token.endsWith('"');
}

function stripQuotes(token: string): string {
	return isQuotedToken(token) ? token.slice(1, -1) : token;
}

/**
 * Quote-aware tokenizer: whitespace splits tokens, but a `"..."` quoted
 * run is preserved as a single token (with the surrounding quotes
 * intact). Per spec 002 §3.6, quoting is not shell-escaped — the
 * parser just needs to keep quoted whitespace together so e.g.
 * `"additional user prompt"` becomes one token.
 */
function tokenizeArgs(input: string): string[] {
	const out: string[] = [];
	let current = "";
	let inQuote = false;
	for (let i = 0; i < input.length; i++) {
		const ch = input[i]!;
		if (ch === '"') {
			inQuote = !inQuote;
			current += ch;
			continue;
		}
		if (!inQuote && /\s/.test(ch)) {
			if (current.length > 0) {
				out.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (current.length > 0) out.push(current);
	return out;
}

function tryResolveAsFile(path: string, cwd: string): { type: "file"; path: string; content: string } | null {
	try {
		const resolved = require("node:path").resolve(cwd, path);
		const stat = require("node:fs").statSync(resolved);
		if (!stat.isFile()) return null;
		const content = require("node:fs").readFileSync(resolved, "utf-8");
		return { type: "file", path, content };
	} catch {
		return null;
	}
}

/**
 * spec 002 §4.5 / PR8-E2 — C2 shared force-new-pane decision.
 * forceSpawn = (command === 'new') OR (--new-pane present). Used by
 * BOTH the discovered-agent path (parts-level --new-pane detection) and
 * the ad-hoc path (parseAdhocArgs' parsed.newPane). Extracted so the
 * handler reads the flag and the test can assert it (regression for
 * PR8-E2: previously --new-pane was parsed but never consumed).
 */
export function resolveForceNewPane(command: string, newPaneFlag: boolean): boolean {
	return command === "new" || newPaneFlag;
}

export function parseAdhocArgs(args: string, cwd: string): AdhocParsedArgs {
	const tokens = tokenizeArgs(args.trim());
	const parsed: AdhocParsedArgs = {
		name: "",
		systemPromptSources: [],
		userSources: [],
		passthroughArgs: [],
	};

	let i = 0;

	// First positional token is the name.
	if (i < tokens.length && !tokens[i]!.startsWith("--")) {
		parsed.name = tokens[i]!;
		i++;
	}

	// Defaults for flag-like fields so consumers can rely on
	// consistent shape (avoids `undefined` vs `false` ambiguity).
	parsed.mode = "append";
	parsed.paneDirection = "h";
	parsed.paneSize = { value: 50, unit: "%" };
	parsed.paneTarget = "primary";
	parsed.noPane = false;
	parsed.newPane = false;

	// Walk remaining positionals + flags.
	for (; i < tokens.length; i++) {
		const token = tokens[i]!;

		// `--` separator: everything from here goes to passthroughArgs verbatim.
		if (token === "--") {
			parsed.passthroughArgs.push(...tokens.slice(i + 1));
			break;
		}

		// Recognized flags with value (--flag value).
		if (RECOGNIZED_FLAGS_WITH_VALUE.has(token)) {
			const value = i + 1 < tokens.length ? tokens[i + 1]! : "";
			i++; // consume the value
			switch (token) {
				case "--model":
					parsed.model = value;
					break;
				case "--cwd":
					parsed.cwd = value;
					break;
				case "--pane-direction":
					if (value === "h" || value === "v") parsed.paneDirection = value;
					break;
				case "--pane-size": {
					const m = value.match(/^(\d+)(%|[lL])$/);
					if (m) {
						const unit = m[2] === "%" ? "%" : "l";
						parsed.paneSize = { value: parseInt(m[1]!, 10), unit };
					}
					break;
				}
				case "--pane-target":
					if (value === "primary" || value === "next") {
						parsed.paneTarget = value;
					} else {
						parsed.paneTarget = value; // raw pane id
					}
					break;
			}
			continue;
		}

		// Bare flags (no value).
		if (BARE_FLAGS.has(token)) {
			switch (token) {
				case "--replace":
					parsed.mode = "replace";
					break;
				case "--no-pane":
					parsed.noPane = true;
					break;
				case "--new-pane":
					parsed.newPane = true;
					break;
			}
			continue;
		}

		// Unknown --flag (treat as passthrough; consume value if present).
		if (token.startsWith("--")) {
			parsed.passthroughArgs.push(token);
			// Heuristic: if next token doesn't start with -- and doesn't
			// look like a source marker, treat as flag value.
			if (i + 1 < tokens.length) {
				const next = tokens[i + 1]!;
				if (!next.startsWith("--") && !next.startsWith("#") && !next.startsWith("@") && !isQuotedToken(next)) {
					parsed.passthroughArgs.push(next);
					i++;
				}
			}
			continue;
		}

		// System source: #<unquoted> or #"<quoted>"
		if (token.startsWith("#")) {
			const value = stripQuotes(token.slice(1));
			if (token.startsWith('#"')) {
				// Quoted: try file first, else inline
				const file = tryResolveAsFile(value, cwd);
				if (file) {
					parsed.systemPromptSources.push(file);
				} else {
					parsed.systemPromptSources.push({ type: "inline", value });
				}
			} else {
				// Unquoted #<path>: must resolve to a regular file
				const file = tryResolveAsFile(value, cwd);
				if (!file) {
					throw new Error(
						`[pi-subagent-fragments] Ad-hoc agent system source "${value}" must be a regular file (resolved relative to cwd "${cwd}").`,
					);
				}
				parsed.systemPromptSources.push(file);
			}
			continue;
		}

		// User source: @<path-or-text> or "<text>"
		if (token.startsWith("@")) {
			const value = token.slice(1);
			const file = tryResolveAsFile(value, cwd);
			if (file) {
				parsed.userSources.push(file);
			} else {
				// Per spec: fallback to literal "@<path>" inline
				parsed.userSources.push({ type: "inline", value: token });
			}
			continue;
		}

		if (isQuotedToken(token)) {
			parsed.userSources.push({ type: "inline", value: stripQuotes(token) });
			continue;
		}

		// Unknown token (not --, not #, not @, not quoted): treat as
		// passthrough. Covers the rare case of stray tokens reaching
		// the parser.
		parsed.passthroughArgs.push(token);
	}

	return parsed;
}

/**
 * spec 003 §3.1 — /agents:inject R2 grammar parser.
 *
 * /agents:inject <name> [--replace | --append | --add] [<system-source>...]
 *   [--rollback [N]] [--history] [--cwd <path>] [-- <passthrough>]
 *
 * Exactly ONE of the five mode selectors (--replace/--append/--add/
 * --rollback/--history) is allowed; conflict → error (spec §3.1 mutually
 * exclusive rule). System sources are `#<path>` (must-exist file),
 * `#"..."` (file-or-inline), or a bare inline string. `--cwd` sets the
 * source-resolution root only (OQ5); it never relocates a running agent.
 */
export function parseInjectArgs(args: string, cwd: string): InjectParsedArgs {
	const tokens = tokenizeArgs(args.trim());
	const parsed: InjectParsedArgs = {
		name: "",
		mode: "append",
		sources: [],
		rollback: 1,
		cwd: undefined,
		passthroughArgs: [],
	};

	let modeSet: InjectParsedArgs["mode"] | undefined;
	const setMode = (m: InjectParsedArgs["mode"]) => {
		if (modeSet && modeSet !== m) {
			throw new Error("inject: --replace / --append / --add / --rollback / --history are mutually exclusive");
		}
		modeSet = m;
		parsed.mode = m;
	};

	// First positional token is the name.
	let i = 0;
	if (i < tokens.length && !tokens[i]!.startsWith("--")) {
		parsed.name = tokens[i]!;
		i++;
	}

	for (; i < tokens.length; i++) {
		const token = tokens[i]!;

		// `--` separator: everything from here goes to passthroughArgs verbatim.
		if (token === "--") {
			parsed.passthroughArgs.push(...tokens.slice(i + 1));
			break;
		}

		// Mode selectors (mutually exclusive).
		if (token === "--replace") {
			setMode("replace");
			continue;
		}
		if (token === "--append") {
			setMode("append");
			continue;
		}
		if (token === "--add") {
			setMode("add");
			continue;
		}
		if (token === "--history") {
			setMode("history");
			continue;
		}

		// --rollback [N]
		if (token === "--rollback") {
			setMode("rollback");
			const next = i + 1 < tokens.length ? tokens[i + 1]! : "";
			if (/^\d+$/.test(next)) {
				parsed.rollback = parseInt(next, 10);
				i++;
			}
			if (parsed.rollback < 1) throw new Error("inject: --rollback N must be >= 1");
			continue;
		}

		// --cwd <path> (source-resolution root only; OQ5).
		if (token === "--cwd") {
			const value = i + 1 < tokens.length ? tokens[i + 1]! : "";
			parsed.cwd = value;
			i++;
			continue;
		}

		// Unknown --flag → passthrough.
		if (token.startsWith("--")) {
			parsed.passthroughArgs.push(token);
			if (i + 1 < tokens.length) {
				const next = tokens[i + 1]!;
				if (!next.startsWith("--") && !next.startsWith("#") && !next.startsWith("@") && !isQuotedToken(next)) {
					parsed.passthroughArgs.push(next);
					i++;
				}
			}
			continue;
		}

		// System source: #<unquoted> or #"<quoted>". Resolution root is
		// --cwd when given (OQ5: source-resolution root only), else the
		// caller cwd.
		if (token.startsWith("#")) {
			const root = parsed.cwd ?? cwd;
			const value = stripQuotes(token.slice(1));
			if (token.startsWith('#"')) {
				const file = tryResolveAsFile(value, root);
				if (file) parsed.sources.push(file);
				else parsed.sources.push({ type: "inline", value });
			} else {
				const file = tryResolveAsFile(value, root);
				if (!file) throw new Error(`inject: system source "${value}" must be a regular file (resolved relative to cwd "${root}").`);
				parsed.sources.push(file);
			}
			continue;
		}

		// Bare inline string → system source.
		parsed.sources.push({ type: "inline", value: stripQuotes(token) });
	}

	return parsed;
}
