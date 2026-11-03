import { describe, expect, it } from "vitest";
import { badgeFor, BusLog, busLine, busStrip, type BusRow } from "../src/tui/busview.js";
import { computeLayout, overlaps, type Region } from "../src/tui/layout.js";

const row = (id: string, o: Partial<BusRow> = {}): BusRow => ({ id, ts: "t", kind: "question", from: "T-1", to: "T-3", subject: "which format?", state: "queued", blocking: false, ...o });

describe("bus log", () => {
  it("a state change updates the entry in place; it never adds a second one", () => {
    const l = new BusLog();
    expect(l.apply(row("B-1"))).toBe("new");
    expect(l.apply(row("B-1", { state: "delivered" }))).toBe("updated");
    expect(l.size).toBe(1);
    expect(l.get("B-1")!.state).toBe("delivered");
  });
  it("is bounded", () => {
    const l = new BusLog(5);
    for (let i = 0; i < 20; i++) l.apply(row(`B-${i}`));
    expect(l.size).toBe(5);
    expect(l.get("B-19")).toBeDefined();
    expect(l.get("B-0")).toBeUndefined();
  });
  it("renders one line within the width, and the strip puts waits first", () => {
    const l = new BusLog();
    l.apply(row("B-1", { subject: "x".repeat(200), blocking: true }));
    expect(busLine(l.get("B-1")!, 60).length).toBeLessThanOrEqual(60);
    const s = busStrip(l, [{ from: "T-1", for: "T-3" }], 60, 3);
    expect(s[0]).toContain("T-1 waits for T-3");
    expect(s.length).toBeLessThanOrEqual(3);
  });
  it("badges: unread inbox and who a task waits for", () => {
    expect(badgeFor("T-1", 2, [{ from: "T-1", for: "T-3" }])).toBe("✉2 ⏳T-3");
    expect(badgeFor("T-2", 0, [{ from: "T-1", for: "T-3" }])).toBe("");
  });
});

describe("bus strip layout", () => {
  it("medium mode carves the strip out of the chat band without overlap", () => {
    const l = computeLayout(100, 28, { busRows: 3 });
    expect(l.busStrip).not.toBeNull();
    const regions = [l.header, l.agents, l.strip, l.network, l.inspector, l.activity, l.busStrip, l.chat, l.input].filter(Boolean) as Region[];
    for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) expect(overlaps(regions[i]!, regions[j]!), `${i}/${j}`).toBe(false);
  });
  it("no strip when none is wanted", () => expect(computeLayout(100, 28).busStrip).toBeNull());
});
