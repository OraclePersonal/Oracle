import crypto from "node:crypto";
import { approvalPayloadHash } from "../control/payload.js";
import type { ApprovalRisk } from "../control/types.js";
import { AuditLogger, type AuditRecord } from "../observability/audit.js";
import { logAgent, logTool } from "../observability/log.js";
import { AuditTrail } from "./audit.js";
import type { AgentApprovalGate, ToolRiskAssessment } from "./approvalGate.js";
import type {
  CheckpointRecord,
  CheckpointStore
} from "./checkpoint.js";
import { PolicyViolationError } from "./policy.js";
import type {
  AgentContext,
  AgentMessage,
  AgentProvider,
  AgentTool,
  ContentBlock,
  ToolCall,
  ToolResult
} from "./types.js";

export interface AgentStep {
  turn: number;
  text: string;
  toolsUsed: string[];
}

export interface AgentWaitingApproval {
  approvalId?: string;
  checkpointId: string;
  toolName: string;
  risk: ApprovalRisk;
  reason: string;
  error?: string;
}

export interface AgentRunResult {
  finalText: string;
  transcript: AgentMessage[];
  steps: AgentStep[];
  stoppedOnLimit: boolean;
  usage: { inputTokens: number; outputTokens: number };
  audit: { getChanges(): any[]; getSummary(): any };
  checkpointId?: string;
  waitingForApproval?: AgentWaitingApproval;
}

export interface RunAgentLoopParams {
  provider: AgentProvider;
  model: string;
  system: string;
  prompt: string;
  tools: AgentTool[];
  context: AgentContext;
  maxSteps?: number;
  onStep?: (step: AgentStep) => void | Promise<void>;
  checkpointStore?: CheckpointStore;
  resumeCheckpointId?: string;
  approvalGate?: AgentApprovalGate;
}

interface PendingApproval {
  callId: string;
  approvalId?: string;
  payloadHash: string;
  risk: ApprovalRisk;
  reason: string;
  error?: string;
}

interface PendingToolBatch {
  turn: number;
  calls: ToolCall[];
  nextIndex: number;
  results: ToolResult[];
  approval?: PendingApproval;
}

function persistentAuditAction(toolName: string): AuditRecord["action"] {
  if (["read_file", "read_image", "read_video", "list_dir", "glob", "grep"].includes(toolName)) return "read";
  if (toolName === "write_file") return "write";
  if (toolName === "edit_file") return "edit";
  if (toolName === "delete_file") return "delete";
  if (toolName === "bash") return "bash";
  return "tool";
}

function persistentAuditTarget(toolName: string, input: Record<string, unknown>): string {
  if (typeof input.path === "string") return input.path;
  if (typeof input.command === "string") {
    const executable = input.command.trim().split(/\s+/, 1)[0] || "shell";
    return `bash:${executable.slice(0, 80)}`;
  }
  return toolName;
}

function approvalAction(call: ToolCall, workspaceRoot: string): {
  type: string;
  payload: Record<string, unknown>;
} {
  return {
    type: "agent.tool",
    payload: {
      toolName: call.name,
      input: call.input,
      workspaceRoot
    }
  };
}

