#!/usr/bin/env node
// Daemon entry: `node dist/daemon/main.js <project-root>`. Started automatically by clients.
import { DaemonServer } from "./server.js";

const root = process.argv[2] ?? process.cwd();
const server = new DaemonServer(root);

process.on("SIGTERM", () => server.stop(0));
process.on("SIGINT", () => server.stop(0));
process.on("uncaughtException", (e) => {
  console.error(`[${new Date().toISOString()}] uncaught:`, e);
});
process.on("unhandledRejection", (e) => {
  console.error(`[${new Date().toISOString()}] unhandled rejection:`, e);
});

server.listen().then(
  () => console.log(`[${new Date().toISOString()}] hexagon daemon listening for ${root} (pid ${process.pid})`),
  (e) => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  },
);
