// v0.2.0 release smoke — verifies the merged main end-to-end for the
// ad-hoc pane/bg agent launch feature area (spec 002) plus spec 001
// fragments composition (the v0.1.0 base this release builds on).
//
// State protocol (charter §5 step 7):
//   exit 0  → PASS (green)  → gate clears
//   exit 2  → FAIL (blocker) → gate holds
//   exit 1  → FAIL (follow-up) → amber
//
// Usage: bun smoke/smoke-v020.mjs

import { mkdtempSync, cpSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const ROOT = dirname(new URL(import.meta.url).pathname) + "/..";
const FIXTURES = join(ROOT, "smoke", "fixtures");

// ---- stage a temp project with .pi/agents fixtures ---------------------
const stage = mkdtempSync(join(tmpdir(), "pi-subagent-smoke-"));
const agentsDir = join(stage, ".pi", "agents");
cpSync(FIXTURES, agentsDir, { recursive: true });

// ---- import from the repo (what `npm pack` installs) --------------------
const { discoverAgents } = await import(join(ROOT, "extensions/subagent/agents.js"));
const { parseAdhocArgs, resolveForceNewPane } = await import(join(ROOT, "extensions/subagent/agents-command.js"));
const { buildTmuxSplitArgs } = await import(join(ROOT, "extensions/subagent/pane.js"));
const { resolveAdhocPane } = await import(join(ROOT, "extensions/subagent/agents.js"));

let failed = 0;
let blocker = false;
const check = (name, ok, detail = "") => {
  if (!ok) {
    failed++;
    if (detail.startsWith("[BLOCKER]")) blocker = true;
    console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`);
  } else {
    console.log(`  ✅ ${name}`);
  }
};

console.log(`[smoke] v0.2.0 — staged project: ${stage}`);

// ---- 1. agent discovery + fragment composition (spec 001 base) ---------
console.log("\n[1] discovery + fragment composition");
let discovery;
try {
  discovery = discoverAgents(stage, "project");
  const names = discovery.agents.map((a) => a.name);
  check("discovers smoke-alpha + smoke-beta", names.includes("smoke-alpha") && names.includes("smoke-beta"), `got: ${names.join(", ")}`);
  const alpha = discovery.agents.find((a) => a.name === "smoke-alpha");
  check("alpha fragment marker composed", alpha?.systemPrompt?.includes("FRAGMENT-ALPHA"), "[BLOCKER] fragment composition broke");
  check("alpha body composed", alpha?.systemPrompt?.includes("You are agent-alpha"));
  const beta = discovery.agents.find((a) => a.name === "smoke-beta");
  check("beta fragment marker composed", beta?.systemPrompt?.includes("FRAGMENT-BETA"));
} catch (e) {
  check("discovery runs", false, `[BLOCKER] ${e.message}`);
}

// ---- 2. R2 grammar parsing (spec §3.6) ----------------------------------
console.log("\n[2] R2 grammar (parseAdhocArgs)");
try {
  // #<file> system source (name first, as the handler passes parts.slice(1))
  const p1 = parseAdhocArgs(`adhoc #${join(agentsDir, "agent-alpha.md")} "do the thing"`, stage);
  check("name parsed", p1.name === "adhoc", JSON.stringify(p1.name));
  check("#<file> → system source", p1.systemPromptSources?.length === 1 && p1.systemPromptSources[0].type === "file", JSON.stringify(p1.systemPromptSources));
  // "<text>" inline user source
  const p2 = parseAdhocArgs(`adhoc "run tests" --model deepseek-v4-flash`, stage);
  check('"..." inline → user source', p2.userSources?.length === 1 && p2.userSources[0].type === "inline" && p2.userSources[0].value === "run tests", JSON.stringify(p2.userSources));
  check("--model recognized", p2.model === "deepseek-v4-flash");
  // @<path> file-or-inline → USER source (PR9-E1)
  const p3 = parseAdhocArgs(`adhoc @${join(agentsDir, "agent-beta.md")}`, stage);
  check("@<path> → user source (file)", p3.userSources?.length === 1 && p3.userSources[0].type === "file");
  // flags
  const p4 = parseAdhocArgs(`adhoc "t" --no-pane --pane-direction v --pane-size 30% --pane-target next`, stage);
  check("--no-pane parsed", p4.noPane === true);
  check("--pane-direction parsed", p4.paneDirection === "v");
  check("--pane-size parsed", p4.paneSize?.value === 30 && p4.paneSize?.unit === "%", JSON.stringify(p4.paneSize));
  check("--pane-target parsed", p4.paneTarget === "next");
  // -- separator → passthrough
  const p5 = parseAdhocArgs(`adhoc "t" -- --verbose --strict`, stage);
  check("-- separator → passthrough", Array.isArray(p5.passthroughArgs) && p5.passthroughArgs.includes("--verbose") && p5.passthroughArgs.includes("--strict"), JSON.stringify(p5.passthroughArgs));
  // # missing file throws
  let threw = false;
  try { parseAdhocArgs(`adhoc #/nonexistent/definitely-missing.md "t"`, stage); } catch { threw = true; }
  check("# missing file throws", threw);
} catch (e) {
  check("R2 grammar parsing", false, `[BLOCKER] ${e.message}`);
}

// ---- 3. C4b tmux split args (buildTmuxSplitArgs) ------------------------
console.log("\n[3] C4b pane args");
try {
  const base = { splitHorizontally: true, splitPercent: "50", splitTarget: "primary", cwd: stage, launcherFile: "x.sh" };
  const b = buildTmuxSplitArgs({ ...base, paneDirection: "v", paneSize: { value: 30, unit: "%" } });
  check("direction v → -v", b.includes("-v") && !b.includes("-h"), JSON.stringify(b));
  check("size 30% → -p 30", b.includes("-p") && b[Math.max(0, b.indexOf("-p") + 1)] === "30" && !b.includes("-l"));
  const bl = buildTmuxSplitArgs({ ...base, paneDirection: "h", paneSize: { value: 25, unit: "l" } });
  check("size 25l → -l 25", bl.includes("-l") && bl[Math.max(0, bl.indexOf("-l") + 1)] === "25" && !bl.includes("-p"));
  const bt = buildTmuxSplitArgs({ ...base, paneTarget: "3" });
  check("target <id> → -t 3", bt.includes("-t") && bt[Math.max(0, bt.indexOf("-t") + 1)] === "3");
  const bd = buildTmuxSplitArgs(base);
  check("defaults preserve -h -p 50 -t primary", bd.includes("-h") && bd.includes("-p") && bd.includes("-t") && bd[Math.max(0, bd.indexOf("-t") + 1)] === "primary");
} catch (e) {
  check("C4b buildTmuxSplitArgs", false, `[BLOCKER] ${e.message}`);
}

// ---- 4. C1/C2 dispatch helpers ------------------------------------------
console.log("\n[4] dispatch helpers");
check("resolveAdhocPane(false, true) === false (no-pane → bg)", resolveAdhocPane(false, true) === false);
check("resolveAdhocPane(true, false) === true (tmux → pane)", resolveAdhocPane(true, false) === true);
check("resolveAdhocPane(true, true) === false (no-pane overrides tmux)", resolveAdhocPane(true, true) === false);
check("resolveForceNewPane('start', true) === true", resolveForceNewPane("start", true) === true);
check("resolveForceNewPane('new', false) === true (new always fresh)", resolveForceNewPane("new", false) === true);
check("resolveForceNewPane('start', false) === false", resolveForceNewPane("start", false) === false);
check("resolveForceNewPane('resume', false) === false", resolveForceNewPane("resume", false) === false);

// ---- verdict ------------------------------------------------------------
console.log(`\n[smoke] ${failed === 0 ? "PASS (green)" : blocker ? "FAIL (blocker)" : "FAIL (follow-up)"} — ${failed} failed check(s)`);
process.exit(failed === 0 ? 0 : blocker ? 2 : 1);
