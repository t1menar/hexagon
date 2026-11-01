/**
 * A rotating 3D atom drawn with terminal cells: a hexagonal nucleus, three tilted electron orbits and electrons running
 * on them. Real perspective projection with a depth buffer, so near parts are bright and bold (⬢) and far parts dim (⬡ ·).
 * Pure function of time → deterministic, testable, and free when nothing asks for a frame.
 */
import { Canvas, st } from "./canvas.js";
import { mix, sgr, TOKENS, type Caps } from "./theme.js";

type V = [number, number, number];
const TAU = Math.PI * 2;

const rotY = (v: V, a: number): V => [v[0] * Math.cos(a) + v[2] * Math.sin(a), v[1], -v[0] * Math.sin(a) + v[2] * Math.cos(a)];
const rotX = (v: V, a: number): V => [v[0], v[1] * Math.cos(a) - v[2] * Math.sin(a), v[1] * Math.sin(a) + v[2] * Math.cos(a)];
const rotZ = (v: V, a: number): V => [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a), v[2]];

/** Nucleus: a centre atom, a ring of six, and one atom above and below (a small hexagonal bipyramid). */
const NUCLEUS: V[] = [[0, 0, 0], ...Array.from({ length: 6 }, (_, i): V => [0.2 * Math.cos((i * TAU) / 6), 0, 0.2 * Math.sin((i * TAU) / 6)]), [0, 0.2, 0], [0, -0.2, 0]];
const ORBITS = [0, 1, 2].map((i) => (i * Math.PI) / 3);
const ELECTRONS = [{ orbit: 0, speed: 1.0, phase: 0 }, { orbit: 0, speed: 1.0, phase: Math.PI }, { orbit: 1, speed: -0.8, phase: 1.1 }, { orbit: 1, speed: -0.8, phase: 1.1 + Math.PI }, { orbit: 2, speed: 1.25, phase: 2.2 }, { orbit: 2, speed: 1.25, phase: 2.2 + Math.PI }];

export function renderMolecule(W: number, H: number, t: number, caps: Caps, aspect = 2): Canvas {
  const c = new Canvas(W, H);
  if (W < 12 || H < 5) return c;
  const d = caps.color;
  const sec = t / 1000;
  const spin = sec * 0.55, nod = 0.42 + Math.sin(sec * 0.31) * 0.22;
  const R = 0.85;
  const sx = Math.min(W / 2 - 1, (H / 2 - 0.5) * aspect) / (R * 1.25);
  const sy = sx / aspect;
  const cx = (W - 1) / 2, cy = (H - 1) / 2;
  const depth = new Float32Array(W * H).fill(-Infinity);
  const model = (v: V): V => rotX(rotY(v, spin), nod);
  const project = (v: V) => { const f = 1 / (1 - v[2] * 0.4); return { x: Math.round(cx + v[0] * f * sx), y: Math.round(cy + v[1] * f * sy), z: v[2] }; };
  const shade = (z: number, lo: number): number => Math.min(1, Math.max(0, (z + R) / (2 * R))) * (1 - lo) + lo;
  const plot = (v: V, ch: string, col: readonly [number, number, number], bold: boolean, bias = 0) => {
    const p = project(v);
    if (p.x < 0 || p.y < 0 || p.x >= W || p.y >= H) return;
    const i = p.y * W + p.x, z = p.z + bias;
    if (z < depth[i]!) return;
    depth[i] = z;
    c.set(p.x, p.y, ch, st(sgr(col, d), bold ? "1" : ""));
  };
  const dim = mix(TOKENS.surface2, TOKENS.border, 0.9);
  // orbits (dots; far side dim, near side bright)
  for (const a of ORBITS) {
    const n = 150;
    for (let i = 0; i < n; i++) {
      const th = (i / n) * TAU;
      const p = model(rotZ([R * Math.cos(th), 0, R * Math.sin(th)] as V, a));
      const k = shade(p[2], 0.15);
      plot(p, k > 0.62 ? (caps.unicode ? "•" : "o") : caps.unicode ? "·" : ".", mix(dim, TOKENS.brand, k * 0.8), false);
    }
  }
  // nucleus: bonds from the centre, then the atoms
  const nuc = NUCLEUS.map(model);
  for (let i = 1; i < nuc.length; i++) {
    for (let s = 1; s < 4; s++) {
      const q: V = [(nuc[i]![0] * s) / 4, (nuc[i]![1] * s) / 4, (nuc[i]![2] * s) / 4];
      plot(q, caps.unicode ? "·" : ".", mix(dim, TOKENS.brand2, shade(q[2], 0.2) * 0.8), false, 0.01);
    }
  }
  nuc.forEach((p, i) => {
    const k = shade(p[2], 0.1);
    plot(p, k > 0.45 || i === 0 ? (caps.unicode ? "⬢" : "O") : caps.unicode ? "⬡" : "o", mix(TOKENS.brand2, TOKENS.brand, 0.3 + 0.7 * k), k > 0.55 || i === 0, 0.05);
  });
  // electrons with a short comet tail
  for (const e of ELECTRONS) {
    for (let tail = 5; tail >= 0; tail--) {
      const th = e.phase + sec * e.speed * 1.8 - tail * 0.09 * Math.sign(e.speed);
      const p = model(rotZ([R * Math.cos(th), 0, R * Math.sin(th)] as V, ORBITS[e.orbit]!));
      const k = shade(p[2], 0.25);
      if (tail === 0) plot(p, k > 0.5 ? (caps.unicode ? "⬢" : "O") : caps.unicode ? "⬡" : "o", mix(TOKENS.text, TOKENS.brand2, 1 - k), true, 0.1);
      else plot(p, caps.unicode ? "·" : ".", mix(dim, TOKENS.brand2, k * (1 - tail / 7)), false, 0.08);
    }
  }
  return c;
}
