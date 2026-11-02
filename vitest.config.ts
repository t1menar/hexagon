import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";
// Tests never touch the real user token directory.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 30000, env: { HEXAGON_NO_REAL_CLI: "1", HEXAGON_STATE_DIR: path.join(os.tmpdir(), "hexagon-test-state") } } });
