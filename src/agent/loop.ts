import type {
  AgentContext,
  AgentMessage,
  AgentProvider,
  AgentTool,
  ToolResult,
} from "./types.js";

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
  const { provider, model, system, prompt, tools, context } = params;
  const maxSteps = params.maxSteps ?? 20;
  const toolsByName = new Map(tools.map((t) => [t.name, t]));

  const transcript: AgentMessage[] = [{ role: "user", content: prompt }];
  const steps: AgentStep[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let finalText = "";
  let stoppedOnLimit = true;

  for (let turn = 1; turn <= maxSteps; turn++) {
    const result = await provider.runAgentTurn({ model, system, messages: transcript, tools });
    transcript.push(result.message);
    inputTokens += result.usage?.inputTokens ?? 0;
    outputTokens += result.usage?.outputTokens ?? 0;

    const { text, toolCalls } = result.message;
    const step: AgentStep = { turn, text, toolsUsed: toolCalls.map((c) => c.name) };
    steps.push(step);
    if (params.onStep) await params.onStep(step);

    if (toolCalls.length === 0) {
      finalText = text;
      stoppedOnLimit = false;
      break;
    }

    const results: ToolResult[] = [];
    for (const call of toolCalls) {
      const tool = toolsByName.get(call.name);
      if (!tool) {
        results.push({ id: call.id, content: `Unknown tool: ${call.name}`, isError: true });
        continue;
      }
      try {
        const content = await tool.execute(call.input, context);
        results.push({ id: call.id, content });
      } catch (error) {
        results.push({
          id: call.id,
          content: error instanceof Error ? error.message : String(error),
          isError: true,
        });
      }
    }
    transcript.push({ role: "tool", results });

    // Keep the last text seen so a limit-truncated run still returns something.
    if (text) finalText = text;
  }

  return {
    finalText,
    transcript,
    steps,
    stoppedOnLimit,
    usage: { inputTokens, outputTokens },
  };
}
