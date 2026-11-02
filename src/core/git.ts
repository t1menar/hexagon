import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface GitResult { ok: boolean; stdout: string; stderr: string; code: number }

export async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim(), code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return { ok: false, stdout: (err.stdout ?? "").trim(), stderr: (err.stderr ?? String(e)).trim(), code: typeof err.code === "number" ? err.code : 1 };
  }
}

async function must(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args);
  if (!r.ok) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

export async function isRepo(cwd: string): Promise<boolean> {
  return (await git(cwd, ["rev-parse", "--is-inside-work-tree"])).ok;
}

export async function hasCommits(cwd: string): Promise<boolean> {
  return (await git(cwd, ["rev-parse", "--verify", "HEAD"])).ok;
}

export async function currentBranch(cwd: string): Promise<string> {
  return must(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  return (await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).ok;
}

export async function revParse(cwd: string, ref: string): Promise<string> {
  return must(cwd, ["rev-parse", ref]);
}

export async function createBranch(cwd: string, branch: string, from: string): Promise<void> {
  if (!(await branchExists(cwd, branch))) await must(cwd, ["branch", branch, from]);
}

/** Add a worktree at `dir` on a new branch `branch` starting at `from`. Reuses an existing one. */
export async function addWorktree(repo: string, dir: string, branch: string, from: string): Promise<void> {
  if (fs.existsSync(dir)) return;
  if (await branchExists(repo, branch)) await must(repo, ["worktree", "add", dir, branch]);
  else await must(repo, ["worktree", "add", "-b", branch, dir, from]);
}

export async function removeWorktree(repo: string, dir: string): Promise<void> {
  if (fs.existsSync(dir)) await git(repo, ["worktree", "remove", "--force", dir]);
  await git(repo, ["worktree", "prune"]);
}

/** Stage everything and commit; returns false if there was nothing to commit. */
export async function commitAll(cwd: string, message: string): Promise<boolean> {
  await must(cwd, ["add", "-A"]);
  const st = await git(cwd, ["diff", "--cached", "--quiet"]);
  if (st.ok) return false;
  await must(cwd, ["-c", "user.name=Hexagon", "-c", "user.email=hexagon@localhost", "commit", "-q", "-m", message]);
  return true;
}

export async function changedFiles(cwd: string, base: string): Promise<string[]> {
  const out = await must(cwd, ["diff", "--name-only", `${base}...HEAD`]);
  return out ? out.split("\n") : [];
}

/** Changed and untracked files. NUL-separated porcelain: immune to trimming and odd file names. */
export async function uncommittedFiles(cwd: string): Promise<string[]> {
  const r = await new Promise<string>((resolve, reject) =>
    execFile("git", ["status", "--porcelain", "-z", "-uall"], { cwd, maxBuffer: 64 * 1024 * 1024 }, (e, out) => (e ? reject(e) : resolve(out))));
  const parts = r.split("\0");
  const files: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    files.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") i++; // next part is the rename source
  }
  return files;
}

export async function diff(cwd: string, base: string, stat = false): Promise<string> {
  return must(cwd, ["diff", ...(stat ? ["--stat"] : []), `${base}...HEAD`]);
}

/** No staged/unstaged changes to tracked files (untracked files don't block a merge). */
/** No uncommitted changes to tracked files (outside `exclude` pathspecs, e.g. ".hexagon"). */
export async function isClean(cwd: string, exclude: string[] = []): Promise<boolean> {
  const out = await must(cwd, ["status", "--porcelain", "--untracked-files=no", "--", ".", ...exclude.map((e) => `:(exclude)${e}`)]);
  return out.length === 0;
}

export async function merge(cwd: string, branch: string, message: string): Promise<{ ok: boolean; conflict: boolean; output: string }> {
  const r = await git(cwd, ["-c", "user.name=Hexagon", "-c", "user.email=hexagon@localhost", "merge", "--no-ff", "-m", message, branch]);
  if (r.ok) return { ok: true, conflict: false, output: r.stdout };
  const conflict = /CONFLICT|Automatic merge failed/.test(r.stdout + r.stderr);
  if (conflict) await git(cwd, ["merge", "--abort"]);
  return { ok: false, conflict, output: (r.stdout + "\n" + r.stderr).trim() };
}

/** True when `ancestor` is reachable from `ref`. */
export async function isAncestor(cwd: string, ancestor: string, ref: string): Promise<boolean> {
  return (await git(cwd, ["merge-base", "--is-ancestor", ancestor, ref])).ok;
}

/** Move HEAD to `ref` and unstage everything, keeping the working tree: commits made since `ref` become plain changes. */
export async function uncommitTo(cwd: string, ref: string): Promise<void> {
  await must(cwd, ["reset", "-q", "--mixed", ref]);
}

export async function resetHard(cwd: string, ref: string): Promise<void> {
  await must(cwd, ["reset", "--hard", ref]);
  await must(cwd, ["clean", "-fd"]);
}

/** Make `cwd` a git repository with at least one commit (agents work in worktrees). Returns what was done. */
export async function ensureRepo(cwd: string): Promise<string | null> {
  const did: string[] = [];
  if (!(await isRepo(cwd))) {
    await must(cwd, ["init", "-q", "-b", "main"]);
    did.push("initialized a git repository");
  }
  if (!(await hasCommits(cwd))) {
    await must(cwd, ["add", "-A"]);
    const ident = (await git(cwd, ["config", "user.email"])).ok ? [] : ["-c", "user.name=Hexagon", "-c", "user.email=hexagon@localhost"];
    await must(cwd, [...ident, "commit", "-q", "--allow-empty", "-m", "Initial commit"]);
    did.push("made the initial commit");
  }
  return did.length ? did.join(" and ") : null;
}
