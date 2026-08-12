// v0.3.0 release smoke — verifies the merged main end-to-end for the
// runtime prompt injection feature area (spec 003): /agents:inject
// grammar, composeInjection semantics, prompt history FIFO + rollback,
// the before_agent_start hook apply path (one-shot consume + on-apply
// history), and the subagent tool inject path.
//
// State protocol (charter §5 step 7):
//   exit 0  → PASS (green)  → gate clears
//   exit 2  → FAIL (blocker) → gate holds
//   exit 1  → FAIL (follow-up) → amber
//
// Usage: bun smoke/smoke-v030.mjs

import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const ROOT = dirname(new URL(import.meta.url).pathname) + "/..";

// ---- import from the repo (what `npm pack` installs) --------------------
const { parseInjectArgs } = await import(join(ROOT, "extensions/subagent/agents-command.js"));
const { composeInjection, injectStatePathFor, writeInjectionState, readInjectionState, installPendingInjection, runToolInject } = await import(join(ROOT, "extensions/subagent/prompt-inject.js"));
const { PromptHistory, promptHistoryPathFor } = await import(join(ROOT, "extensions/subagent/prompt-history.js"));
const { DEFAULT_PROMPT_SEPARATOR } = await import(join(ROOT, "extensions/subagent/prompt-compose.js"));

const SEP = DEFAULT_PROMPT_SEPARATOR;
const stage = mkdtempSync(join(tmpdir(), "pi-inject-smoke-"));

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

console.log(`[smoke] v0.3.0 — staged dir: ${stage}`);

// ---- 1. /agents:inject grammar (parseInjectArgs, spec §3.1) -------------
console.log("\n[1] inject grammar (parseInjectArgs)");
try {
  const sysFile = join(stage, "sys.md");
  writeFileSync(sysFile, "SYSTEM-BODY", "utf8");
  // name + default append mode
  const p1 = parseInjectArgs("dba --append \"part\"", stage);
  check("name parsed", p1.name === "dba", JSON.stringify(p1.name));
  check("default mode append", p1.mode === "append", JSON.stringify(p1.mode));
  check('bare inline → system source', p1.sources.length === 1 && p1.sources[0].type === "inline" && p1.sources[0].value === "part", JSON.stringify(p1.sources));
  // --replace + #<file> must-exist
  const p2 = parseInjectArgs(`dba --replace #${sysFile}`, stage);
  check("--replace mode", p2.mode === "replace");
  check("#<file> → file source w/ content", p2.sources.length === 1 && p2.sources[0].type === "file" && p2.sources[0].content === "SYSTEM-BODY", JSON.stringify(p2.sources));
  // --rollback [N] default 1
  const p3 = parseInjectArgs("dba --rollback", stage);
  check("--rollback default 1", p3.mode === "rollback" && p3.rollback === 1);
  const p4 = parseInjectArgs("dba --rollback 3", stage);
  check("--rollback N parsed", p4.rollback === 3);
  // mode selectors mutually exclusive
  let threw = false;
  try { parseInjectArgs("dba --replace --rollback", stage); } catch { threw = true; }
  check("conflicting modes throw", threw);
  // --history
  const p5 = parseInjectArgs("dba --history", stage);
  check("--history mode", p5.mode === "history");
  // --cwd resolution root (OQ5)
  const sub = join(stage, "sub");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, "frag.md"), "FRAG", "utf8");
  const p6 = parseInjectArgs(`dba --replace --cwd ${sub} #frag.md`, stage);
  check("--cwd resolution root", p6.sources[0]?.type === "file" && p6.sources[0]?.content === "FRAG", JSON.stringify(p6.sources));
  // --rollback 0 → explicit error (F1)
  let threwF1 = false;
  try { parseInjectArgs("dba --rollback 0", stage); } catch (e) { threwF1 = /must be >= 1/.test(String(e.message)); }
  check("--rollback 0 explicit guard", threwF1);
} catch (e) {
  check("inject grammar", false, `[BLOCKER] ${e.message}`);
}

