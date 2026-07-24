import type { MessageStore } from "../messaging/store.js";
import { SwarmOrchestrator, type SwarmAgent, type SwarmWorkflow } from "../orchestrator/swarm.js";
import type { SwarmStore } from "../orchestrator/swarmStore.js";
import type { TaskProposal, VoteDecision } from "../tasks/consensus.js";
import type { TaskRecord, TaskStore } from "../tasks/store.js";

export interface CoordinationRecoveryReport {
  workflowsScanned: number;
  workflowsRepaired: number;
  tasksCreated: number;
  proposalsReconciled: number;
  messagesDelivered: number;
  errors: Array<{ workflowId: string; error: string }>;
}

export interface CoordinatedSwarm {
  workflow: SwarmWorkflow;
  task: TaskRecord;
}

/**
 * Durable coordination boundary for TaskStore + MessageStore + SwarmStore.
 *
 * Task state is committed first with a pending coordination event. Message
 * delivery uses a deterministic event id and is marked sent afterwards. A
 * crash between those writes is safe: recover() replays the event and the
 * MessageStore returns the existing deterministic message instead of
 * duplicating it.
 */
export class CoordinationService {
  constructor(
    private readonly tasks: TaskStore,
    private readonly messages: MessageStore,
    private readonly swarms?: SwarmStore
  ) {}

  async createTask(options: Parameters<TaskStore["create"]>[0]): Promise<TaskRecord> {
    const task = await this.tasks.create(options);
    await this.flushTaskEvents(task.id);
    return (await this.tasks.get(task.id)) ?? task;
  }

  async submitTask(taskId: string, agent: string, summary: string): Promise<TaskRecord> {
    const task = await this.tasks.submitForReview(taskId, agent, summary);
    await this.flushTaskEvents(task.id);
    return (await this.tasks.get(task.id)) ?? task;
  }

  async closeTask(taskId: string, agent: string, approved: boolean, note?: string): Promise<TaskRecord> {
    const task = await this.tasks.close(taskId, agent, approved, note);
    await this.flushTaskEvents(task.id);
    return (await this.tasks.get(task.id)) ?? task;
  }

  async castTaskProposalVote(
    proposalId: string,
    agentId: string,
    decision: VoteDecision,
    justification: string
  ): Promise<{ task: TaskRecord; proposal: TaskProposal } | null> {
    const result = await this.tasks.castProposalVote(proposalId, agentId, decision, justification);
    if (!result) return null;
    await this.flushTaskEvents(result.task.id);
    const task = (await this.tasks.get(result.task.id)) ?? result.task;
    return {
      task,
      proposal: task.proposals.find((proposal) => proposal.id === proposalId) ?? result.proposal
    };
  }

  async flushTaskEvents(taskId?: string): Promise<number> {
    let delivered = 0;
    for (const { task, event } of await this.tasks.pendingCoordinationEvents(taskId)) {
      const message = await this.messages.send({
        from: event.from,
        to: event.to,
        subject: event.subject,
        body: event.body,
        taskId: task.id,
        workflowId: task.workflowId,
        coordinationEventId: event.id
      });
      await this.tasks.markCoordinationEventSent(task.id, event.id, message.id);
      delivered++;
    }
    return delivered;
  }

  async createSwarmWorkflow(title: string, agents: SwarmAgent[]): Promise<CoordinatedSwarm> {
    const swarms = this.requireSwarms();
    const workflow = new SwarmOrchestrator().createSwarmWorkflow(title, agents);

    // Persist the initializing workflow first. If the process stops before the
    // linked task is written, recover() can deterministically finish setup.
    await swarms.save(workflow);
    const ensured = await this.ensureWorkflowTask(workflow);
    await this.flushTaskEvents(ensured.task.id);
    const task = (await this.tasks.get(ensured.task.id)) ?? ensured.task;
    ensured.workflow.messageIds = [...task.messageIds];
    await swarms.save(ensured.workflow);
    return { workflow: ensured.workflow, task };
  }

