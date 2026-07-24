import type {
  AgentContext,
  AgentMessage,
  AgentProvider,
  AgentTool,
  ToolResult,
  ContentBlock,
} from "./types.js";
import { AuditTrail } from "./audit.js";
import { logAgent, logTool } from "../observability/log.js";
import crypto from "node:crypto";
import type { CheckpointStore } from "./checkpoint.js";

export interface AgentStep {
  /** 1-based index of this assistant turn. */
  turn: number;
  /** Any text the assistant produced this turn. */
  text: string;
  /** Names of tools invoked this turn. */
  toolsUsed: string[];
}

export interface AgentRunResult {
  /** The assistant's final text answer (last turn with no tool calls). */
  finalText: string;
  /** Full neutral transcript, useful for persistence/debugging. */
  transcript: AgentMessage[];
  /** Per-turn summary. */
  steps: AgentStep[];
  /** True if the loop hit maxSteps before the model stopped calling tools. */
  stoppedOnLimit: boolean;
  usage: { inputTokens: number; outputTokens: number };
  /** Audit trail of file operations performed by the agent. */
  audit: { getChanges(): any[]; getSummary(): any };
  /** Checkpoint id, if checkpointing was enabled. Save this to resume later. */
  checkpointId?: string;
}

export interface RunAgentLoopParams {
  provider: AgentProvider;
  model: string;
  system: string;
  prompt: string;
  tools: AgentTool[];
  context: AgentContext;
  /** Max assistant turns before giving up (default 20). */
  maxSteps?: number;
  /** Optional callback fired after each turn (for progress reporting). */
  onStep?: (step: AgentStep) => void | Promise<void>;
  /**
   * Enable checkpoint persistence. Provide a CheckpointStore and the id of a
   * checkpoint to resume from, or a new id to create a fresh checkpoint chain.
   */
  checkpointStore?: CheckpointStore;
  resumeCheckpointId?: string;
}

/**
 * Run the agentic tool-use loop: the model alternates between producing text
 * and requesting tool calls; we execute each tool, feed the results back, and
 * repeat until the model answers without calling any tool (or we hit maxSteps).
 *
 * The loop is provider-agnostic — `provider.runAgentTurn` owns all wire-format
 * translation, and `tools` own all side effects (confined by `context`).
 */
