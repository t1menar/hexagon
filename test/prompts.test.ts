import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { identityPrompt, loadSkills } from "../src/agents/prompts.js";
import { lintPrompts } from "../src/core/promptlint.js";
import { ProjectPaths, scaffold } from "../src/core/project.js";
import { BUILTIN_ROLES } from "../src/core/roles.js";

describe("shipped prompts", () => {
  it("lint clean", () => {
    expect(lintPrompts().filter((f) => f.level === "error")).toEqual([]);
  });

  // The assembled prompt of each role (role text + protocol + skills) is pinned. A change shows up as a diff in
  // review; accept it with UPDATE_GOLDEN=1 npx vitest run test/prompts.test.ts.
  for (const r of BUILTIN_ROLES) {
    it(`golden: ${r.id}`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "hg-"));
      scaffold(root);
      const paths = new ProjectPaths(root);
      // The project's own copies are the shipped ones; the packaged skills are what loadSkills returns.
      const text = identityPrompt(paths, r.id, loadSkills(paths)) + "\n";
      const file = path.join(import.meta.dirname, "golden/prompts", `${r.id}.txt`);
      if (process.env.UPDATE_GOLDEN || !fs.existsSync(file)) fs.writeFileSync(file, text);
      expect(text).toBe(fs.readFileSync(file, "utf8"));
    });
  }
});
