#!/usr/bin/env node
import { runServer } from "./server.js";

const ROOT_DIR = process.env.ORACLE_MEMORY_ROOT_DIR ?? process.env.AGOYA_ROOT_DIR ?? process.cwd();
const DISABLE_VECTORS = process.env.ORACLE_MEMORY_DISABLE_VECTORS === "1" || process.env.ORACLE_MEMORY_DISABLE_VECTORS === "true" || process.env.AGOYA_DISABLE_VECTORS === "1" || process.env.AGOYA_DISABLE_VECTORS === "true";

async function main(): Promise<void> {
  console.error(`oracle-memory: starting MCP memory server`);
  console.error(`oracle-memory: root dir = ${ROOT_DIR}`);
  if (!DISABLE_VECTORS) {
    console.error(`oracle-memory: vector search enabled (set ORACLE_MEMORY_DISABLE_VECTORS=1 to disable)`);
  }

  const shutdown = await runServer(ROOT_DIR, DISABLE_VECTORS);

  // Graceful shutdown on SIGTERM / SIGINT
  const handleSignal = async (signal: string) => {
    console.error(`oracle-memory: received ${signal}, shutting down...`);
    await shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", () => handleSignal("SIGTERM"));
  process.on("SIGINT", () => handleSignal("SIGINT"));
}

main().catch((e) => {
  console.error("oracle-memory: fatal error:", e);
  process.exit(1);
});
