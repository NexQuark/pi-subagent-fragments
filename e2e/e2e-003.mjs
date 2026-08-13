// E2E for spec 003 (R4 / e2e-003): the `before_agent_start` hook truly fires
// in a REAL pi child process — which the mock-pi unit harness cannot prove.
//
// Runs an actual `pi --print` subprocess (no LLM needed: before_agent_start
// fires before the model call; the provider 401 after it is expected) with a
// tiny extension file that wires the fork's real `registerInjectionHook` +
// `installPendingInjection`. Verifies one-shot consume + on-apply history,
// then a second turn re-fires the hook but does NOT re-inject.
//
// Run: PI_CODING_AGENT_DIR is set by the driver; needs `pi` on PATH.
//       NODE_PATH=./e2e/local_node_modules bun run e2e/e2e-003.mjs

import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { sessionRuntimeDir } from "../extensions/subagent/settings.js";
import { writeInjectionState, injectStatePathFor, readInjectionState } from "../extensions/subagent/prompt-inject.js";
import { promptHistoryPathFor } from "../extensions/subagent/prompt-history.js";

const ROOT = join(import.meta.dirname, "..");
const FORK_PROMPT_INJECT = join(ROOT, "extensions/subagent/prompt-inject.js");
const FORK_SETTINGS = join(ROOT, "extensions/subagent/settings.js");
const FORK_HISTORY = join(ROOT, "extensions/subagent/prompt-history.js");

const SID = "e2e003sid";
const NAME = "e2eagent";
const INJECTED = "E2E-003-INJECT";

const USER_DIR = mkdtempSync(join(tmpdir(), "pi-e2e-003-user-"));
const PROJECT = mkdtempSync(join(tmpdir(), "pi-e2e-003-project-"));
const MARKER = join(USER_DIR, "marker.txt");

// The driver must compute the child's runtime root in the SAME user dir the
// child runs with (piUserDir reads PI_CODING_AGENT_DIR at call time).
process.env.PI_CODING_AGENT_DIR = USER_DIR;

let fail = 0;
function check(ok, desc) {
	if (ok) console.log("[E2E-003] OK  : " + desc);
	else { console.log("[E2E-003] FAIL: " + desc); fail += 1; }
}

// Write the extension that wires the fork's real hook into a real pi child.
const extContent = `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { registerInjectionHook } from ${JSON.stringify("file://" + FORK_PROMPT_INJECT)};
import { sessionRuntimeDir, runtimeSessionId } from ${JSON.stringify("file://" + FORK_SETTINGS)};
import { promptHistoryPathFor } from ${JSON.stringify("file://" + FORK_HISTORY)};
const MARKER = ${JSON.stringify(MARKER)};
const NAME = ${JSON.stringify(NAME)};
const INJECTED = ${JSON.stringify(INJECTED)};
export default function (pi) {
  // Wire the real hook FIRST so this capture listener below sees the
  // chained (injected) systemPrompt (pi chains handlers in registration order).
  registerInjectionHook(pi, { runtimeRootForContext: (ctx) => sessionRuntimeDir(runtimeSessionId(ctx)) });
  pi.on("before_agent_start", async (event, ctx) => {
    const rt = sessionRuntimeDir(runtimeSessionId(ctx));
    const hist = promptHistoryPathFor(rt, NAME);
    const hlen = existsSync(hist) ? JSON.parse(readFileSync(hist, "utf8")).length : 0;
    appendFileSync(MARKER,
      \`observed_injected=\${String(event.systemPrompt).includes(INJECTED)};hist=\${hlen}\n\`);
    return undefined;
  });
}
`;
const EXT_FILE = join(USER_DIR, "e2e-003-ext.mjs");
writeFileSync(EXT_FILE, extContent, "utf8");

