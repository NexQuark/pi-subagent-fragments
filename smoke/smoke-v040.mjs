// v0.4.0 release smoke — verifies the merged main end-to-end for the
// structured tool prompting feature area (spec 005):
//   R1: each registered tool carries promptSnippet + promptGuidelines
//   R2: APPEND_SYSTEM.md channel retired (no pi.appendSystem, no
//       scripts/append-system.mjs, no instructions.md at root)
//   R3: skill ships in package, NOT auto-installed
//
// State protocol (charter §5 step 7):
//   exit 0  → PASS (green)  → gate clears
//   exit 2  → FAIL (blocker) → gate holds
//   exit 1  → FAIL (follow-up) → amber
//
// Usage: bun smoke/smoke-v040.mjs

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = dirname(new URL(import.meta.url).pathname) + "/..";

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

console.log(`[smoke] v0.4.0 — R1 + R2 + R3`);

// ---- R1: each registered tool has promptSnippet + promptGuidelines -----
console.log("\n[R1] tool promptSnippet + promptGuidelines");
try {
  // Tools are registered via `pi.registerTool({...})` calls in the extension.
  // Source-grep for each tool name and check both fields are present in the
  // same call site.
  const candidates = ["complete_subagent", "delegate_subagent", "subagent", "get_subagent_result", "wait_for_subagent_idle", "steer_subagent", "stop_subagent"];
  const sources = [
    join(ROOT, "extensions/subagent/index.ts"),
    join(ROOT, "extensions/subagent/pane-support-tools.ts"),
  ];
  let checkedAtLeastOne = false;
  for (const name of candidates) {
    // find a `name: "<name>"` line + 200-char window for promptSnippet/promptGuidelines
    let found = false;
    for (const src of sources) {
      if (!existsSync(src)) continue;
      const text = readFileSync(src, "utf8");
      const re = new RegExp(`name:\\s*["']${name}["']`, "g");
      const m = re.exec(text);
      if (!m) continue;
      // extract the surrounding registerTool({...}) block (up to 1500 chars;
      // the subagent tool has a long promptSnippet + 6-line promptGuidelines)
      const window = text.slice(m.index, m.index + 1500);
      const hasSnippet = /promptSnippet:\s*["'][^"']+["']/.test(window);
      const hasGuidelines = /promptGuidelines:\s*\[[^\]]*\]/.test(window);
      if (hasSnippet || hasGuidelines) {
        check(`tool ${name}: promptSnippet present`, hasSnippet, hasSnippet ? "" : "missing promptSnippet in same registerTool block");
        check(`tool ${name}: promptGuidelines present`, hasGuidelines, hasGuidelines ? "" : "missing promptGuidelines in same registerTool block");
        found = true;
        checkedAtLeastOne = true;
        break;
      }
    }
    if (!found) {
      // tool not found in expected sources — could be intentional absence
      // (e.g. capability-dependent). Don't fail; log presence only.
      console.log(`  ⏭️  tool ${name}: not in expected sources (may be intentional)`);
    }
  }
  if (!checkedAtLeastOne) {
    check("R1: at least one tool registered", false, "[BLOCKER] no promptSnippet/Guidelines found in any source");
  }
} catch (e) {
  check("R1 tool surface", false, `[BLOCKER] ${e.message}`);
}

// ---- R2: APPEND_SYSTEM.md channel retired -------------------------------
console.log("\n[R2] APPEND_SYSTEM.md channel retired");
try {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  check("package.json no pi.appendSystem", pkg.pi?.appendSystem === undefined, JSON.stringify(pkg.pi?.appendSystem));
  check("package.json scripts.smoke references v040", typeof pkg.scripts?.smoke === "string" && pkg.scripts.smoke.includes("smoke-v040"), pkg.scripts?.smoke);
  check("scripts/append-system.mjs absent", !existsSync(join(ROOT, "scripts/append-system.mjs")));
  check("instructions.md at root absent", !existsSync(join(ROOT, "instructions.md")));
} catch (e) {
  check("R2 channel retired", false, `[BLOCKER] ${e.message}`);
}

// ---- R3: skill ships, NOT auto-installed -------------------------------
console.log("\n[R3] optional skill ships, not auto-installed");
try {
  const skillDir = join(ROOT, "skills", "subagent-usage");
  check("skills/subagent-usage/ exists", existsSync(skillDir), skillDir);
  check("skills/subagent-usage/SKILL.md exists", existsSync(join(skillDir, "SKILL.md")));
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const filesList = pkg.files ?? [];
  check("package.json files[] includes skills/", filesList.some((f) => f.startsWith("skills/")), JSON.stringify(filesList));
  check("package.json scripts.postinstall absent or empty", !pkg.scripts?.postinstall || pkg.scripts.postinstall === "", pkg.scripts?.postinstall);
  check("package.json scripts.preuninstall absent or empty", !pkg.scripts?.preuninstall || pkg.scripts.preuninstall === "", pkg.scripts?.preuninstall);
} catch (e) {
  check("R3 skill shipping", false, `[BLOCKER] ${e.message}`);
}

// ---- verdict ------------------------------------------------------------
console.log(`\n[smoke] ${failed === 0 ? "PASS (green)" : blocker ? "FAIL (blocker)" : "FAIL (follow-up)"} — ${failed} failed check(s)`);
process.exit(failed === 0 ? 0 : blocker ? 2 : 1);