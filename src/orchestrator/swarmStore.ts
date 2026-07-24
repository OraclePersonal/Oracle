import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { SwarmWorkflow } from "./swarm.js";
import type { TaskProposal } from "../tasks/consensus.js";

export interface StoredSwarmProposal {
  workflow: SwarmWorkflow;
  proposal: TaskProposal;
}

/**
 * File-backed swarm workflow store. Each workflow is persisted independently
 * so separate `oracle swarm` CLI invocations share the same state.
 */
export class SwarmStore {
  constructor(private readonly homeDir: string) {}

  private dir(): string {
    return path.join(this.homeDir, "swarms");
  }

  private filePath(id: string): string {
    if (!/^swarm_[a-z0-9_-]+$/i.test(id)) {
      throw new Error(`Invalid swarm workflow id "${id}".`);
    }
    return path.join(this.dir(), `${id}.json`);
  }

  async save(workflow: SwarmWorkflow): Promise<void> {
    await fs.mkdir(this.dir(), { recursive: true });
    workflow.updatedAt = new Date().toISOString();
    const filePath = this.filePath(workflow.id);
    const temporaryPath = `${filePath}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(workflow, null, 2), "utf8");
    await fs.rename(temporaryPath, filePath);
  }

  async get(id: string): Promise<SwarmWorkflow | null> {
    try {
      const workflow = JSON.parse(await fs.readFile(this.filePath(id), "utf8")) as SwarmWorkflow;
      if (!Array.isArray(workflow.proposals)) workflow.proposals = [];
      if (!Array.isArray(workflow.taskIds)) workflow.taskIds = [];
      if (!Array.isArray(workflow.messageIds)) workflow.messageIds = [];
      if (!workflow.status) workflow.status = workflow.taskIds.length ? "active" : "initializing";
      if (!workflow.recovery) workflow.recovery = { attempts: 0 };
      return workflow;
    } catch {
      return null;
    }
  }

  async list(): Promise<SwarmWorkflow[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir());
    } catch {
      return [];
    }
    const workflows = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => this.get(entry.slice(0, -".json".length)))
    );
    return workflows
      .filter((workflow): workflow is SwarmWorkflow => workflow !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async findProposal(proposalId: string): Promise<StoredSwarmProposal | null> {
    for (const workflow of await this.list()) {
      const proposal = workflow.proposals.find((candidate) => candidate.id === proposalId);
      if (proposal) return { workflow, proposal };
    }
    return null;
  }

  async findByTask(taskId: string): Promise<SwarmWorkflow | null> {
    return (await this.list()).find((workflow) => workflow.taskIds.includes(taskId)) ?? null;
  }
}