  async proposeSwarmAction(
    workflowId: string,
    proposerAgentId: string,
    proposedAction: string
  ): Promise<{ workflow: SwarmWorkflow; task: TaskRecord; proposal: TaskProposal }> {
    const swarms = this.requireSwarms();
    const workflow = await swarms.get(workflowId);
    if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);
    const ensured = await this.ensureWorkflowTask(workflow);
    await this.flushTaskEvents(ensured.task.id);
    const proposal = await this.tasks.createProposal(
      ensured.task.id,
      proposerAgentId,
      proposedAction,
      { requiredQuorum: 2, approvalThresholdRatio: 0.5 }
    );
    ensured.workflow.proposals.push(proposal);
    ensured.workflow.status = "active";
    await swarms.save(ensured.workflow);
    const task = (await this.tasks.get(ensured.task.id)) ?? ensured.task;
    return { workflow: ensured.workflow, task, proposal };
  }

  async voteOnSwarmProposal(
    proposalId: string,
    agentId: string,
    decision: VoteDecision,
    justification: string
  ): Promise<{ workflow: SwarmWorkflow; task: TaskRecord; proposal: TaskProposal } | null> {
    const swarms = this.requireSwarms();
    let result = await this.tasks.castProposalVote(proposalId, agentId, decision, justification);

    // A legacy workflow may contain a proposal that predates TaskStore
    // linkage. Reconcile it once, then cast the durable TaskStore vote.
    if (!result) {
      const stored = await swarms.findProposal(proposalId);
      if (!stored) return null;
      await this.ensureWorkflowTask(stored.workflow);
      result = await this.tasks.castProposalVote(proposalId, agentId, decision, justification);
      if (!result) return null;
    }

    if (result.proposal.status === "approved" && result.task.checklist[0] && !result.task.checklist[0].done) {
      await this.tasks.setChecklistItem(result.task.id, 0, true);
    }
    await this.flushTaskEvents(result.task.id);

    const task = (await this.tasks.get(result.task.id)) ?? result.task;
    const workflow = task.workflowId
      ? await swarms.get(task.workflowId)
      : await swarms.findByTask(task.id);
    if (!workflow) throw new Error(`Workflow not found for task: ${task.id}`);
    const proposal = task.proposals.find((candidate) => candidate.id === proposalId) ?? result.proposal;
    const index = workflow.proposals.findIndex((candidate) => candidate.id === proposalId);
    if (index >= 0) workflow.proposals[index] = proposal;
    else workflow.proposals.push(proposal);
    workflow.messageIds = [...task.messageIds];
    workflow.status = task.status === "done" ? "completed" : "active";
    await swarms.save(workflow);
    return { workflow, task, proposal };
  }

  async recover(): Promise<CoordinationRecoveryReport> {
    const report: CoordinationRecoveryReport = {
      workflowsScanned: 0,
      workflowsRepaired: 0,
      tasksCreated: 0,
      proposalsReconciled: 0,
      messagesDelivered: 0,
      errors: []
    };

    if (this.swarms) {
      for (const workflow of await this.swarms.list()) {
        report.workflowsScanned++;
        try {
          const beforeTaskId = workflow.primaryTaskId;
          const beforeProposalTaskIds = new Map(
            workflow.proposals.map((proposal) => [proposal.id, proposal.taskId])
          );
          const linkedBefore = await this.tasks.list({ workflowId: workflow.id });
          const ensured = await this.ensureWorkflowTask(workflow);
          if (linkedBefore.length === 0) report.tasksCreated++;

          const task = (await this.tasks.get(ensured.task.id)) ?? ensured.task;
          const reconciledForWorkflow = task.proposals.filter(
            (proposal) => !beforeProposalTaskIds.has(proposal.id)
              || beforeProposalTaskIds.get(proposal.id) !== task.id
          ).length;
          report.proposalsReconciled += reconciledForWorkflow;

          const wasRepaired = beforeTaskId !== ensured.workflow.primaryTaskId
            || linkedBefore.length === 0
            || reconciledForWorkflow > 0;
          if (wasRepaired) report.workflowsRepaired++;

          ensured.workflow.recovery = {
            attempts: (ensured.workflow.recovery?.attempts ?? 0) + 1,
            lastRecoveredAt: new Date().toISOString()
          };
          ensured.workflow.messageIds = [...task.messageIds];
          await this.swarms.save(ensured.workflow);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          workflow.status = "blocked";
          workflow.recovery = {
            attempts: (workflow.recovery?.attempts ?? 0) + 1,
            lastRecoveredAt: new Date().toISOString(),
            lastError: message
          };
          await this.swarms.save(workflow);
          report.errors.push({ workflowId: workflow.id, error: message });
        }
      }
    }

    report.messagesDelivered = await this.flushTaskEvents();

    if (this.swarms) {
      for (const workflow of await this.swarms.list()) {
        if (!workflow.primaryTaskId) continue;
        const task = await this.tasks.get(workflow.primaryTaskId);
        if (!task) continue;
        workflow.messageIds = [...task.messageIds];
        workflow.status = task.status === "done" ? "completed" : "active";
        await this.swarms.save(workflow);
      }
    }

    return report;
  }

  private requireSwarms(): SwarmStore {
    if (!this.swarms) throw new Error("SwarmStore is required for workflow coordination.");
    return this.swarms;
  }

  private async ensureWorkflowTask(
    workflow: SwarmWorkflow
  ): Promise<{ workflow: SwarmWorkflow; task: TaskRecord }> {
    const swarms = this.requireSwarms();
    const linkedTasks = await this.tasks.list({ workflowId: workflow.id });
    let task = workflow.primaryTaskId
      ? await this.tasks.get(workflow.primaryTaskId)
      : null;
    if (!task || task.workflowId !== workflow.id) task = linkedTasks[0] ?? null;

    if (!task) {
      const architect = workflow.assignedRoles.architect ?? "oracle";
      const coder = workflow.assignedRoles.coder ?? architect;
      task = await this.tasks.create({
        title: workflow.title,
        description: `Primary task for swarm workflow ${workflow.id}.`,
        createdBy: architect,
        assignee: coder,
        checklist: ["Consensus proposal approved", "Implementation verified"],
        workflowId: workflow.id
      });
    }

    for (const proposal of workflow.proposals) {
      const current = task.proposals.find((candidate) => candidate.id === proposal.id);
      if (!current) {
        task = await this.tasks.upsertProposal(task.id, { ...proposal, taskId: task.id });
      }
    }

    // TaskStore is authoritative after legacy proposals have been imported.
    task = (await this.tasks.get(task.id)) ?? task;
    workflow.primaryTaskId = task.id;
    workflow.taskIds = Array.from(new Set([...workflow.taskIds, ...linkedTasks.map((item) => item.id), task.id]));
    workflow.proposals = task.proposals.map((proposal) => ({
      ...proposal,
      votes: proposal.votes.map((vote) => ({ ...vote }))
    }));
    workflow.messageIds = [...task.messageIds];
    workflow.status = task.status === "done" ? "completed" : "active";
    await swarms.save(workflow);
    return { workflow, task };
  }
}
