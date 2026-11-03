// Prints the size of the system prompt per role (role prompt + protocol + skills + capped HEXAGON.md) and of the
// per-turn task card. Numbers are characters and ≈tokens (chars/4); both are measured, not modelled.
//   esbuild scripts/prompt-sizes.ts --bundle --platform=node --format=esm --outfile=dist/tools/ps.mjs && node dist/tools/ps.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ProjectPaths, scaffold } from "../src/core/project.js";
import { identityPrompt, loadSkills, projectContext, taskCard } from "../src/agents/prompts.js";
import { protocolInstructions } from "../src/agents/protocol.js";
import { loadRolePrompt, skillsBlock } from "../src/agents/prompts.js";
import type { Role, Task } from "../src/contracts/types.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-"));
scaffold(root);
fs.writeFileSync(path.join(root, "HEXAGON.md"), "# Demo\n\n" + "Conventions: small modules, tests next to code. ".repeat(60) + "\n");
const paths = new ProjectPaths(root);
const skills = loadSkills(paths);
const ctx = projectContext(root);
const roles: Role[] = ["developer", "qa", "devops", "security", "reviewer", "analyst", "architect", "bootstrap", "release", "control"] as Role[];
const tok = (n: number) => Math.round(n / 4);
const rows: string[] = [];
for (const r of roles) {
  const role = loadRolePrompt(paths, r).length, proto = protocolInstructions(r).length, sk = skillsBlock(skills, r).length;
  const total = identityPrompt(paths, r, skills).length + ctx.length;
  rows.push(`${r.padEnd(10)} role ${String(role).padStart(5)}  protocol ${String(proto).padStart(5)}  skills ${String(sk).padStart(5)}  project ${String(ctx.length).padStart(5)}  total ${String(total).padStart(6)} chars ≈ ${tok(total)} tokens`);
}
const task = { id: "T-1", title: "Add parser", role: "developer", description: "", requirements: [], acceptance: ["AC-1"], files: { write: ["src/**"], read: [] }, definition_of_done: ["tests pass"], verify: ["npm test"], depends_on: [] } as unknown as Task;
const card = taskCard(task, [], "", [], true);
rows.push(`task card (minimal developer task, no specs/notes): ${card.length} chars ≈ ${tok(card.length)} tokens`);
console.log(rows.join("\n"));
