import Anthropic from "@anthropic-ai/sdk";
import type { Provider, ProviderRequest } from "./provider.js";
import type { ProviderResponse } from "../types.js";
import { AnthropicOAuthClient, type PlanTier } from "../auth/anthropic-oauth.js";

const OAUTH_BETA_HEADER = "oauth-2025-04-20";

/** Auto-selected model per subscription tier when the caller passes "auto" as the model. */
const TIER_MODEL: Record<PlanTier, string> = {
  api: "claude-sonnet-5",
  pro: "claude-sonnet-5",
  max: "claude-opus-4-8"
};

/** Conservative SDK retry ceilings per tier — paid subscription tiers carry higher throughput limits. */
const TIER_MAX_RETRIES: Record<PlanTier, number> = {
  api: 2,
  pro: 3,
  max: 5
};

export class AnthropicProvider implements Provider {
  readonly id = "anthropic";
  private client?: Anthropic;
  private planTier: PlanTier = "api";
  private readonly oauth: AnthropicOAuthClient | null;
  private readonly apiKey?: string;

  constructor(
    apiKey = process.env.ANTHROPIC_API_KEY,
    oauth?: AnthropicOAuthClient
  ) {
    this.oauth = oauth ?? null;
    this.apiKey = apiKey;
  }

  private async getClient(): Promise<Anthropic> {
    if (this.client) return this.client;

    if (this.apiKey) {
      // Direct API key — no subscription tier to route on.
      this.planTier = "api";
      this.client = new Anthropic({ apiKey: this.apiKey, maxRetries: TIER_MAX_RETRIES.api });
      return this.client;
    }

    if (!this.oauth) throw new Error(
      "ANTHROPIC_API_KEY is not set. Run `oracle login --provider anthropic` or set the environment variable."
    );
    const token = await this.oauth.getValidToken();
    if (!token) throw new Error("No Anthropic OAuth session found. Run `oracle login --provider anthropic` first.");

    this.planTier = await this.oauth.getPlanTier();
    // OAuth tokens authenticate via `Authorization: Bearer`, not `x-api-key` — use authToken,
    // not apiKey, and send the oauth beta header the API requires for bearer-token requests.
    this.client = new Anthropic({
      authToken: token,
      maxRetries: TIER_MAX_RETRIES[this.planTier],
      defaultHeaders: { "anthropic-beta": OAUTH_BETA_HEADER }
    });
    return this.client;
  }

  /** Resolves "auto" to the best model for the caller's subscription tier; explicit models pass through unchanged. */
  private resolveModel(requestedModel: string): string {
    if (requestedModel === "auto") return TIER_MODEL[this.planTier];
    return requestedModel;
  }

  /** Pro/Max subscriptions can use the Batch API for non-latency-sensitive work at reduced cost. */
  supportsBatch(): boolean {
    return this.planTier === "pro" || this.planTier === "max";
  }

  private buildContent(request: ProviderRequest): Anthropic.MessageParam["content"] {
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
    return content;
  }

  async run(request: ProviderRequest): Promise<ProviderResponse> {
    const client = await this.getClient();

    const msg = await client.messages.create({
      model: this.resolveModel(request.model),
      max_tokens: 8192,
      system: request.systemPrompt,
      messages: [{ role: "user", content: this.buildContent(request) }]
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

  /**
   * Submits a batch of requests via the Message Batches API (50% cost reduction, async).
   * Only available to Pro/Max sessions — callers should check `supportsBatch()` first.
   */
  async runBatch(requests: ProviderRequest[]): Promise<Map<string, ProviderResponse>> {
    const client = await this.getClient();
    if (!this.supportsBatch()) {
      throw new Error("Batch API requires a Pro or Max Anthropic subscription.");
    }

    const batch = await client.messages.batches.create({
      requests: requests.map((request, index) => ({
        custom_id: `req-${index}`,
        params: {
          model: this.resolveModel(request.model),
          max_tokens: 8192,
          system: request.systemPrompt,
          messages: [{ role: "user" as const, content: this.buildContent(request) }]
        }
      }))
    });

    let status = batch;
    while (status.processing_status !== "ended") {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      status = await client.messages.batches.retrieve(batch.id);
    }

    const results = new Map<string, ProviderResponse>();
    for await (const result of await client.messages.batches.results(batch.id)) {
      if (result.result.type === "succeeded") {
        const msg = result.result.message;
        results.set(result.custom_id, {
          text: msg.content.map((b: Anthropic.ContentBlock) => (b.type === "text" ? b.text : "")).join(""),
          usage: {
            inputTokens: msg.usage?.input_tokens,
            outputTokens: msg.usage?.output_tokens,
            totalTokens:
              msg.usage?.input_tokens != null && msg.usage?.output_tokens != null
                ? msg.usage.input_tokens + msg.usage.output_tokens
                : undefined
          }
        });
      }
    }
    return results;
  }
}
