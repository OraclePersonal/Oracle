/**
 * Oracle template scaffold.
 *
 * Generates template definitions for named Oracle agents — small JSON
 * manifests that describe an agent's identity, instructions, and default
 * model preferences within the Oracle ecosystem.
 */

import type { Template, TemplateResult } from "../types.js";

export interface OracleTemplateOptions {
  /** Oracle agent name (e.g. "code-reviewer") */
  name: string;
  /** Short description */
  description: string;
  /** System prompt / instructions for the oracle */
  instructions?: string;
  /** Author name */
  author?: string;
  /** Tags for discovery */
  tags?: string[];
  /** Default model (e.g. "sonnet", "opus") */
  model?: string;
}

/**
 * Create an oracle template definition.
 *
 * Oracle templates define reusable agent manifests that can be instantiated
 * with `oracle start <name>` in the Oracle CLI.
 */
export function createOracleTemplate(
  opts: OracleTemplateOptions,
): TemplateResult<Template> {
  const { name, description, author, tags, model } = opts;

  if (!name) {
    return { ok: false, summary: "Oracle template name is required" };
  }

  const instructions =
    opts.instructions ??
    `You are ${name}, an oracle in the Oracle ecosystem.\n\nYour purpose: ${description}\n\nFollow the Oracle skill workflow for all tasks.`;

  const template: Template = {
    name: `oracle-${name}`,
    type: "oracle",
    description,
    version: "1.0.0",
    author: author ?? "Oracle-templates",
    tags: ["oracle", ...(tags ?? [])],
    files: [
      {
        path: `${name}.oracle.json`,
        content: JSON.stringify(
          {
            name,
            description,
            model: model ?? "sonnet",
            instructions,
            version: "1.0.0",
          },
          null,
          2,
        ),
      },
    ],
    metadata: {
      oracleAgentVersion: "1.0",
      defaultModel: model ?? "sonnet",
    },
  };

  return {
    ok: true,
    summary: `Created oracle template "${name}"`,
    data: template,
  };
}