// The child runtime root: sessionRuntimeDir(SID) under PI_CODING_AGENT_DIR.
const runtimeRoot = sessionRuntimeDir(SID);
console.log("[E2E-003] PI_CODING_AGENT_DIR:", USER_DIR);
console.log("[E2E-003] runtimeRoot:", runtimeRoot);

function runPiTurn(label) {
	const res = spawnSync(
		"pi",
		["--print", "-e", EXT_FILE, "--no-extensions", "--session-id", SID, "--name", NAME, "-p", "hello"],
		{
			cwd: PROJECT,
			env: { ...process.env, PI_CODING_AGENT_DIR: USER_DIR },
			encoding: "utf8",
			timeout: 60_000,
		},
	);
	console.log(`[E2E-003] ${label}: pi exit=${res.status} (status 0/1 = hook fired, model 401 expected after)`);
	if (res.stderr) {
		const errLine = res.stderr.split("\n").filter((l) => l.includes("before_agent_start") || l.includes("inject") || l.includes("Cannot find") || l.includes("Error")).slice(0, 3);
		for (const l of errLine) console.log(`[E2E-003] ${label} stderr: ${l}`);
	}
	return res;
}

function readMarkerLines() {
	return existsSync(MARKER) ? readFileSync(MARKER, "utf8").split("\n").filter(Boolean) : [];
}

try {
	// Seed pending injection state for the child session/name.
	await writeInjectionState(runtimeRoot, NAME, { mode: "append", fragments: [INJECTED] });
	check(existsSync(injectStatePathFor(runtimeRoot, NAME)), "pending state seeded");

	// ---- Turn 1: hook must fire, consume one-shot, apply + record history.
	runPiTurn("turn1");
	const turn1 = readMarkerLines();
	console.log("[E2E-003] turn1 marker lines:", turn1);
	check(turn1.length >= 1, "before_agent_start fired in real pi child (turn 1)");
	check(turn1.some((l) => l.includes("observed_injected=true")), "injection applied into chained systemPrompt (turn 1)");
	check(turn1.some((l) => l.includes("hist=1")), "history recorded on apply (hist=1, turn 1)");
	check(!existsSync(injectStatePathFor(runtimeRoot, NAME)), "state consumed one-shot (unlinked) after turn 1");
	const histPath = promptHistoryPathFor(runtimeRoot, NAME);
	const histLen1 = existsSync(histPath) ? JSON.parse(readFileSync(histPath, "utf8")).length : 0;
	check(histLen1 === 1, `prompt-history/${NAME}.json has 1 entry after turn 1 (got ${histLen1})`);

	// ---- Turn 2: hook fires again but no pending state → NO re-inject.
	runPiTurn("turn2");
	const turn2 = readMarkerLines();
	const turn2Fires = turn2.length - turn1.length;
	console.log("[E2E-003] turn2 added marker lines:", turn2.slice(turn1.length));
	check(turn2Fires >= 1, "before_agent_start fired again (turn 2)");
	const histLen2 = existsSync(histPath) ? JSON.parse(readFileSync(histPath, "utf8")).length : 0;
	check(histLen2 === 1, `no re-inject: history still 1 entry after turn 2 (got ${histLen2})`);
	check(turn2.slice(turn1.length).every((l) => !l.includes("observed_injected=true")), "no pending state → plain systemPrompt on turn 2 (no re-inject)");

	rmSync(USER_DIR, { force: true, recursive: true });
	rmSync(PROJECT, { force: true, recursive: true });
	if (fail === 0) {
		console.log("[E2E-003] PASS: real pi child fires before_agent_start, one-shot consume + on-apply history + 2nd-turn no re-inject");
		process.exit(0);
	}
	console.log(`[E2E-003] FAIL: ${fail} check(s) failed`);
	process.exit(1);
} catch (err) {
	console.error("[E2E-003] threw:", err);
	rmSync(USER_DIR, { force: true, recursive: true });
	rmSync(PROJECT, { force: true, recursive: true });
	process.exit(2);
}
