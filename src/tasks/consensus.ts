export type VoteDecision = "approve" | "reject" | "abstain";

export interface AgentVote {
  agentId: string;
  decision: VoteDecision;
  justification: string;
  timestamp: string;
}

export interface TaskProposal {
  id: string;
  taskId: string;
  proposerAgentId: string;
  proposedAction: string;
  requiredQuorum: number;
  approvalThresholdRatio: number; // e.g. 0.66 for 2/3 majority
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  votes: AgentVote[];
}

export class ConsensusEngine {
  /**
   * Create a new task proposal requiring multi-agent consensus.
   */
  createProposal(opts: {
    taskId: string;
    proposerAgentId: string;
    proposedAction: string;
    requiredQuorum?: number;
    approvalThresholdRatio?: number;
  }): TaskProposal {
    return {
      id: `prop_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      taskId: opts.taskId,
      proposerAgentId: opts.proposerAgentId,
      proposedAction: opts.proposedAction,
      requiredQuorum: opts.requiredQuorum ?? 2,
      approvalThresholdRatio: opts.approvalThresholdRatio ?? 0.66,
      status: "pending",
      createdAt: new Date().toISOString(),
      votes: [],
    };
  }

  /**
   * Cast a vote on a proposal (by id or object) and update consensus status.
   * When a proposalId is passed, a lightweight proposal shell is created.
   */
  castVote(
    proposalOrId: TaskProposal | string,
    agentId: string,
    decision: VoteDecision,
    justification: string
  ): TaskProposal {
    const proposal: TaskProposal = typeof proposalOrId === "string"
      ? { id: proposalOrId, taskId: proposalOrId, proposerAgentId: "", proposedAction: "", requiredQuorum: 2, approvalThresholdRatio: 0.66, status: "pending", createdAt: new Date().toISOString(), votes: [] }
      : proposalOrId;
    if (proposal.status !== "pending") return proposal;

    // Record or update vote
    const existingIndex = proposal.votes.findIndex((v) => v.agentId === agentId);
    const voteRecord: AgentVote = {
      agentId,
      decision,
      justification,
      timestamp: new Date().toISOString(),
    };

    if (existingIndex >= 0) {
      proposal.votes[existingIndex] = voteRecord;
    } else {
      proposal.votes.push(voteRecord);
    }

    return this.evaluateConsensus(proposal);
  }

  /**
   * Evaluate whether quorum and threshold ratio have been met.
   */
  evaluateConsensus(proposal: TaskProposal): TaskProposal {
    const activeVotes = proposal.votes.filter((v) => v.decision !== "abstain");
    if (activeVotes.length < proposal.requiredQuorum) {
      proposal.status = "pending";
      return proposal;
    }

    const approvals = activeVotes.filter((v) => v.decision === "approve").length;
    const ratio = approvals / activeVotes.length;

    if (ratio >= proposal.approvalThresholdRatio) {
      proposal.status = "approved";
    } else if (activeVotes.length >= proposal.requiredQuorum) {
      proposal.status = "rejected";
    }

    return proposal;
  }
}