export async function runAgentLoop(params: RunAgentLoopParams): Promise<AgentRunResult> {
  const { provider, model, system, prompt, tools, context, checkpointStore } = params;
  const maxSteps = params.maxSteps ?? 20;
  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  const audit = new AuditTrail();
  const toolNames = tools.map((t) => t.name).sort();

  // ── Resume from checkpoint? ────────────────────────────────────────
  let checkpointId = params.resumeCheckpointId;
  let transcript: AgentMessage[];
  let steps: AgentStep[];
  let inputTokens: number;
  let outputTokens: number;
  let finalText: string;
  let startTurn: number;

  if (checkpointId && checkpointStore) {
    const cp = await checkpointStore.load(checkpointId);
    if (cp) {
      // Verify the tool environment hasn't changed in incompatible ways
      const cpTools: string[] = cp.toolNames ?? [];
      if (cpTools.length && JSON.stringify(cpTools) !== JSON.stringify(toolNames)) {
        logAgent("resume-warn", { checkpointId, msg: "tool set differs from checkpoint" });
      }
      transcript = cp.transcript;
      steps = [];
      inputTokens = cp.usage.inputTokens;
      outputTokens = cp.usage.outputTokens;
      finalText = transcript
        .filter((m): m is Extract<AgentMessage, { role: "assistant" }> => m.role === "assistant")
        .map((m) => m.text)
        .filter(Boolean)
        .pop() ?? "";
      startTurn = cp.turn + 1;
      logAgent("resume", { checkpointId, fromTurn: startTurn, maxSteps });
    } else {
      logAgent("resume-miss", { checkpointId });
      checkpointId = undefined;
      startTurn = 1;
      const userContent = typeof prompt === "string" ? [{ type: "text" as const, text: prompt }] : prompt;
      transcript = [{ role: "user", content: userContent }];
      steps = [];
      inputTokens = 0;
      outputTokens = 0;
      finalText = "";
    }
  } else {
    startTurn = 1;
    const userContent = typeof prompt === "string" ? [{ type: "text" as const, text: prompt }] : prompt;
    transcript = [{ role: "user", content: userContent }];
    steps = [];
    inputTokens = 0;
    outputTokens = 0;
    finalText = "";
  }

  // Allocate a new checkpoint id for fresh runs
  if (!checkpointId && checkpointStore) {
    const ts = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
    checkpointId = `cp-${ts}-${crypto.randomBytes(4).toString("hex")}`;
  }

  let stoppedOnLimit = true;

  logAgent("start", { model, toolCount: tools.length, maxSteps, resumeFrom: startTurn > 1 ? startTurn : undefined });

  // Inject audit trail into context for tools to record
  const contextWithAudit = { ...context, audit };

  for (let turn = startTurn; turn <= maxSteps; turn++) {
    const turnStart = Date.now();
    let result;
    try {
      result = await provider.runAgentTurn({ model, system, messages: transcript, tools });
    } catch (err) {
      // Save a checkpoint before re-throwing so a crash mid-run can resume
      if (checkpointId && checkpointStore) {
        const checkpoint = {
          id: checkpointId,
          system,
          model,
          transcript: [...transcript],
          turn: turn - 1, // last completed turn
          maxSteps,
          toolNames,
          usage: { inputTokens, outputTokens },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await checkpointStore.save(checkpoint).catch(() => {});
      }
      throw err;
    }
    const turnMs = Date.now() - turnStart;
    const auditSummary = audit.getSummary();
    logAgent("audit-summary", { turn, mutations: auditSummary.mutations, filesChanged: auditSummary.filesChanged });
    transcript.push(result.message);
    inputTokens += result.usage?.inputTokens ?? 0;
    outputTokens += result.usage?.outputTokens ?? 0;

    const { text, toolCalls } = result.message;
    const step: AgentStep = { turn, text, toolsUsed: toolCalls.map((c) => c.name) };
    steps.push(step);
    if (params.onStep) {
      try { await params.onStep(step); } catch { /* non-fatal */ }
    }

    if (toolCalls.length === 0) {
      finalText = text;
      stoppedOnLimit = false;
      // Clean up checkpoint on successful completion
      if (checkpointId && checkpointStore) {
        await checkpointStore.delete(checkpointId).catch(() => {});
        checkpointId = undefined;
      }
      break;
    }

    const results: ToolResult[] = [];
    for (const call of toolCalls) {
      const tool = toolsByName.get(call.name);
      if (!tool) {
        logTool("error", { toolName: call.name, error: "unknown tool" });
        results.push({ id: call.id, content: [{ type: "text", text: `Unknown tool: ${call.name}` }], isError: true });
        continue;
      }
      try {
        logTool("call", { toolName: call.name, turn });
        const callStart = Date.now();
        const output = await tool.execute(call.input, contextWithAudit);
        const callMs = Date.now() - callStart;
        const content: ContentBlock[] = typeof output === "string" ? [{ type: "text", text: output }] : output;
        logTool("result", { toolName: call.name, turn, durationMs: callMs, outputSize: JSON.stringify(output).length });
        results.push({ id: call.id, content });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logTool("error", { toolName: call.name, turn, error: errorMsg });
        results.push({
          id: call.id,
          content: [{ type: "text", text: errorMsg }],
          isError: true,
        });
      }
    }
    logAgent("turn", { turn, toolsUsed: toolCalls.length, durationMs: turnMs });
    transcript.push({ role: "tool", results });

    // Keep the last text seen so a limit-truncated run still returns something.
    if (text) finalText = text;

    // Persist checkpoint after each tool-calling turn
    if (checkpointId && checkpointStore) {
      const checkpoint = {
        id: checkpointId,
        system,
        model,
        transcript: [...transcript],
        turn,
        maxSteps,
        toolNames,
        usage: { inputTokens, outputTokens },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await checkpointStore.save(checkpoint).catch((err: unknown) => {
        logAgent("checkpoint-error", { checkpointId, error: String(err) });
      });
    }
  }

  const auditSummary = audit.getSummary();
  logAgent("stop", {
    turns: steps.length,
    stoppedOnLimit,
    totalInputTokens: inputTokens,
    totalOutputTokens: outputTokens,
    mutations: auditSummary.mutations,
    filesChanged: auditSummary.filesChanged,
  });

  return {
    finalText,
    transcript,
    steps,
    stoppedOnLimit,
    usage: { inputTokens, outputTokens },
    audit,
    checkpointId,
  };
}
