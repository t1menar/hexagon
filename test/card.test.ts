import { describe, expect, it } from "vitest";
import type { Plan, Task } from "../src/contracts/types.js";
import { formatCard, planCard, specCard } from "../src/core/card.js";
import { checkPlan, contractSmells } from "../src/core/plan.js";
import { parseSpec } from "../src/core/spec.js";

const t = (id: string, over: Partial<Task> = {}): Task => ({ id, title: `Task ${id}`, role: "developer", requirements: ["REQ-A-001"], acceptance: [], depends_on: [], files: { write: [`src/${id}.ts`], read: [] }, skills: [], definition_of_done: ["d"], verify: ["npm test"], ...over });
const plan = (...tasks: Task[]): Plan => ({ schema: "hexagon.plan/v1", id: "p", created_at: "2026-01-01T00:00:00Z", specs: [], spec_issues: [], tasks });

describe("the approval card", () => {
  const spec = parseSpec("spec.md", `---\nspec: s\n---\n# S\n\n${[1, 2, 3, 4, 5, 6, 7].map((n) => `## REQ-A-00${n}: Requirement ${n}\nText.\n\n**Acceptance**\n- AC-1: observable ${n}\n\n**Touches**: \`src/a.ts\`\n`).join("\n")}`);

  it("is short: at most five bullets each, with the rest counted, and points at the full files", () => {
    const c = specCard(spec, ["specs/s.spec.md"]);
    expect(c.changes).toHaveLength(5);
    expect(c.changes[4]).toMatch(/and 3 more/);
    expect(c.verify).toHaveLength(5);
    expect(c.files).toEqual(["specs/s.spec.md"]);
    expect(formatCard(c, "Spec ready").split("\n").length).toBeLessThan(20);
  });

  it("shows plan smells a reader of plan.json would miss", () => {
    const p = plan(
      t("T-1", { verify: [], verify_exempt: "docs only" }),
      t("T-2", { requirements: [], verify: ["echo ok"], files: { write: ["src/shared/**"], read: [] } }),
      t("T-3", { files: { write: ["src/shared/x.ts"], read: [] } }),
    );
    const smells = planCard(p, ["plan.json"]).smells.join("\n");
    expect(smells).toMatch(/T-1 has no verify command \(exempt: docs only\)/);
    expect(smells).toMatch(/T-2 verify passes whatever the code does/);
    expect(smells).toMatch(/T-2 cites no requirement/);
    expect(smells).toMatch(/T-2 and T-3 run in parallel but both write/);
  });

  it("parallel tasks that share an interface need a contract task both wait for", () => {
    const api = t("T-1", { files: { write: ["src/api/types.ts"], read: [] } });
    const ui = t("T-2", { files: { write: ["src/ui/**"], read: ["src/api/types.ts"] } });
    expect(contractSmells(plan(api, ui)).join()).toMatch(/T-1 and T-2 run in parallel and share src\/api\/types.ts/);
    expect(checkPlan(plan(api, ui)).warnings.join()).toMatch(/no contract task/);
    // chained: no longer parallel
    expect(contractSmells(plan(api, { ...ui, depends_on: ["T-1"] }))).toEqual([]);
    // a contract task that both wait for
    const contract = t("T-0", { title: "Contract: API types", files: { write: ["src/api/types.ts"], read: [] } });
    expect(contractSmells(plan(contract, { ...api, files: { write: ["src/api/impl.ts"], read: ["src/api/types.ts"] }, depends_on: ["T-0"] }, { ...ui, depends_on: ["T-0"] }))).toEqual([]);
  });
});
