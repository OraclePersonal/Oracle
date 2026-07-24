import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repositoryRoot, "dist", "cli.js");
const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-runtime-smoke-"));

function run(args, allowFailure = false) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      ORACLE_HOME_DIR: temporaryRoot,
      NODE_NO_WARNINGS: "1"
    },
    encoding: "utf8",
    timeout: 15_000
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `oracle ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`
    );
  }
  return `${result.stdout}${result.stderr}`;
}

try {
  const started = run(["daemon", "start", "--port", "0"]);
  if (!started.includes("Oracle Runtime started")) throw new Error(started);

  const status = run(["daemon", "status", "--json"]);
  const parsedStatus = JSON.parse(status);
  if (!parsedStatus.running || parsedStatus.health?.storage !== "sqlite") {
    throw new Error(`Unexpected daemon status: ${status}`);
  }
  if (JSON.stringify(parsedStatus).includes("token")) {
    throw new Error("Daemon status leaked the API token.");
  }

  const created = run([
    "schedule", "add",
    "runtime smoke",
    "*/5 * * * *",
    "node -e \"process.stdout.write('runtime-smoke-ok')\""
  ]);
  const taskId = created.match(/[0-9]{17}-[a-f0-9]{8}/)?.[0];
  if (!taskId) throw new Error(`Could not parse scheduler task id:\n${created}`);

  const output = run(["schedule", "run", taskId]);
  if (!output.includes("runtime-smoke-ok")) throw new Error(output);

  const databasePath = path.join(temporaryRoot, "runtime", "oracle.db");
  await fs.stat(databasePath);
} finally {
  run(["daemon", "stop"], true);
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

console.log("Runtime smoke tests passed.");
