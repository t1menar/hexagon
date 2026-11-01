import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { identityPrompt, loadRolePrompt, loadSkills } from "../src/agents/prompts.js";
import { loadConfig, migrateConfigFile, roleConfig } from "../src/core/config.js";
import { normalizePlan } from "../src/core/plan.js";
import { ProjectPaths, scaffold } from "../src/core/project.js";
import { BUILTIN_ROLES, canonicalRole, ROLE_ALIASES } from "../src/core/roles.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hr-"));

describe("role registry", () => {
  it("uses industry titles and maps every old name", () => {
    expect(BUILTIN_ROLES.map((r) => r.id)).toEqual(expect.arrayContaining(["analyst", "architect", "developer", "qa", "reviewer", "release", "devops", "security", "control", "bootstrap"]));
    expect(Object.fromEntries(["planner", "implementer", "tester", "integrator", "resolver", "lead", "init", "reviewer", "custom"].map((r) => [r, canonicalRole(r)]))).toEqual({
      planner: "analyst", implementer: "developer", tester: "qa", integrator: "release", resolver: "release", lead: "control", init: "bootstrap", reviewer: "reviewer", custom: "custom",
    });
    expect(Object.keys(ROLE_ALIASES)).toHaveLength(7);
  });

  it("old plans load: task roles are mapped", () => {
    const p = normalizePlan({ tasks: [{ id: "T-1", role: "implementer" }, { id: "T-2", role: "tester" }, { id: "T-3" }, { id: "T-4", role: "devops" }] }, { id: "p", specs: [] });
    expect(p.tasks.map((t) => t.role)).toEqual(["developer", "qa", "developer", "devops"]);
  });
});

describe("config migration", () => {
  const old = '# my notes\n[roles.planner]\nagent = "claude"\neffort = "xhigh"\n[roles.implementer]\nagent = "claude"\nmodel = "m1"\n[roles.lead]\nagent = "claude"\n';

  it("loads old section names without touching the file", () => {
    const f = path.join(tmp(), "config.toml");
    fs.writeFileSync(f, old);
    const cfg = loadConfig(f);
    expect(cfg.roles.analyst).toMatchObject({ effort: "xhigh" });
    expect(cfg.roles.developer).toMatchObject({ model: "m1" });
    expect(cfg.roles.planner).toBeUndefined();
    expect(fs.readFileSync(f, "utf8")).toBe(old);
  });

  it("renames sections in place and keeps every user edit; a section already written under the new name wins", () => {
    const f = path.join(tmp(), "config.toml");
    fs.writeFileSync(f, old + '[roles.developer]\nagent = "claude"\nmodel = "new"\n');
    expect(migrateConfigFile(f)).toEqual(["planner → analyst", "lead → control"]);
    const text = fs.readFileSync(f, "utf8");
    expect(text).toContain("# my notes\n[roles.analyst]");
    expect(text).toContain('effort = "xhigh"');
    expect(loadConfig(f).roles.developer).toMatchObject({ model: "new" });
    expect(migrateConfigFile(f)).toEqual([]); // second run: nothing left to rename
  });

  it("a custom role needs only what differs; unknown roles give a clear error", () => {
    const root = tmp();
    scaffold(root);
    const paths = new ProjectPaths(root);
    fs.writeFileSync(path.join(paths.roles, "docs.md"), "You write documentation.");
    fs.appendFileSync(paths.config, '\n[roles.docs]\nprompt = "docs.md"\ntitle = "Technical Writer"\nskills = ["commit-conventions"]\n');
    const cfg = loadConfig(paths.config);
    expect(cfg.roles.docs).toMatchObject({ agent: cfg.roles.developer!.agent, title: "Technical Writer" });
    const prompt = identityPrompt(paths, "docs", loadSkills(paths), cfg.roles.docs);
    expect(prompt).toContain("You write documentation.");
    expect(prompt).toContain("commit-conventions");
    expect(() => roleConfig(cfg, "ghost")).toThrow(/unknown role "ghost".*docs/);
    expect(() => loadRolePrompt(paths, "ghost")).toThrow(/no role prompt for ghost/);
  });

  it("a prompt a user edited under the old file name still wins over the shipped one", () => {
    const root = tmp();
    scaffold(root);
    const paths = new ProjectPaths(root);
    fs.writeFileSync(path.join(paths.roles, "implementer.md"), "My own developer rules.");
    expect(loadRolePrompt(paths, "developer")).toBe("My own developer rules.");
    fs.rmSync(path.join(paths.roles, "implementer.md"));
    expect(loadRolePrompt(paths, "developer")).not.toContain("My own");
  });
});
