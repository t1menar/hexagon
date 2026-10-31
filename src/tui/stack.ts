import fs from "node:fs";
import path from "node:path";
import type { StampedEvent, Task } from "../contracts/types.js";

/** Technologies recognisable from a task's text, files and verify commands. */
const TECH: [RegExp, string][] = [
  [/spring\s*boot|spring-boot/i, "Spring Boot"], [/\bspring\b(?!\s*boot)/i, "Spring"], [/\bjunit\b/i, "JUnit"], [/mockmvc/i, "MockMvc"],
  [/\breact\b/i, "React"], [/\bnext\.?js\b/i, "Next.js"], [/\bvue\b/i, "Vue"], [/\bexpress\b/i, "Express"], [/\bnestjs\b/i, "NestJS"],
  [/\bfastapi\b/i, "FastAPI"], [/\bdjango\b/i, "Django"], [/\bflask\b/i, "Flask"], [/\bpytest\b/i, "pytest"],
  [/\bgin\b/i, "Gin"], [/\bgrpc\b/i, "gRPC"], [/\bgraphql\b/i, "GraphQL"], [/\brest\b|\bhttp\b|endpoint/i, "HTTP API"],
  [/postgres/i, "PostgreSQL"], [/mysql/i, "MySQL"], [/sqlite/i, "SQLite"], [/\bredis\b/i, "Redis"], [/\bh2\b/i, "H2"],
  [/docker/i, "Docker"], [/kubernetes|\bk8s\b/i, "Kubernetes"], [/vitest/i, "Vitest"], [/\bjest\b/i, "Jest"],
];
const EXT: Record<string, string> = {
  java: "Java", kt: "Kotlin", go: "Go", ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript", py: "Python",
  rs: "Rust", rb: "Ruby", cs: "C#", swift: "Swift", php: "PHP", sql: "SQL", sh: "Shell", html: "HTML", css: "CSS", md: "Markdown",
  yml: "YAML", yaml: "YAML", proto: "Protobuf",
};
const FILE: Record<string, string> = {
  "pom.xml": "Maven", "build.gradle": "Gradle", "build.gradle.kts": "Gradle", "package.json": "npm", "go.mod": "Go",
  "Cargo.toml": "Cargo", "pyproject.toml": "Python", "requirements.txt": "Python", Dockerfile: "Docker", Makefile: "Make",
};
const DIR: Record<string, string> = { java: "Java", kotlin: "Kotlin", python: "Python", typescript: "TypeScript", go: "Go" };
const CMD: Record<string, string> = {
  mvn: "Maven", "./mvnw": "Maven", gradle: "Gradle", "./gradlew": "Gradle", go: "Go", npm: "npm", npx: "npm", pnpm: "pnpm",
  yarn: "Yarn", pytest: "pytest", cargo: "Cargo", make: "Make", docker: "Docker", vitest: "Vitest", jest: "Jest", tsc: "TypeScript",
};

/** e.g. ["Java", "Spring Boot", "Maven", "JUnit"] — languages first, then frameworks and build tools. */
export function taskStack(task: Task, project: string[] = []): string[] {
  const out: string[] = [];
  const add = (t: string | undefined) => { if (t && !out.includes(t)) out.push(t); };
  for (const f of [...task.files.write, ...task.files.read]) {
    const base = path.basename(f);
    add(FILE[base]);
    add(EXT[(/\.([a-z0-9]+)$/i.exec(base)?.[1] ?? "").toLowerCase()]);
    for (const seg of f.split("/")) add(DIR[seg]);
  }
  for (const v of task.verify) add(CMD[v.trim().split(/\s+/)[0] ?? ""]);
  const text = `${task.title}\n${task.description ?? ""}\n${task.verify.join("\n")}`;
  for (const [re, name] of TECH) if (re.test(text)) add(name);
  // Nothing recognisable (e.g. a glob like src/**): fall back to the project's stack.
  if (!out.filter((t) => t !== "Markdown" && t !== "HTTP API").length) for (const p of project) add(p);
  return out.slice(0, 6);
}

/** The project's stack from HEXAGON.md's "## Stack" section, as recognised names. */
export function projectStack(root: string): string[] {
  const f = path.join(root, "HEXAGON.md");
  if (!fs.existsSync(f)) return [];
  const text = fs.readFileSync(f, "utf8");
  const sec = /^##\s*Stack\s*$([\s\S]*?)(?=^##\s|\s*$(?![\s\S]))/m.exec(text)?.[1] ?? "";
  const out: string[] = [];
  const langs: [RegExp, string][] = [[/\bjava\b/i, "Java"], [/\bkotlin\b/i, "Kotlin"], [/\bgo(lang)?\b/i, "Go"], [/typescript/i, "TypeScript"], [/javascript|node/i, "JavaScript"], [/python/i, "Python"], [/\brust\b/i, "Rust"], [/maven/i, "Maven"], [/gradle/i, "Gradle"]];
  for (const [re, name] of [...langs, ...TECH]) if (re.test(sec) && !out.includes(name)) out.push(name);
  return out;
}

/** What the agent actually ran: "mvn ×3", "edit ×5", … most used first. */
export function toolsUsed(events: StampedEvent[]): { name: string; n: number }[] {
  const count = new Map<string, number>();
  for (const e of events) {
    if (e.event.type !== "tool_call") continue;
    const s = e.event.summary.replace(/^review: /, "");
    let name: string;
    if (s.startsWith("$ ")) {
      const w = s.slice(2).trim().split(/\s+/);
      name = w[0] === "git" && w[1] ? `git ${w[1]}` : path.basename(w[0] ?? "sh");
      if (/^hexagon$/.test(name)) continue;
    } else name = s.split(/\s/)[0] ?? s;
    count.set(name, (count.get(name) ?? 0) + 1);
  }
  return [...count].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
}