// ---- 2. composeInjection semantics (spec §4.1 / OQ3 / A2) ---------------
console.log("\n[2] composeInjection");
try {
  const rep = composeInjection({ mode: "replace", sources: [{ type: "inline", value: "NEW" }], current: "OLD" });
  check("replace = new only", rep.effective === "NEW", JSON.stringify(rep.effective));
  check("replace prev undefined", rep.prev === undefined);
  const app = composeInjection({ mode: "append", sources: [{ type: "inline", value: "B" }], current: "A" });
  check("append = current + sep + new", app.effective === "A" + SEP + "B", JSON.stringify(app.effective));
  check("append prev = current", app.prev === "A");
  const add = composeInjection({ mode: "add", sources: [{ type: "inline", value: "C" }], current: "X" });
  check("add is alias of append", add.effective === "X" + SEP + "C", JSON.stringify(add.effective));
  const noCur = composeInjection({ mode: "append", sources: [{ type: "inline", value: "B" }] });
  check("append no current → new only", noCur.effective === "B", JSON.stringify(noCur.effective));
  const bytes = composeInjection({ mode: "replace", sources: [{ type: "inline", value: "héllo" }] });
  check("bytes = utf-8 length", bytes.bytes === Buffer.byteLength("héllo", "utf-8"), JSON.stringify(bytes.bytes));
} catch (e) {
  check("composeInjection", false, `[BLOCKER] ${e.message}`);
}

// ---- 3. PromptHistory FIFO cap 10 + get(n) 1-indexed (spec §3.4) --------
console.log("\n[3] PromptHistory");
try {
  const file = promptHistoryPathFor(stage, "dba");
  const h = new PromptHistory(file);
  for (let i = 1; i <= 12; i++) h.push({ timestamp: `t${i}`, mode: "append", prev: `p${i - 1}`, new: `n${i}`, source: null });
  check("cap 10 evicts oldest", h.list().length === 10, `len=${h.list().length}`);
  check("get(1) = most recent", h.get(1)?.new === "n12", JSON.stringify(h.get(1)?.new));
  check("get(2) = one before", h.get(2)?.new === "n11", JSON.stringify(h.get(2)?.new));
  check("oldest evicted (n1 gone)", h.list()[0]?.new === "n3", JSON.stringify(h.list()[0]?.new));
  check("get(0)/too far → undefined", h.get(0) === undefined && h.get(99) === undefined);
  const empty = new PromptHistory(promptHistoryPathFor(stage, "ghost"));
  check("missing file → empty list", empty.list().length === 0);
} catch (e) {
  check("PromptHistory", false, `[BLOCKER] ${e.message}`);
}

