import { z } from "zod";
import type { ConsultService } from "../../core/consult.js";
import type { SkillRegistry } from "../../skills/registry.js";
import type { ProfileStore } from "../../identity/profile.js";
import type { ProjectConfig } from "../../config/project.js";
import { OracleToolError, ErrorCode } from "../oracleErrors.js";
import { ToolDefinition, toolSuccess } from "../toolBuilder.js";
import { DEFAULT_SYSTEM_PROMPT } from "../../context/bundle.js";

const ConsultOutputSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      output: z.string().describe("The consultant's analysis or answer"),
      sessionId: z.string().describe("Session ID for recalling this consult"),
      filesIncluded: z.number().describe("Number of files analyzed"),
      metadata: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  error: z.string().optional(),
});

export function createConsultTool(
  service: ConsultService,
  config: ProjectConfig,
  workspaceRoot: string,
  providerId: string,
  skills: SkillRegistry,
  profile: ProfileStore
): ToolDefinition {
  return {
    name: "oracle_consult",
    category: "consult",
    title: "Consult Oracle",
    description:
      "Analyze project files with a focused engineering skill. Supply a prompt and optional file patterns; Oracle reads files matching the patterns, applies the chosen skill, and provides structured analysis.",
    inputSchema: z.object({
      prompt: z
        .string()
        .min(1)
        .max(50000)
        .describe("The question or task you want Oracle to analyze"),
      skill: z
        .string()
        .optional()
        .describe("Engineering skill to apply (review, debug, security, etc.). Defaults to 'review'"),
      files: z
        .array(z.string())
        .optional()
        .describe("File paths or glob patterns (e.g., ['src/**/*.ts', '!*.test.ts'])"),
      previousSessionId: z
        .string()
        .optional()
        .describe("Session ID to include previous analysis for continuity"),
    }),
    outputSchema: ConsultOutputSchema,
    keywords: ["analyze", "review", "code-analysis"],
    rateLimitPerMin: 10,
    cacheable: false,
    handler: async ({ prompt, skill, files, previousSessionId }) => {
      const skillName = skill ?? "review";
      const selected = skills.get(skillName);
      if (!selected) {
        throw new OracleToolError(
          ErrorCode.INVALID_SKILL,
          `Unknown skill: ${skillName}`,
          `Available: ${skills.names().join(", ")}`
        );
      }

      const patterns = [...(files ?? config.include), ...config.exclude.map((item) => `!${item}`)];
      let previousResponseId: string | undefined;
      if (previousSessionId) {
        const prev = await service.session(previousSessionId);
        previousResponseId = prev?.responseId;
      }

      const basePrompt = skills.compose(skillName, DEFAULT_SYSTEM_PROMPT);
      const personalCtx = await profile.buildPersonalContext();
      const systemPrompt = personalCtx ? `${personalCtx}\n\n${basePrompt}` : basePrompt;

      const result = await service.consult({
        prompt,
        preset: skillName,
        provider: providerId,
        files: patterns,
        model: selected.model ?? config.model,
        cwd: workspaceRoot,
        maxFileSizeBytes: config.maxFileSizeBytes,
        maxInputBytes: config.maxInputBytes,
        previousResponseId,
        systemPrompt,
      });

      return toolSuccess({
        output: result.output,
        sessionId: result.sessionId,
        filesIncluded: result.files.length,
        metadata: { provider: providerId, preset: skillName },
      });
    },
  };
}
