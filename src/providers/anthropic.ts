import Anthropic from "@anthropic-ai/sdk";
import type { Provider, ProviderRequest } from "./provider.js";
import type { ProviderResponse } from "../types.js";
import { AnthropicOAuthClient } from "../auth/anthropic-oauth.js";

export class AnthropicProvider implements Provider {
  readonly id = "anthropic";
  private client?: Anthropic;
  private readonly oauth: AnthropicOAuthClient | null;

  constructor(
    apiKey = process.env.ANTHROPIC_API_KEY,
    oauth?: AnthropicOAuthClient
  ) {
    this.oauth = oauth ?? null;
    if (apiKey) this.client = new Anthropic({ apiKey });
  }

  private async getClient(): Promise<Anthropic> {
    if (this.client) return this.client;
    if (!this.oauth) throw new Error(
      "ANTHROPIC_API_KEY is not set. Run `oracle login --provider anthropic` or set the environment variable."
    );
    const token = await this.oauth.getValidToken();
    if (!token) throw new Error("No Anthropic OAuth session found. Run `oracle login --provider anthropic` first.");
    this.client = new Anthropic({ apiKey: token });
    return this.client;
  }

  async run(request: ProviderRequest): Promise<ProviderResponse> {
    const client = await this.getClient();
    const content: Anthropic.MessageParam["content"] = [{ type: "text", text: request.userPrompt }];
    if (request.images?.length) {
      content.push(
        ...request.images.map((img) => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: img.mimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
            data: img.base64
          }
        }))
      );
    }

    const msg = await client.messages.create({
      model: request.model,
      max_tokens: 8192,
      system: request.systemPrompt,
      messages: [{ role: "user", content }]
    });

    return {
      text: msg.content.map((b: Anthropic.ContentBlock) => (b.type === "text" ? b.text : "")).join(""),
      usage: {
        inputTokens: msg.usage?.input_tokens,
        outputTokens: msg.usage?.output_tokens,
        totalTokens:
          msg.usage?.input_tokens != null && msg.usage?.output_tokens != null
            ? msg.usage.input_tokens + msg.usage.output_tokens
            : undefined
      }
    };
  }
}
