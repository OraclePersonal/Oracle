import OpenAI from "openai";
import type { Provider, ProviderRequest } from "./provider.js";
import type { ProviderResponse } from "../types.js";

export class OpenAIProvider implements Provider {
  readonly id = "openai";
  private readonly client: OpenAI;

  constructor(apiKey = process.env.OPENAI_API_KEY) {
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set.");
    this.client = new OpenAI({ apiKey });
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
