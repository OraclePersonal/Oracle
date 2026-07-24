import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConsultService } from "../../core/consult.js";
import type { ProjectConfig } from "../../config/project.js";
import type { MemoryPort } from "../../orchestrator/ports.js";
import { serializeOracleError } from "../../errors.js";
import { getConversationContext, recordSelfLog } from "../../core/selfMemory.js";
import { loadSoul } from "../../core/souls.js";
import { buildOracleSystemPrompt } from "../../core/systemPrompt.js";
import { searchDocs } from "../../docs/reader.js";

function success(text: string, structuredContent: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], structuredContent };
}

function failure(error: unknown) {
  const serialized = serializeOracleError(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(serialized) }],
    structuredContent: serialized as unknown as Record<string, unknown>
  };
}

export function registerConsultTool(
  server: McpServer,
  deps: {
    service: ConsultService;
    config: ProjectConfig;
    workspaceRoot: string;
    providerId: string;
    memory: MemoryPort;
    soulsDir: string;
  }
): void {
  server.registerTool(
    "oracle_ask",
    {
      title: "Ask Oracle",
      description: "Ask anything. Pass `files` to read code, `conversationId` for multi-turn recall.",
      inputSchema: {
        question: z.string().min(1).describe("Your question or what you're stuck on"),
        soul: z.string().optional().describe("Soul prompt name (e.g. 'engineer', 'philosopher'). Defaults to 'default'"),
        context: z.string().optional().describe("Additional context: code snippets, error messages, what you've tried"),
        files: z.array(z.string()).optional().describe("File paths or glob patterns to read and include, when the question needs real code (e.g. ['src/**/*.ts'])"),
        conversationId: z.string().optional().describe("Stable id for this exchange — pass the same value across multiple oracle_ask calls so Oracle recalls what it already said"),
        include_docs: z.boolean().optional().describe("Search .oracle/docs/ for relevant documentation and include as context"),
        doc_search: z.string().optional().describe("Specific doc query (defaults to using the question itself)")
      }
    },
    async ({ question, soul, context, files, conversationId, include_docs, doc_search }) => {
      try {
        if (soul !== undefined) {
          soul = soul.trim();
          if (soul === "") soul = undefined;
        }
        let soulName: string;
        let soulPrompt: string | undefined;
        if (soul) {
          soulName = soul;
          soulPrompt = await loadSoul(soulName, deps.soulsDir);
        } else {
          soulName = "auto";
        }
        const systemPrompt = buildOracleSystemPrompt(soulPrompt);
        let ctxBlock = context ? `\n\n## Context from the asking agent\n${context}` : "";

        if (conversationId) {
          ctxBlock += await getConversationContext(deps.memory, conversationId);
        }

        if (include_docs) {
          const docQuery = doc_search ?? question;
          const matched = await searchDocs(deps.workspaceRoot, docQuery, 5);
          if (matched.length > 0) {
            const docsBlock = matched
              .map((d) => `### ${d.name}${d.heading ? ` — ${d.heading}` : ""}\n${d.snippet}`)
              .join("\n\n");
            ctxBlock += `\n\n## Documentation from .oracle/docs/\n${docsBlock}\n\n(Match: "${docQuery}")`;
          }
        }

        const prompt = `${ctxBlock}\n\n## Question\n${question}`;
        const hasFiles = files !== undefined && files.length > 0;
        const result = await deps.service.consult({
          prompt,
          preset: "review",
          provider: deps.providerId,
          files: hasFiles ? files : [],
          model: deps.config.model,
          cwd: deps.workspaceRoot,
          maxFileSizeBytes: deps.config.maxFileSizeBytes,
          maxInputBytes: deps.config.maxInputBytes,
          systemPrompt,
          allowEmptyFiles: !hasFiles,
        });

        if (conversationId) {
          await recordSelfLog(deps.memory, conversationId, { question, answerSummary: result.output.slice(0, 400) });
        }

        return success(result.output, {
          soul: soulName,
          sessionId: result.sessionId,
          filesIncluded: result.files.length
        });
      } catch (error) {
        return failure(error);
      }
    }
  );
}
