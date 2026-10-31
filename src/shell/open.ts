import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cliEntry } from "../client/client.js";

const exec = promisify(execFile);

export type OpenWith = "auto" | "tmux" | "iterm" | "terminal" | "print";

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const asq = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Shell command that runs a hexagon subcommand with this exact node + package. */
export function hexagonCommand(cwd: string, args: string[]): string {
  return `cd ${shq(cwd)} && ${shq(process.execPath)} ${shq(cliEntry())} ${args.map(shq).join(" ")}`;
}

export function detectTerminal(): Exclude<OpenWith, "auto"> {
  if (process.env.TMUX) return "tmux";
  if (process.platform === "darwin") {
    if (process.env.TERM_PROGRAM === "iTerm.app") return "iterm";
    return "terminal";
  }
  return "print";
}

/** Open a new terminal window/tab running `command`. Returns a description of what happened. */
export async function openTerminal(title: string, command: string, mode: OpenWith = "auto"): Promise<string> {
  const how = mode === "auto" ? detectTerminal() : mode;
  try {
    switch (how) {
      case "tmux":
        await exec("tmux", ["new-window", "-n", title, command]);
        return `opened tmux window "${title}"`;
      case "iterm":
        await exec("osascript", [
          "-e", 'tell application "iTerm"',
          "-e", "activate",
          "-e", "if (count of windows) = 0 then",
          "-e", "create window with default profile",
          "-e", "else",
          "-e", "tell current window to create tab with default profile",
          "-e", "end if",
          "-e", `tell current session of current window to write text ${asq(command)}`,
          "-e", "end tell",
        ]);
        return `opened iTerm tab "${title}"`;
      case "terminal":
        await exec("osascript", ["-e", `tell application "Terminal" to do script ${asq(command)}`, "-e", 'tell application "Terminal" to activate']);
        return `opened Terminal window "${title}"`;
      default:
        return `run this in another terminal:\n  ${command}`;
    }
  } catch (e) {
    return `could not open a terminal (${how}): ${e instanceof Error ? e.message.split("\n")[0] : String(e)}\nrun this in another terminal:\n  ${command}`;
  }
}