// ---- 4. hook apply path (installPendingInjection, spec §4.4 / F2) -------
console.log("\n[4] hook apply (installPendingInjection)");
try {
  // append against real event.systemPrompt — never launch config (F2)
  await writeInjectionState(stage, "agentA", { mode: "append", fragments: ["B"] });
  const res = await installPendingInjection({ runtimeRoot: stage, sessionName: "agentA", eventSystemPrompt: "A" });
  check("append uses event.systemPrompt", res?.systemPrompt === "A" + SEP + "B", JSON.stringify(res?.systemPrompt));
  check("one-shot: state consumed (unlinked)", await readInjectionState(stage, "agentA") === null);
  // 2nd turn → no re-inject
  const again = await installPendingInjection({ runtimeRoot: stage, sessionName: "agentA", eventSystemPrompt: "A" + SEP + "B" });
  check("2nd turn no re-inject", again === null, JSON.stringify(again));
  // history pushed ON APPLY with real prev
  const h2 = new PromptHistory(promptHistoryPathFor(stage, "agentA"));
  check("history on-apply (1 row)", h2.list().length === 1, `len=${h2.list().length}`);
  check("history prev = real current", h2.list()[0]?.prev === "A", JSON.stringify(h2.list()[0]?.prev));
  check("history new = effective", h2.list()[0]?.new === "A" + SEP + "B");
  // replace installs verbatim
  await writeInjectionState(stage, "agentA", { mode: "replace", fragments: ["NEW"] });
  const rep = await installPendingInjection({ runtimeRoot: stage, sessionName: "agentA", eventSystemPrompt: "OLD" });
  check("replace installs verbatim", rep?.systemPrompt === "NEW", JSON.stringify(rep?.systemPrompt));
  // rollback state installs restored prompt verbatim
  await writeInjectionState(stage, "agentA", { mode: "rollback", fragments: ["BASE"] });
  const rb = await installPendingInjection({ runtimeRoot: stage, sessionName: "agentA", eventSystemPrompt: "BASE" + SEP + "X" });
  check("rollback installs restored verbatim", rb?.systemPrompt === "BASE", JSON.stringify(rb?.systemPrompt));
  // keying: other session untouched
  await writeInjectionState(stage, "agentB", { mode: "replace", fragments: ["B-P"] });
  const keyed = await installPendingInjection({ runtimeRoot: stage, sessionName: "agentC", eventSystemPrompt: "C" });
  check("keyed by session name (other untouched)", keyed === null && await readInjectionState(stage, "agentB") !== null);
} catch (e) {
  check("hook apply", false, `[BLOCKER] ${e.message}`);
}

// ---- 5. tool inject path (runToolInject, spec §3.6 / §4.3) --------------
console.log("\n[5] tool inject (runToolInject)");
try {
  const file = join(stage, "extra.md");
  writeFileSync(file, "FILE-CONTENT", "utf8");
  const t1 = await runToolInject({ runtimeRoot: stage, name: "toolA", mode: "replace", sources: [{ kind: "string", value: "NEW" }] });
  check("tool replace writes state", t1.includes("Injected into toolA") && (await readInjectionState(stage, "toolA"))?.fragments?.[0] === "NEW", t1);
  const t2 = await runToolInject({ runtimeRoot: stage, name: "toolB", mode: "append", sources: [{ kind: "file", value: file }] });
  check("tool file source resolves content", (await readInjectionState(stage, "toolB"))?.fragments?.[0] === "FILE-CONTENT", t2);
  // history table
  const histFile = promptHistoryPathFor(stage, "toolC");
  mkdirSync(join(stage, "prompt-history"), { recursive: true });
  writeFileSync(histFile, JSON.stringify([{ prev: "BASE", new: "BASE" + SEP + "X", mode: "append", timestamp: "t", source: null }]), "utf8");
  const t3 = await runToolInject({ runtimeRoot: stage, name: "toolC", history: true });
  check("tool history → markdown table", t3.includes("Prompt history for toolC") && t3.includes("| 1 |"), t3);
  // rollback writes restored prior
  const t4 = await runToolInject({ runtimeRoot: stage, name: "toolC", rollback: 1 });
  check("tool rollback writes restored", t4.includes("Rolled back toolC") && (await readInjectionState(stage, "toolC"))?.fragments?.[0] === "BASE", t4);
  // F1 guard on tool side
  let threwF1 = false;
  try { await runToolInject({ runtimeRoot: stage, name: "toolC", rollback: 0 }); } catch (e) { threwF1 = /must be >= 1/.test(String(e.message)); }
  check("tool rollback 0 explicit guard", threwF1);
} catch (e) {
  check("tool inject", false, `[BLOCKER] ${e.message}`);
}

// ---- verdict ------------------------------------------------------------
console.log(`\n[smoke] ${failed === 0 ? "PASS (green)" : blocker ? "FAIL (blocker)" : "FAIL (follow-up)"} — ${failed} failed check(s)`);
process.exit(failed === 0 ? 0 : blocker ? 2 : 1);
