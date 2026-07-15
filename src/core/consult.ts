import crypto from "node:crypto";
import type { ConsultRequest, ConsultResult, SessionRecord } from "../types.js";
import { resolveFiles } from "../context/files.js";
import { scanFilesForSecrets } from "../context/secrets.js";
import {
  buildUserPrompt,
  DEFAULT_SYSTEM_PROMPT,
  renderBundle
} from "../context/bundle.js";
import type { Provider } from "../providers/provider.js";
import { FileSessionStore } from "../session/store.js";

function createSessionId(prompt: string): string {
  const slug =
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 36) || "consult";
  return `${slug}-${crypto.randomUUID().slice(0, 8)}`;
}

export class ConsultService {
  constructor(
    private readonly provider: Provider,
    private readonly sessions = new FileSessionStore()
  ) {}

  async consult(request: ConsultRequest): Promise<ConsultResult> {
    const cwd = request.cwd ?? process.cwd();
    const model = request.model ?? "gpt-5.4";
    const files = await resolveFiles(request.files ?? [], {
      cwd,
      maxFileSizeBytes: request.maxFileSizeBytes
    });
    const secretFindings = scanFilesForSecrets(files);
    if (secretFindings.length > 0) {
      const summary = secretFindings
        .map((finding) => `${finding.path}:${finding.line} (${finding.detector})`)
        .join(", ");
      throw new Error(`Potential secrets detected: ${summary}`);
    }

    const systemPrompt = request.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;
    const userPrompt = buildUserPrompt(request.prompt, files);
    const bundle = renderBundle({
      prompt: request.prompt,
      files,
      systemPrompt
    });

    const id = createSessionId(request.prompt);
    let record = await this.sessions.create({
      id,
      cwd,
      prompt: request.prompt,
      model,
      files: files.map((file) => file.path),
      bundle
    });

    try {
      const response = await this.provider.run({
        model,
        systemPrompt,
        userPrompt,
        cwd,
        previousResponseId: request.previousResponseId
      });
      record = {
        ...record,
        status: "completed",
        completedAt: new Date().toISOString(),
        responseId: response.responseId,
        output: response.text,
        usage: response.usage,
        error: undefined
      };
    } catch (error) {
      record = {
        ...record,
        status: "error",
        completedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      };
    }

    await this.sessions.write(record);
    return record;
  }

  async session(id: string): Promise<SessionRecord | null> {
    return this.sessions.read(id);
  }

  async listSessions(limit?: number): Promise<SessionRecord[]> {
    return this.sessions.list(limit);
  }
}
