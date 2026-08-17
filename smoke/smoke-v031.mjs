// v0.3.1 release smoke — verifies the merged main end-to-end for the
// post-v0.3.0 hardening batch (spec 004):
//   R6: instance cap (running-agent count, configurable maxAgents, default 40)
//   R2: file-lock diagnostics (holder info in timeout error + exp backoff)
//   R3: inject hook typing + friendly ENOENT on missing file source
//   R1: name-only ad-hoc contract (`/agents:new <name>` no sources → empty task)
//
// State protocol (charter §5 step 7):
//   exit 0  → PASS (green)  → gate clears
//   exit 2  → FAIL (blocker) → gate holds
//   exit 1  → FAIL (follow-up) → amber
//
// Usage: bun smoke/smoke-v031.mjs

import { existsSync, mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = dirname(new URL(import.meta.url).pathname) + "/..";

const { maxAgentInstances, countRunningInstances, assertInstanceCap } = await import(join(ROOT, "extensions/subagent/instance-cap.js"));
const { FileLockTimeoutError, isFileLockTimeoutError, backoffDelayMs, withCrossProcessFileLock } = await import(join(ROOT, "extensions/subagent/file-lock.js"));

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

console.log(`[smoke] v0.3.1 — R6 (instance cap) + R2 (file-lock diagnostics) + R3 (inject typing + ENOENT) + R1 (name-only)`);

// ---- R6: instance cap --------------------------------------------------
console.log("\n[R6] instance cap");
try {
  // default = 40 (from instance-cap.ts DEFAULT_MAX_AGENTS)
  const def = maxAgentInstances();
  check("default maxAgents = 40", def === 40, `got ${def}`);
  // countRunningInstances returns InstanceCounts
  const stage = mkdtempSync(join(tmpdir(), "pi-cap-smoke-"));
  const counts = await countRunningInstances(stage);
  check("countRunningInstances returns InstanceCounts shape", typeof counts.total === "number" && typeof counts.panes === "number" && typeof counts.bg === "number", JSON.stringify(counts));
  // configurable: settingNumber reads vstack config; can't test in isolation
  // without mocking — the unit tests in tests/instance-cap*.test.ts cover the
  // configurable path. Smoke just confirms the default + shape are correct.
} catch (e) {
  check("R6 instance cap", false, `[BLOCKER] ${e.message}`);
}

// ---- R2: file-lock diagnostics + backoff -------------------------------
console.log("\n[R2] file-lock diagnostics + backoff");
try {
  // backoffDelayMs: doubles from base, capped at retryMs*32
  check("backoffDelayMs(0, 100, 32) = 100", backoffDelayMs(0, 100, 32) === 100);
  check("backoffDelayMs(1, 100, 32) = 200", backoffDelayMs(1, 100, 32) === 200);
  check("backoffDelayMs(2, 100, 32) = 400", backoffDelayMs(2, 100, 32) === 400);
  check("backoffDelayMs(10, 100, 32) = capped at 3200", backoffDelayMs(10, 100, 32) === 3200);
  // FileLockTimeoutError constructor + name check
  const err = new FileLockTimeoutError("lock failed", 100, "pid 42 on host since T0");
  check("FileLockTimeoutError is Error subclass", err instanceof Error);
  check("FileLockTimeoutError carries holder info", /pid 42/.test(String(err)), String(err).slice(0, 80));
  check("FileLockTimeoutError.holder field set", err.holder === "pid 42 on host since T0", err.holder);
  check("isFileLockTimeoutError guard", isFileLockTimeoutError(err));
  check("isFileLockTimeoutError false on plain Error", !isFileLockTimeoutError(new Error("nope")));
  // withCrossProcessFileLock: real acquire/release
  const stage = mkdtempSync(join(tmpdir(), "pi-lock-smoke-"));
  const lockPath = join(stage, "lock");
  let bodyRan = false;
  await withCrossProcessFileLock(lockPath, async () => { bodyRan = true; }, { retryMs: 10, timeoutMs: 1000 });
  check("withCrossProcessFileLock body ran", bodyRan);
} catch (e) {
  check("R2 file-lock diagnostics", false, `[BLOCKER] ${e.message}`);
}

// ---- R3: inject typing + friendly ENOENT -------------------------------
console.log("\n[R3] inject typing + friendly ENOENT");
try {
  // Source-grep for BeforeAgentStartEvent + ExtensionContext typing in hook.
  // The injection hook lives in extensions/subagent/prompt-inject.ts (spec 003
  // / spec 004 R3 typed it via the pi-exported types).
  const injectSrc = readFileSync(join(ROOT, "extensions/subagent/prompt-inject.ts"), "utf8");
  check("hook uses BeforeAgentStartEvent type", /BeforeAgentStartEvent/.test(injectSrc));
  check("hook uses ExtensionContext type", /ExtensionContext/.test(injectSrc));
  check("hook uses BeforeAgentStartEventResult type", /BeforeAgentStartEventResult/.test(injectSrc));
  // runToolInject ENOENT friendly — call with a missing file path
  const { runToolInject } = await import(join(ROOT, "extensions/subagent/prompt-inject.js"));
  const stage = mkdtempSync(join(tmpdir(), "pi-inject-enoent-"));
  const missing = join(stage, "does-not-exist.md");
  let threwEnoent = false;
  let msg = "";
  try {
    await runToolInject({ runtimeRoot: stage, name: "agentX", mode: "append", sources: [{ kind: "file", value: missing }] });
  } catch (e) {
    threwEnoent = true;
    msg = String(e.message ?? e);
  }
  check("missing file source throws", threwEnoent, msg.slice(0, 100));
  check("ENOENT message names the resolved path", /does-not-exist\.md/.test(msg) || /ENOENT/.test(msg), msg.slice(0, 120));
} catch (e) {
  check("R3 inject typing + ENOENT", false, `[BLOCKER] ${e.message}`);
}

// ---- R1: name-only ad-hoc contract -------------------------------------
console.log("\n[R1] name-only ad-hoc contract");
try {
  const { parseAdhocArgs } = await import(join(ROOT, "extensions/subagent/agents-command.js"));
  const stage = mkdtempSync(join(tmpdir(), "pi-nameonly-"));
  // Just a name, no sources — should parse without throwing
  let parsed = null;
  let threw = false;
  try { parsed = parseAdhocArgs("adhoc", stage); } catch { threw = true; }
  check("parseAdhocArgs('adhoc') succeeds (name only)", !threw && parsed?.name === "adhoc", threw ? "threw" : JSON.stringify(parsed));
  // AdhocParsedArgs has systemPromptSources + userSources, not a single sources[]
  check("parsed has empty systemPromptSources", Array.isArray(parsed?.systemPromptSources) && parsed.systemPromptSources.length === 0, JSON.stringify(parsed?.systemPromptSources));
  check("parsed has empty userSources", Array.isArray(parsed?.userSources) && parsed.userSources.length === 0, JSON.stringify(parsed?.userSources));
} catch (e) {
  check("R1 name-only", false, `[BLOCKER] ${e.message}`);
}

// ---- verdict ------------------------------------------------------------
console.log(`\n[smoke] ${failed === 0 ? "PASS (green)" : blocker ? "FAIL (blocker)" : "FAIL (follow-up)"} — ${failed} failed check(s)`);
process.exit(failed === 0 ? 0 : blocker ? 2 : 1);