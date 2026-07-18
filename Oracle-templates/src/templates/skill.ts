/**
 * Skill template scaffold.
 *
 * Generates template definitions for Oracle Skill scaffolds — reusable
 * markdown workflows that guide AI agents through structured tasks.
 */

import type { Template, TemplateResult } from "../types.js";

export interface SkillTemplateOptions {
  /** Display name for the skill (e.g. "code-review") */
  name: string;
  /** Short description */
  description: string;
  /** Author name */
  author?: string;
  /** Tags for discovery */
  tags?: string[];
  /** The markdown workflow content */
  workflow?: string;
}

/**
 * Create a skill template definition.
 *
 * The returned `Template` can be serialised to JSON and stored in the
 * `.oracle/templates/` directory.
 */
export function createSkillTemplate(
  opts: SkillTemplateOptions,
): TemplateResult<Template> {
  const { name, description, author, tags } = opts;

  if (!name) {
    return { ok: false, summary: "Skill template name is required" };
  }

  const workflow =
    opts.workflow ??
    `# ${name}\n\nA skill template scaffolded by Oracle-templates.\n\n## Workflow\n\n1. Understand the goal\n2. Execute the steps\n3. Report results\n`;

  const template: Template = {
    name: `skill-${name}`,
    type: "skill",
    description,
    version: "1.0.0",
    author: author ?? "Oracle-templates",
    tags: ["skill", ...(tags ?? [])],
    files: [
      {
        path: `${name}.md`,
        content: workflow,
      },
    ],
    metadata: {
      oracleSkillVersion: "1.0",
      scaffoldInstructions:
        "Place the generated .md file in your Oracle-skill skills/ directory.",
    },
  };

  return {
    ok: true,
    summary: `Created skill template "${name}"`,
    data: template,
  };
}
