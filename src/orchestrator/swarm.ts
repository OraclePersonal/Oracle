import { ConsensusEngine, type TaskProposal, type VoteDecision } from "../tasks/consensus.js";

export type AgentRole = "architect" | "coder" | "reviewer" | "qa";

export interface SwarmAgent {
  id: string;
  name: string;
  role: AgentRole;
  capabilities: string[];
}

export interface SwarmWorkflow {
  id: string;
  title: string;
  assignedRoles: Record<AgentRole, string>; // Role -> Agent ID
  proposals: TaskProposal[];
  createdAt: string;
  updatedAt: string;
}

export class SwarmOrchestrator {
  private consensusEngine = new ConsensusEngine();

  /**
   * Create a multi-agent workflow assignment for a complex feature or bug fix.
   */
  createSwarmWorkflow(title: string, agents: SwarmAgent[]): SwarmWorkflow {
    const assignedRoles: Partial<Record<AgentRole, string>> = {};
    const now = new Date().toISOString();

    for (const a of agents) {
      if (!assignedRoles[a.role]) {
        assignedRoles[a.role] = a.id;
      }
    }

    return {
      id: `swarm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      title,
      assignedRoles: assignedRoles as Record<AgentRole, string>,
      proposals: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Initiate a proposal by the coder/architect and request votes from reviewers/QA.
   */
  initiateProposal(
    workflow: SwarmWorkflow,
    taskId: string,
    proposerAgentId: string,
    proposedAction: string
  ): TaskProposal {
    const proposal = this.consensusEngine.createProposal({
      taskId,
      proposerAgentId,
      proposedAction,
      requiredQuorum: 2,
      approvalThresholdRatio: 0.5,
    });

    workflow.proposals.push(proposal);
    workflow.updatedAt = new Date().toISOString();
    return proposal;
  }

  /**
   * Submit a review vote by a swarm agent.
   */
  reviewProposal(
    proposal: TaskProposal,
    reviewerAgentId: string,
    decision: VoteDecision,
    justification: string
  ): TaskProposal {
    return this.consensusEngine.castVote(proposal, reviewerAgentId, decision, justification);
  }
}
