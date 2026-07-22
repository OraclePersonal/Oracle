import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { serializeOracleError } from "../../errors.js";
import type { OracleRegistry } from "../../oracles/registry.js";

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

export function registerOracleProfileTools(server: McpServer, oracles: OracleRegistry): void {
  server.registerTool(
    "oracle_oracle_list",
    {
      title: "List Oracles",
      description: "List registered oracle profiles.",
      inputSchema: {}
    },
    async () => {
      try {
        const list = await oracles.listOracles();
        return success(JSON.stringify(list, null, 2), { oracles: list });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_oracle_register",
    {
      title: "Register Oracle",
      description: "Create a named oracle profile with a skill.",
      inputSchema: {
        name: z.string().min(1),
        skill: z.string().min(1),
        description: z.string().optional(),
        model: z.string().optional(),
        provider: z.string().optional(),
        memory: z.boolean().optional()
      }
    },
    async (params) => {
      try {
        await oracles.registerOracle({
          name: params.name,
          skill: params.skill,
          description: params.description,
          model: params.model,
          provider: params.provider,
          memory: params.memory
        });
        return success(`Registered oracle: ${params.name}`, { name: params.name });
      } catch (error) { return failure(error); }
    }
  );
}
