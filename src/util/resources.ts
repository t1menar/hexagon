import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as sea from "node:sea";

/**
 * Packaged resources (templates, schemas, package.json). In development they are read
 * from the repository; inside the single-executable binary they come from an embedded
 * asset (`resources.json`, a { "relative/path": "content" } map built by scripts/build-binary.mjs).
 */
export const IS_BINARY: boolean = (() => {
  try {
    return sea.isSea();
  } catch {
    return false;
  }
})();

let embedded: Record<string, string> | undefined;

function bundle(): Record<string, string> {
  embedded ??= JSON.parse(sea.getAsset("resources.json", "utf8") as string) as Record<string, string>;
  return embedded;
}

/** Repository root when running from source or dist/. */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

export function readResource(rel: string): string {
  if (IS_BINARY) {
    const v = bundle()[rel];
    if (v === undefined) throw new Error(`embedded resource missing: ${rel}`);
    return v;
  }
  return fs.readFileSync(path.join(packageRoot(), rel), "utf8");
}

export function hasResource(rel: string): boolean {
  return IS_BINARY ? rel in bundle() : fs.existsSync(path.join(packageRoot(), rel));
}

/** File names directly inside a resource directory, e.g. listResources("templates/roles"). */
export function listResources(dir: string): string[] {
  if (IS_BINARY) {
    const prefix = dir.replace(/\/$/, "") + "/";
    return Object.keys(bundle())
      .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
      .map((k) => k.slice(prefix.length))
      .sort();
  }
  const abs = path.join(packageRoot(), dir);
  return fs.existsSync(abs) ? fs.readdirSync(abs).sort() : [];
}

/** argv prefix that re-invokes this CLI: the binary itself, or `node dist/cli.js`. */
export function selfCommand(): string[] {
  return IS_BINARY ? [process.execPath] : [process.execPath, path.join(packageRoot(), "dist", "cli.js")];
}

/** Identifies this build (mtime of the binary or dist/cli.js): a daemon from another build gets replaced. */
export function buildId(): string {
  const f = selfCommand().at(-1)!;
  try { return String(Math.floor(fs.statSync(f).mtimeMs)); } catch { return "dev"; }
}
