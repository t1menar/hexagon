import { describe, expect, it } from "vitest";
import { Director } from "../src/tui/director.js";
import { AnimationManager } from "../src/tui/motion.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("input does not wait for the animation frame rate", () => {
  it("an invalidate while a 4 fps hold is armed paints within a frame or two, not after ~250 ms", async () => {
    const frames: number[] = [];
    const m = new AnimationManager({ motion: "full", fps: 15, onFrame: () => frames.push(performance.now()) });
    m.hold("ambient", 4);
    await sleep(60); // first frame fired; the next is ~250 ms away
    const before = frames.length;
    const t0 = performance.now();
    m.invalidate();
    while (frames.length === before && performance.now() - t0 < 500) await sleep(1);
    const waited = performance.now() - t0;
    m.dispose();
    expect(frames.length).toBeGreaterThan(before);
    expect(waited).toBeLessThan(60);
  });

  it("frames triggered by input are still rate-limited (no more than one per ~16 ms)", async () => {
    const frames: number[] = [];
    const m = new AnimationManager({ motion: "full", fps: 15, onFrame: () => frames.push(performance.now()) });
    m.hold("ambient", 4);
    await sleep(30);
    frames.length = 0;
    for (let i = 0; i < 50; i++) { m.invalidate(); await sleep(1); }
    await sleep(40);
    m.dispose();
    // 50 ms of key mashing: at most ~1 frame per 16 ms plus slack, never one frame per key.
    expect(frames.length).toBeLessThanOrEqual(8);
  });

  it("the director drops its continuous holds while the user types and restores them after", () => {
    const m = new AnimationManager({ motion: "full", fps: 15, manual: true });
    const d = new Director(m);
    d.seed([{ task_id: "T-1", state: "working" } as never]);
    expect(m.busy).toBe(true);
    d.setQuiet(true);
    expect(m.busy).toBe(false);
    d.setQuiet(false);
    expect(m.busy).toBe(true);
    m.dispose();
  });
});
