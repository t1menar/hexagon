#!/usr/bin/env node
// Daemon entry. Normally started by clients as `hexagon __daemon <root>`; this file allows
// `node dist/daemon/main.js <root>` for debugging.
import { runDaemon } from "./run.js";

runDaemon(process.argv[2] ?? process.cwd());
