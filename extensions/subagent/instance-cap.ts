/**
 * spec 004 R6 — running agent instance cap.
 *
 * Caps the number of running agent instances (live panes + running/queued
 * bg one-shots), NOT the predefined inventory. `/agents:new` / `/agents:start`
 * refuse to launch another instance once the cap is met; management ops and
 * predefined agent definitions are never capped.
 *
 * The count is computed at dispatch time from the pane registry (live
 * entries) + the task registry (kind="oneshot" records that are queued or
 * running). A stopped/dead pane (paneExists false) is not counted.
 */

import { settingNumber } from "./settings.js";
import { readPaneRegistry, readTaskRegistry } from "./tasks.js";
import { paneExists } from "./pane.js";
import { CONFIG_ID } from "./types.js";

const DEFAULT_MAX_AGENTS = 40;

export interface InstanceCounts {
	panes: number;
	bg: number;
	total: number;
}

/** The configured running-instance cap. `<= 0` means unlimited. */
export function maxAgentInstances(cwd?: string): number {
	return settingNumber("maxAgents", DEFAULT_MAX_AGENTS, cwd);
}

/**
 * Count running agent instances: live panes (pane registry entries whose
 * pane is still alive) + queued/running bg one-shots (task registry records
 * with kind="oneshot"). Stopped/dead panes and terminal tasks are excluded.
 */
export async function countRunningInstances(runtimeRoot: string): Promise<InstanceCounts> {
	const paneRegistry = await readPaneRegistry(runtimeRoot);
	let panes = 0;
	for (const entry of Object.values(paneRegistry)) {
		if (entry.paneId && (await paneExists(entry.paneId))) panes += 1;
	}
	const taskRegistry = await readTaskRegistry(runtimeRoot);
	const bg = Object.values(taskRegistry).filter(
		(record) =>
			record.kind === "oneshot" && (record.status === "queued" || record.status === "running"),
	).length;
	return { panes, bg, total: panes + bg };
}

/**
 * R6 guard: when `maxAgents` (> 0) is met or exceeded, throw a friendly
 * error naming the current count, the resource breakdown, and the two
 * remediations. No-op when `maxAgents <= 0` (unlimited).
 */
export async function assertInstanceCap(runtimeRoot: string, cwd?: string): Promise<void> {
	const max = maxAgentInstances(cwd);
	if (max <= 0) return;
	const counts = await countRunningInstances(runtimeRoot);
	if (counts.total >= max) {
		throw new Error(
			`[pi-subagent-fragments] Refused to launch: ${counts.total} running agent instances meet or exceed maxAgents=${max}. ` +
				`Running ${counts.total}: ${counts.panes} panes, ${counts.bg} bg. ` +
				`Remediation: end idle agents with /agents:stop <name>, or raise maxAgents ` +
				`(vstack.extensionManager.config["${CONFIG_ID}"].maxAgents).`,
		);
	}
}
