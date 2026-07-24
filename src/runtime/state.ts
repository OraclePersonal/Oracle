import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { VERSION } from "../version.js";

export interface DaemonState {
  pid: number;
  host: string;
  port: number;
  token: string;
  startedAt: string;
  version: string;
  databasePath: string;
  workspaceRoot?: string;
}

export function daemonStatePath(homeDir: string): string {
  return path.join(homeDir, "runtime", "daemon.json");
}

export async function readDaemonState(homeDir: string): Promise<DaemonState | null> {
  try {
    return JSON.parse(await fs.readFile(daemonStatePath(homeDir), "utf8")) as DaemonState;
  } catch {
    return null;
  }
}

export async function writeDaemonState(homeDir: string, state: DaemonState): Promise<void> {
  const filePath = daemonStatePath(homeDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, 0o600);
}

export async function removeDaemonState(homeDir: string, expectedPid?: number): Promise<boolean> {
  const current = await readDaemonState(homeDir);
  if (!current || (expectedPid !== undefined && current.pid !== expectedPid)) return false;
  try {
    await fs.rm(daemonStatePath(homeDir));
    return true;
  } catch {
    return false;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function createDaemonState(input: {
  host: string;
  port: number;
  databasePath: string;
  workspaceRoot?: string;
  token?: string;
}): DaemonState {
  return {
    pid: process.pid,
    host: input.host,
    port: input.port,
    token: input.token ?? crypto.randomBytes(32).toString("hex"),
    startedAt: new Date().toISOString(),
    version: VERSION,
    databasePath: input.databasePath,
    workspaceRoot: input.workspaceRoot
  };
}
