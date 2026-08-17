import { discoverAgents } from "../extensions/subagent/agents.js";

const result = discoverAgents("/home/openatom", "user");
console.log("[smoke-discover] cwd=/home/openatom, scope=user");
console.log("[smoke-discover] projectAgentsDir:", result.projectAgentsDir);
console.log("[smoke-discover] discovered agents:");
for (const a of result.agents) {
    console.log(`  - ${a.name}`);
    console.log(`    systemPromptFragments: ${JSON.stringify(a.systemPromptFragments)}`);
    console.log(`    systemPromptMode: ${a.systemPromptMode}`);
    console.log(`    composed systemPrompt length: ${a.systemPrompt.length}`);
}

const alpha = result.agents.find(a => a.name === "smoke-alpha");
const beta = result.agents.find(a => a.name === "smoke-beta");

console.log("\n=== verify smoke-alpha ===");
if (!alpha) {
    console.log("  ❌ NOT DISCOVERED");
    process.exit(1);
}
console.log("  ✅ discovered");
const alphaHas = (s) => alpha.systemPrompt.includes(s);
const alphaChecks = [
    ["SMOKE-FRAGMENT-ALPHA-START", "fragment marker"],
    ["FRAGMENT-ALPHA", "agent identity"],
    ["You are agent-alpha", "body role"],
];
for (const [needle, desc] of alphaChecks) {
    console.log(`  ${alphaHas(needle) ? "✅" : "❌"} ${desc} (${needle})`);
}

console.log("\n=== verify smoke-beta ===");
if (!beta) {
    console.log("  ❌ NOT DISCOVERED");
    process.exit(1);
}
console.log("  ✅ discovered");
const betaHas = (s) => beta.systemPrompt.includes(s);
const betaChecks = [
    ["SMOKE-FRAGMENT-BETA-START", "fragment marker"],
    ["FRAGMENT-BETA", "agent identity"],
    ["You are agent-beta", "body role"],
];
for (const [needle, desc] of betaChecks) {
    console.log(`  ${betaHas(needle) ? "✅" : "❌"} ${desc} (${needle})`);
}

console.log("\n=== fragment composition sample (smoke-alpha) ===");
console.log(alpha.systemPrompt);

if (alpha && beta && alphaChecks.every(([n]) => alphaHas(n)) && betaChecks.every(([n]) => betaHas(n))) {
    console.log("\n[smoke-discover] PASS: 2 smoke fixtures discoverable, fragments composed correctly.");
    process.exit(0);
} else {
    console.log("\n[smoke-discover] FAIL");
    process.exit(1);
}