export async function runAgentLoop(params: RunAgentLoopParams): Promise<AgentRunResult> {
  const {
    provider,
    model,
    system,
    prompt,
    tools,
    context,
    checkpointStore,
    approvalGate
  } = params;
  const maxSteps = params.maxSteps ?? 20;
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const audit = new AuditTrail();
  const persistentAudit = new AuditLogger();
  const toolNames = tools.map((tool) => tool.name).sort();

  let checkpointId = params.resumeCheckpointId;
  let checkpointCreatedAt = new Date().toISOString();
  let transcript: AgentMessage[];
  let steps: AgentStep[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let finalText = "";
  let startTurn = 1;
  let pendingBatch: PendingToolBatch | undefined;

  if (checkpointId && checkpointStore) {
    const checkpoint = await checkpointStore.load(checkpointId);
    if (checkpoint) {
      const checkpointTools = checkpoint.toolNames ?? [];
      if (
        checkpointTools.length
        && JSON.stringify(checkpointTools) !== JSON.stringify(toolNames)
      ) {
        logAgent("resume-warn", { checkpointId, msg: "tool set differs from checkpoint" });
      }
      transcript = checkpoint.transcript;
      inputTokens = checkpoint.usage.inputTokens;
      outputTokens = checkpoint.usage.outputTokens;
      checkpointCreatedAt = checkpoint.createdAt;
      pendingBatch = checkpoint.pendingToolBatch;
      finalText = transcript
        .filter((message): message is Extract<AgentMessage, { role: "assistant" }> =>
          message.role === "assistant")
        .map((message) => message.text)
        .filter(Boolean)
        .at(-1) ?? "";
      startTurn = checkpoint.turn + 1;
      logAgent("resume", {
        checkpointId,
        fromTurn: startTurn,
        maxSteps,
        waitingApproval: Boolean(pendingBatch?.approval)
      });
    } else {
      logAgent("resume-miss", { checkpointId });
      checkpointId = undefined;
      transcript = initialTranscript(prompt);
    }
  } else {
    transcript = initialTranscript(prompt);
  }

  if (!checkpointId && checkpointStore) {
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
    checkpointId = `cp-${timestamp}-${crypto.randomBytes(4).toString("hex")}`;
  }

  const completedCallIds = new Set([
    ...transcript
      .filter((message): message is Extract<AgentMessage, { role: "tool" }> =>
        message.role === "tool")
      .flatMap((message) => message.results)
      .map((toolResult) => toolResult.id),
    ...(pendingBatch?.results.map((toolResult) => toolResult.id) ?? [])
  ]);
  let mutationCount = transcript
    .filter((message): message is Extract<AgentMessage, { role: "assistant" }> =>
      message.role === "assistant")
    .flatMap((message) => message.toolCalls)
    .filter((call) => completedCallIds.has(call.id) && toolsByName.get(call.name)?.mutating)
    .length;
  const contextWithAudit = { ...context, audit };

  const saveCheckpoint = async (
    turn: number,
    batch?: PendingToolBatch,
    status: CheckpointRecord["status"] = "active"
  ): Promise<void> => {
    if (!checkpointId || !checkpointStore) return;
    const checkpoint: CheckpointRecord = {
      id: checkpointId,
      system,
      model,
      transcript: [...transcript],
      turn,
      maxSteps,
      toolNames,
      status,
      pendingToolBatch: batch,
      usage: { inputTokens, outputTokens },
      createdAt: checkpointCreatedAt,
      updatedAt: new Date().toISOString()
    };
    await checkpointStore.save(checkpoint).catch((error: unknown) => {
      logAgent("checkpoint-error", { checkpointId, error: String(error) });
    });
  };

  const result = (
    stoppedOnLimit: boolean,
    waitingForApproval?: AgentWaitingApproval
  ): AgentRunResult => ({
    finalText,
    transcript,
    steps,
    stoppedOnLimit,
    usage: { inputTokens, outputTokens },
    audit,
    checkpointId,
    waitingForApproval
  });

  const executeTool = async (
    call: ToolCall,
    tool: AgentTool,
    turn: number
  ): Promise<ToolResult> => {
    try {
      logTool("call", { toolName: call.name, turn });
      const callStart = Date.now();
      if (
        tool.mutating
        && context.policy
        && mutationCount >= context.policy.maxMutationsPerSession
      ) {
        throw new PolicyViolationError(
          `Mutation limit reached (${context.policy.maxMutationsPerSession} per session).`,
          "max_mutations_per_session"
        );
      }
      const output = await tool.execute(call.input, contextWithAudit);
      if (tool.mutating) mutationCount += 1;
      const durationMs = Date.now() - callStart;
      const content: ContentBlock[] = typeof output === "string"
        ? [{ type: "text", text: output }]
        : output;
      logTool("result", {
        toolName: call.name,
        turn,
        durationMs,
        outputSize: JSON.stringify(output).length
      });
      await persistentAudit.log(context.workspaceRoot, {
        action: persistentAuditAction(call.name),
        target: persistentAuditTarget(call.name, call.input),
        agentId: provider.id,
        details: { toolName: call.name, turn, durationMs }
      }).catch(() => {});
      return { id: call.id, content };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logTool("error", { toolName: call.name, turn, error: errorMessage });
      await persistentAudit.log(context.workspaceRoot, {
        action: error instanceof PolicyViolationError ? "policy_denied" : "tool",
        target: persistentAuditTarget(call.name, call.input),
        agentId: provider.id,
        details: {
          toolName: call.name,
          turn,
          error: errorMessage,
          ...(error instanceof PolicyViolationError ? { rule: error.rule } : {})
        }
      }).catch(() => {});
      return {
        id: call.id,
        content: [{ type: "text", text: errorMessage }],
        isError: true
      };
    }
  };

  const waitForApproval = async (
    batch: PendingToolBatch,
    call: ToolCall,
    assessment: ToolRiskAssessment,
    error?: string
  ): Promise<AgentRunResult> => {
    const pending = batch.approval ?? {
      callId: call.id,
      payloadHash: approvalPayloadHash(approvalAction(call, context.workspaceRoot)),
      risk: assessment.risk,
      reason: assessment.reason
    };
    pending.error = error;
    batch.approval = pending;
    await saveCheckpoint(batch.turn, batch, "waiting_approval");
    logAgent("approval-wait", {
      checkpointId,
      approvalId: pending.approvalId,
      toolName: call.name,
      risk: pending.risk,
      error
    });
    return result(false, {
      approvalId: pending.approvalId,
      checkpointId: checkpointId!,
      toolName: call.name,
      risk: pending.risk,
      reason: pending.reason,
      error
    });
  };

  const processBatch = async (batch: PendingToolBatch): Promise<AgentRunResult | undefined> => {
    for (let index = batch.nextIndex; index < batch.calls.length; index++) {
      const call = batch.calls[index];
      const tool = toolsByName.get(call.name);
      if (!tool) {
        logTool("error", { toolName: call.name, error: "unknown tool" });
        batch.results.push({
          id: call.id,
          content: [{ type: "text", text: `Unknown tool: ${call.name}` }],
          isError: true
        });
        batch.nextIndex = index + 1;
        continue;
      }

      const assessment = approvalGate?.assess(tool, call.input) ?? null;
      if (assessment && (!checkpointId || !checkpointStore)) {
        throw new Error(
          `Approval-gated tool ${call.name} cannot run without checkpoint persistence.`
        );
      }
      if (assessment && checkpointId && checkpointStore && approvalGate) {
        const expectedHash = approvalPayloadHash(approvalAction(call, context.workspaceRoot));
        let pending = batch.approval?.callId === call.id ? batch.approval : undefined;
        if (!pending) {
          pending = {
            callId: call.id,
            payloadHash: expectedHash,
            risk: assessment.risk,
            reason: assessment.reason
          };
          batch.approval = pending;
        }
        if (pending.payloadHash !== expectedHash) {
          throw new Error(`Checkpoint payload integrity check failed for tool call ${call.id}.`);
        }

        let approval;
        try {
          approval = pending.approvalId
            ? await approvalGate.get(pending.approvalId)
            : await approvalGate.request({
                call,
                tool,
                checkpointId,
                workspaceRoot: context.workspaceRoot,
                requestedBy: provider.id,
                assessment
              });
          if (!approval) {
            pending.approvalId = undefined;
            return waitForApproval(
              batch,
              call,
              assessment,
              `Approval ${pending.approvalId} no longer exists.`
            );
          }
          pending.approvalId = approval.id;
          pending.error = undefined;
        } catch (error) {
          return waitForApproval(
            batch,
            call,
            assessment,
            error instanceof Error ? error.message : String(error)
          );
        }

        if (approval.payloadHash !== expectedHash) {
          throw new Error(`Approval ${approval.id} does not match checkpoint tool call ${call.id}.`);
        }
        if (approval.status === "pending") {
          return waitForApproval(batch, call, assessment);
        }
        if (approval.status !== "approved") {
          batch.results.push({
            id: call.id,
            content: [{
              type: "text",
              text: `Human approval ${approval.status}: ${approval.decisionNote ?? "No decision note."}`
            }],
            isError: true
          });
          batch.approval = undefined;
          batch.nextIndex = index + 1;
          continue;
        }

        const { execution } = await approvalGate.claim(approval, provider.id);
        const toolResult = await executeTool(call, tool, batch.turn);
        await approvalGate.complete(
          execution.id,
          toolResult.isError ? "failed" : "completed",
          {
            toolCallId: call.id,
            toolName: call.name,
            isError: Boolean(toolResult.isError)
          }
        );
        batch.results.push(toolResult);
        batch.approval = undefined;
        batch.nextIndex = index + 1;
        continue;
      }

      batch.results.push(await executeTool(call, tool, batch.turn));
      batch.nextIndex = index + 1;
    }

    transcript.push({ role: "tool", results: batch.results });
    await saveCheckpoint(batch.turn);
    return undefined;
  };

  logAgent("start", {
    model,
    toolCount: tools.length,
    maxSteps,
    resumeFrom: startTurn > 1 ? startTurn : undefined
  });

  if (pendingBatch) {
    const waiting = await processBatch(pendingBatch);
    if (waiting) return waiting;
    pendingBatch = undefined;
  }

  let stoppedOnLimit = true;
  for (let turn = startTurn; turn <= maxSteps; turn++) {
    const turnStart = Date.now();
    let turnResult;
    try {
      turnResult = await provider.runAgentTurn({
        model,
        system,
        messages: transcript,
        tools
      });
    } catch (error) {
      await saveCheckpoint(turn - 1);
      throw error;
    }

    const durationMs = Date.now() - turnStart;
    const auditSummary = audit.getSummary();
    logAgent("audit-summary", {
      turn,
      mutations: auditSummary.mutations,
      filesChanged: auditSummary.filesChanged
    });
    transcript.push(turnResult.message);
    inputTokens += turnResult.usage?.inputTokens ?? 0;
    outputTokens += turnResult.usage?.outputTokens ?? 0;

    const { text, toolCalls } = turnResult.message;
    const step: AgentStep = { turn, text, toolsUsed: toolCalls.map((call) => call.name) };
    steps.push(step);
    if (params.onStep) {
      try {
        await params.onStep(step);
      } catch {
        // Progress hooks are non-fatal.
      }
    }

    if (toolCalls.length === 0) {
      finalText = text;
      stoppedOnLimit = false;
      if (checkpointId && checkpointStore) {
        await checkpointStore.delete(checkpointId).catch(() => {});
        checkpointId = undefined;
      }
      break;
    }

    if (text) finalText = text;
    const batch: PendingToolBatch = {
      turn,
      calls: toolCalls,
      nextIndex: 0,
      results: []
    };
    const waiting = await processBatch(batch);
    if (waiting) return waiting;
    logAgent("turn", { turn, toolsUsed: toolCalls.length, durationMs });
  }

  const auditSummary = audit.getSummary();
  logAgent("stop", {
    turns: steps.length,
    stoppedOnLimit,
    totalInputTokens: inputTokens,
    totalOutputTokens: outputTokens,
    mutations: auditSummary.mutations,
    filesChanged: auditSummary.filesChanged
  });
  return result(stoppedOnLimit);
}

function initialTranscript(prompt: string): AgentMessage[] {
  return [{
    role: "user",
    content: [{ type: "text", text: prompt }]
  }];
}
