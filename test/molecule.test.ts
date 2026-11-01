import { describe, expect, it } from "vitest";
import { renderMolecule } from "../src/tui/molecule.js";
import { detectCaps } from "../src/tui/theme.js";

const caps = detectCaps({ TERM: "xterm-256color", LANG: "en_US.UTF-8", COLORTERM: "truecolor" }, true);
const ascii = detectCaps({ TERM: "dumb", HEXAGON_ASCII: "1" }, true);
const txt = (t: number, w = 70, h = 22) => renderMolecule(w, h, t, caps, 2).lines(false).join("\n");

describe("3D atom", () => {
  it("is deterministic and actually moves", () => {
    expect(txt(1000)).toBe(txt(1000));
    expect(txt(0)).not.toBe(txt(700));
    expect(txt(0)).not.toBe(txt(1400));
  });
  it("has a nucleus, orbit dots and electrons, and stays inside its box", () => {
    const t = txt(1234);
    expect(t).toContain("⬢");
    expect(t).toMatch(/[·•]/);
    const lines = renderMolecule(70, 22, 1234, caps, 2).lines(false);
    expect(lines.length).toBe(22);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(70);
  });
  it("uses depth: near atoms are filled, far ones hollow", () => {
    const seen = new Set<string>();
    for (let t = 0; t < 8000; t += 400) for (const ch of txt(t)) if ("⬢⬡".includes(ch)) seen.add(ch);
    expect([...seen].sort()).toEqual(["⬡", "⬢"]);
  });
  it("renders in ascii and refuses tiny boxes without throwing", () => {
    const t = renderMolecule(60, 20, 500, ascii, 2).lines(false).join("\n");
    expect(t).toMatch(/[Oo]/);
    expect(renderMolecule(5, 3, 0, caps, 2).lines(false).join("").trim()).toBe("");
  });
});
