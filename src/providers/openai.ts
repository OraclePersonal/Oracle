import OpenAI from "openai";
import type { Provider, ProviderRequest } from "./provider.js";
import type { ProviderResponse } from "../types.js";
import type { AgentMessage, AgentProvider, AgentTool, AgentTurn, ToolCall } from "../agent/types.js";

/** Translate the neutral transcript into OpenAI chat-completion messages. */
function toOpenAIMessages(
  system: string,
  messages: AgentMessage[]
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.text || null,
        tool_calls: m.toolCalls.length
          ? m.toolCalls.map((c) => ({
              id: c.id,
              type: "function" as const,
              function: { name: c.name, arguments: JSON.stringify(c.input) },
            }))
          : undefined,
      });
    } else {
      for (const r of m.results) {
        out.push({ role: "tool", tool_call_id: r.id, content: r.content });
      }
    }
  }
  return out;
}

export class OpenAIProvider implements Provider {
  readonly id = "openai";
  private readonly client: OpenAI;

  constructor(apiKey?: string, baseURL?: string) {
    const key = apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY is not set.");
    this.client = new OpenAI({
      apiKey: key,
      baseURL: baseURL ?? process.env.OPENAI_API_BASE ?? undefined,
    });
  }

  async run(request: ProviderRequest): Promise<ProviderResponse> {
    const response = await this.client.responses.create({
      model: request.model,
      instructions: request.systemPrompt,
      input: request.images?.length
        ? [
            {
              role: "user",
              content: [
                { type: "input_text" as const, text: request.userPrompt },
                ...request.images.map((img) => ({
                  type: "input_image" as const,
                  detail: "auto" as const,
                  image_url: `data:${img.mimeType};base64,${img.base64}`
                }))
              ]
            }
          ]
        : request.userPrompt,
      previous_response_id: request.previousResponseId,
      store: true
    });

    return {
      responseId: response.id,
      text: response.output_text,
      usage: {
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
        totalTokens: response.usage?.total_tokens
      }
    };
  }
}

/**
 * OpenAI-compatible provider for third-party APIs (OpenRouter, Groq, local LLMs, etc.).
 * Set OPENAI_API_KEY + OPENAI_API_BASE (or pass via constructor).
 */
export class OpenCodeProvider implements Provider, AgentProvider {
  readonly id = "opencode";
  private readonly client: OpenAI;
  private readonly defaultModel: string;

  constructor(apiKey?: string, baseURL?: string, defaultModel?: string) {
    const key = apiKey ?? process.env.OPENCODE_API_KEY ?? process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENCODE_API_KEY or OPENAI_API_KEY is not set.");
    this.client = new OpenAI({
      apiKey: key,
      baseURL: baseURL ?? process.env.OPENCODE_API_BASE ?? process.env.OPENAI_API_BASE,
    });
    this.defaultModel = defaultModel ?? process.env.OPENCODE_MODEL ?? "gpt-4o";
  }

  async run(request: ProviderRequest): Promise<ProviderResponse> {
    const model = request.model === "gpt-5.4" ? this.defaultModel : request.model;
    const response = await this.client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: request.systemPrompt },
        { role: "user", content: request.images?.length
          ? [
              { type: "text", text: request.userPrompt },
              ...request.images.map((img) => ({
                type: "image_url",
                image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
              })),
            ] as any
          : request.userPrompt,
        },
      ],
    });

    return {
      responseId: response.id,
      text: response.choices[0]?.message?.content ?? "",
      usage: {
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
        totalTokens: response.usage?.total_tokens,
      },
    };
  }

  /** Runs one agentic turn via chat-completions function calling. */
  async runAgentTurn(params: {
    model: string;
    system: string;
    messages: AgentMessage[];
    tools: AgentTool[];
  }): Promise<AgentTurn> {
    const model = params.model === "gpt-5.4" ? this.defaultModel : params.model;
    const response = await this.client.chat.completions.create({
      model,
      messages: toOpenAIMessages(params.system, params.messages),
      tools: params.tools.map((t) => ({
        type: "function" as const,
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
    });

    const choice = response.choices[0]?.message;
    const toolCalls: ToolCall[] = [];
    for (const c of choice?.tool_calls ?? []) {
      if (c.type !== "function") continue;
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(c.function.arguments || "{}");
      } catch {
        input = {};
      }
      toolCalls.push({ id: c.id, name: c.function.name, input });
    }

    return {
      message: { role: "assistant", text: choice?.content ?? "", toolCalls },
      usage: {
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
      },
    };
  }
}
