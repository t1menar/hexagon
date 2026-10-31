import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Toolchains Hexagon installs itself, from the official releases, into ~/.hexagon/toolchains
 * (no Homebrew, no sudo). Their bin directories go on the PATH of agents and verify commands.
 */
export interface Toolchain { name: string; version: string; bin: string; home?: string }

const ROOT = process.env.HEXAGON_TOOLCHAINS ?? path.join(os.homedir(), ".hexagon", "toolchains");
const MANIFEST = path.join(ROOT, "installed.json");

type Spec = { aliases: string[]; commands: string[]; resolve: () => Promise<{ version: string; url: string }>; bin: (dir: string) => string; home?: (dir: string) => string };

const plat = () => (process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null);
const arch = () => (process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : null);

async function text(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

/** First directory under `dir` (an archive's top-level folder). */
const top = (dir: string) => {
  const d = fs.readdirSync(dir).find((f) => fs.statSync(path.join(dir, f)).isDirectory() && !f.startsWith("."));
  return d ? path.join(dir, d) : dir;
};

export const TOOLCHAINS: Record<string, Spec> = {
  go: {
    aliases: ["golang"], commands: ["go", "gofmt"],
    resolve: async () => {
      const version = (await text("https://go.dev/VERSION?m=text")).split("\n")[0]!.trim();
      return { version, url: `https://go.dev/dl/${version}.${plat()}-${arch()}.tar.gz` };
    },
    bin: (dir) => path.join(top(dir), "bin"),
    home: (dir) => top(dir),
  },
  node: {
    aliases: ["nodejs", "npm"], commands: ["node", "npm", "npx"],
    resolve: async () => {
      const list = JSON.parse(await text("https://nodejs.org/dist/index.json")) as { version: string; lts: string | false }[];
      const v = list.find((x) => x.lts)!.version;
      const a = arch() === "amd64" ? "x64" : "arm64";
      return { version: v, url: `https://nodejs.org/dist/${v}/node-${v}-${plat()}-${a}.tar.gz` };
    },
    bin: (dir) => path.join(top(dir), "bin"),
  },
  java: {
    aliases: ["jdk", "openjdk", "temurin"], commands: ["java", "javac"],
    resolve: async () => {
      const o = plat() === "darwin" ? "mac" : "linux";
      const a = arch() === "amd64" ? "x64" : "aarch64";
      const assets = JSON.parse(await text(`https://api.adoptium.net/v3/assets/latest/21/hotspot?os=${o}&architecture=${a}&image_type=jdk`)) as { binary: { package: { link: string } }; version: { semver: string } }[];
      if (!assets[0]) throw new Error("no Temurin JDK 21 build for this platform");
      return { version: assets[0].version.semver, url: assets[0].binary.package.link };
    },
    bin: (dir) => path.join(javaHome(dir), "bin"),
    home: (dir) => javaHome(dir),
  },
  maven: {
    aliases: ["mvn"], commands: ["mvn"],
    resolve: async () => {
      const v = "3.9.9";
      return { version: v, url: `https://archive.apache.org/dist/maven/maven-3/${v}/binaries/apache-maven-${v}-bin.tar.gz` };
    },
    bin: (dir) => path.join(top(dir), "bin"),
  },
};

function javaHome(dir: string): string {
  const t = top(dir);
  const mac = path.join(t, "Contents", "Home");
  return fs.existsSync(mac) ? mac : t;
}

/** "golang" → "go"; null when Hexagon can't install it. */
export function toolchainFor(name: string): string | null {
  const n = name.trim().toLowerCase();
  for (const [k, s] of Object.entries(TOOLCHAINS)) if (k === n || s.aliases.includes(n) || s.commands.includes(n)) return k;
  return null;
}

export function installed(): Record<string, Toolchain> {
  try { return JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as Record<string, Toolchain>; } catch { return {}; }
}

/** PATH entries and env (JAVA_HOME, GOROOT…) for installed toolchains. */
export function toolchainEnv(): { bins: string[]; env: Record<string, string> } {
  const all = Object.values(installed()).filter((t) => fs.existsSync(t.bin));
  const env: Record<string, string> = {};
  for (const t of all) {
    if (t.name === "java" && t.home) env.JAVA_HOME = t.home;
    if (t.name === "go" && t.home) env.GOROOT = t.home;
  }
  return { bins: all.map((t) => t.bin), env };
}

/** Put installed toolchains on this process's PATH (inherited by agents and verify commands). */
export function applyToolchainEnv(): void {
  const { bins, env } = toolchainEnv();
  const cur = (process.env.PATH ?? "").split(":");
  process.env.PATH = [...bins.filter((b) => !cur.includes(b)), ...cur].join(":");
  Object.assign(process.env, env);
}

/** Is `command` runnable with the current PATH? */
export function onPath(command: string): boolean {
  return (process.env.PATH ?? "").split(":").some((d) => d && fs.existsSync(path.join(d, command)));
}

export async function install(name: string, log: (line: string) => void = () => undefined): Promise<Toolchain> {
  const key = toolchainFor(name);
  if (!key) throw new Error(`Hexagon can't install "${name}". It can install: ${Object.keys(TOOLCHAINS).join(", ")}.`);
  if (!plat() || !arch()) throw new Error(`unsupported platform ${process.platform}/${process.arch}`);
  const spec = TOOLCHAINS[key]!;
  const { version, url } = await spec.resolve();
  log(`downloading ${key} ${version}`);
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`${url}: HTTP ${r.status}`);
  fs.mkdirSync(ROOT, { recursive: true });
  const archive = path.join(ROOT, `${key}.download.tar.gz`);
  fs.writeFileSync(archive, Buffer.from(await r.arrayBuffer()));
  const dir = path.join(ROOT, key);
  const tmp = `${dir}.new`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  log(`unpacking into ${dir}`);
  execFileSync("tar", ["-xzf", archive, "-C", tmp]);
  fs.rmSync(archive, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  const t: Toolchain = { name: key, version, bin: spec.bin(dir), ...(spec.home ? { home: spec.home(dir) } : {}) };
  if (!fs.existsSync(t.bin)) throw new Error(`installed ${key}, but ${t.bin} is missing`);
  fs.writeFileSync(MANIFEST, JSON.stringify({ ...installed(), [key]: t }, null, 2));
  applyToolchainEnv();
  return t;
}
