import fs from "node:fs/promises";
import type { OracleRegistry } from "../oracles/registry.js";

// ponytail: file-based peer sharing. Add HTTP/gRPC when you have >1 machine.

export interface PeerPackage {
  oracles: Array<{ profile: Record<string, unknown>; memory?: Record<string, unknown>[] }>;
  skills: Record<string, unknown>[];
}

export async function exportPeerPackage(
  registry: OracleRegistry,
  oracleNames: string[]
): Promise<PeerPackage> {
  const pkg: PeerPackage = { oracles: [], skills: [] };
  for (const name of oracleNames) {
    const data = await registry.exportOracle(name);
    pkg.oracles.push(data as PeerPackage["oracles"][0]);
  }
  return pkg;
}

export async function importPeerPackage(
  registry: OracleRegistry,
  filePath: string
): Promise<string[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const pkg = JSON.parse(raw) as PeerPackage;
  const imported: string[] = [];
  for (const item of pkg.oracles) {
    await registry.importOracle(item as { profile: any; memory?: any[] });
    imported.push(item.profile.name as string);
  }
  return imported;
}
