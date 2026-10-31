#!/usr/bin/env node
// Builds a standalone `hexagon` executable with Node's Single Executable Applications (SEA):
//   1. esbuild bundles src/cli.ts + all dependencies into one CommonJS file
//   2. templates/, schemas/ and package.json are embedded as one JSON asset
//   3. the SEA blob is injected into a copy of the current node binary (and re-signed on macOS)
//
// Usage: node scripts/build-binary.mjs [--install [dir]]   (default install dir: ~/.local/bin)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "build");
const binName = process.platform === "win32" ? "hexagon.exe" : "hexagon";
const bin = path.join(out, binName);
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const step = (s) => console.log(`\x1b[34m▸\x1b[0m ${s}`);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

step("bundling with esbuild");
await build({
  entryPoints: [path.join(root, "src/cli.ts")],
  outfile: path.join(out, "hexagon.cjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  // import.meta.url is only used for dev-mode paths; give the CJS bundle a valid value.
  define: { "import.meta.url": "__hexagon_import_meta_url" },
  banner: { js: 'const __hexagon_import_meta_url = require("node:url").pathToFileURL(__filename).href;' },
  logLevel: "warning",
});

step("embedding templates, schemas and package.json");
const resources = {};
const add = (rel) => (resources[rel] = fs.readFileSync(path.join(root, rel), "utf8"));
const walk = (dir) => {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel);
    else add(rel);
  }
};
walk("templates");
walk("schemas");
add("package.json");
fs.writeFileSync(path.join(out, "resources.json"), JSON.stringify(resources));

step("creating the SEA blob");
const seaConfig = {
  main: path.join(out, "hexagon.cjs"),
  output: path.join(out, "sea-prep.blob"),
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  assets: { "resources.json": path.join(out, "resources.json") },
};
fs.writeFileSync(path.join(out, "sea-config.json"), JSON.stringify(seaConfig, null, 2));
run(process.execPath, ["--experimental-sea-config", path.join(out, "sea-config.json")]);

step(`injecting into a copy of ${process.execPath} (node ${process.version})`);
fs.copyFileSync(process.execPath, bin);
fs.chmodSync(bin, 0o755);
if (process.platform === "darwin") run("codesign", ["--remove-signature", bin]);
const postject = path.join(root, "node_modules", "postject", "dist", "cli.js");
run(process.execPath, [
  postject, bin, "NODE_SEA_BLOB", seaConfig.output,
  "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : []),
], { stdio: ["ignore", "ignore", "inherit"] });
if (process.platform === "darwin") run("codesign", ["--sign", "-", bin]);

for (const f of ["hexagon.cjs", "resources.json", "sea-prep.blob", "sea-config.json"]) fs.rmSync(path.join(out, f), { force: true });
const size = (fs.statSync(bin).size / 1024 / 1024).toFixed(0);
const version = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
console.log(`\x1b[34m✔\x1b[0m built ${path.relative(root, bin)} (${size} MB, hexagon ${version})`);

const i = process.argv.indexOf("--install");
if (i >= 0) {
  const dir = process.argv[i + 1] && !process.argv[i + 1].startsWith("-") ? path.resolve(process.argv[i + 1]) : path.join(os.homedir(), ".local", "bin");
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, binName);
  fs.rmSync(dest, { force: true }); // replace, don't overwrite in place (keeps the code signature valid)
  fs.copyFileSync(bin, dest);
  fs.chmodSync(dest, 0o755);
  const onPath = (process.env.PATH ?? "").split(path.delimiter).includes(dir);
  console.log(`\x1b[34m✔\x1b[0m installed ${dest}${onPath ? "" : `\n  ! ${dir} is not on your PATH — add: export PATH="${dir}:$PATH"`}`);
}
