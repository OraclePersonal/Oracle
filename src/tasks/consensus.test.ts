import { describe, expect, it } from "vitest";
import { ConsensusEngine } from "./consensus.js";
import { SwarmOrchestrator, type SwarmAgent } from "../orchestrator/swarm.js";

describe("Consensus Voting Engine", () => {
  it("approves proposal when quorum and threshold ratio are met", () => {
    const engine = new ConsensusEngine();
    let proposal = engine.createProposal({
      taskId: "task-101",
      proposerAgentId: "coder-1",
      proposedAction: "Refactor core memory module",
      requiredQuorum: 2,
      approvalThresholdRatio: 0.5,
    });

    expect(proposal.status).toBe("pending");

    proposal = engine.castVote(proposal, "reviewer-1", "approve", "Code looks clean and tested.");
    expect(proposal.status).toBe("pending");

    proposal = engine.castVote(proposal, "qa-1", "approve", "Passes all integration tests.");
    expect(proposal.status).toBe("approved");
  });

  it("rejects proposal when threshold is not met upon quorum", () => {
    const engine = new ConsensusEngine();
    let proposal = engine.createProposal({
      taskId: "task-102",
      proposerAgentId: "coder-1",
      proposedAction: "Delete production config file",
      requiredQuorum: 2,
      approvalThresholdRatio: 0.66,
    });

    proposal = engine.castVote(proposal, "reviewer-1", "reject", "High security risk.");
    proposal = engine.castVote(proposal, "qa-1", "reject", "Violates safety policy.");

    expect(proposal.status).toBe("rejected");
  });
});

describe("Swarm Orchestrator", () => {
  it("assigns swarm roles and manages review workflow", () => {
    const orchestrator = new SwarmOrchestrator();
    const agents: SwarmAgent[] = [
      { id: "a1", name: "Architect", role: "architect", capabilities: ["design"] },
      { id: "c1", name: "Coder", role: "coder", capabilities: ["ts"] },
      { id: "r1", name: "Reviewer", role: "reviewer", capabilities: ["review"] },
    ];

    const workflow = orchestrator.createSwarmWorkflow("Build Consensus Engine", agents);
    expect(workflow.assignedRoles.coder).toBe("c1");
    expect(workflow.assignedRoles.reviewer).toBe("r1");

    let proposal = orchestrator.initiateProposal(workflow, "task-201", "c1", "Implement consensus API");
    expect(workflow.proposals).toHaveLength(1);

    proposal = orchestrator.reviewProposal(proposal, "r1", "approve", "Approved");
    proposal = orchestrator.reviewProposal(proposal, "a1", "approve", "Approved spec");
    expect(proposal.status).toBe("approved");
  });
});
