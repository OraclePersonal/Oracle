import type { ProviderResponse } from "../types.js";

export interface ProviderRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  cwd: string;
  previousResponseId?: string;
  images?: Array<{ base64: string; mimeType: string }>;
}

export interface Provider {
  readonly id: string;
  run(request: ProviderRequest): Promise<ProviderResponse>;
}
