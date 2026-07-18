#!/usr/bin/env node

/**
 * Oracle-templates CLI.
 *
 * Usage:
 *   oracle-templates list              List installed templates
 *   oracle-templates list --builtin    List built-in templates
 *   oracle-templates install <file>    Install a template from a JSON file
 *   oracle-templates uninstall <name>  Remove an installed template
 *   oracle-templates create skill <name>   Scaffold a new skill template
 *   oracle-templates create oracle <name>  Scaffold a new oracle template
 */

import { Command } from "commander";
import {
  createOracleTemplate,
  createSkillTemplate,
  installTemplate,
  listBuiltinTemplates,
  listTemplates,
  uninstallTemplate,
} from "./templates/index.js";
import { applyTemplate } from "./templates/store.js";

// ── CLI bootstrap ───────────────────────────────────────────────────────────

const program = new Command();

program
  .name("oracle-templates")
  .description("Template management for the Oracle ecosystem")
  .version("1.0.0");

// ── list ────────────────────────────────────────────────────────────────────

program
  .command("list")
  .description("List templates")
  .option("--builtin", "Show built-in templates instead of installed ones")
  .action(async (opts: { builtin?: boolean }) => {
    const result = opts.builtin
      ? await listBuiltinTemplates()
      : await listTemplates();

    if (!result.ok) {
      console.error(result.summary);
      process.exit(1);
    }

    const templates = result.data ?? [];

    if (templates.length === 0) {
      console.log(`No ${opts.builtin ? "built-in" : "installed"} templates found.`);
      return;
    }

    console.log(`\n${opts.builtin ? "Built-in" : "Installed"} templates:\n`);
    for (const t of templates) {
      console.log(`  ${t.name}  (${t.type}) — ${t.description}`);
    }
    console.log();
  });

// ── install ─────────────────────────────────────────────────────────────────

program
  .command("install")
  .description("Install a template from a JSON file")
  .argument("<file>", "Path to the template JSON file")
  .action(async (file: string) => {
    const result = await installTemplate(file);
    if (!result.ok) {
      console.error(`Error: ${result.summary}`);
      process.exit(1);
    }
    console.log(result.summary);
  });

// ── uninstall ───────────────────────────────────────────────────────────────

program
  .command("uninstall")
  .description("Remove an installed template by name")
  .argument("<name>", "Template name to remove")
  .action(async (name: string) => {
    const result = await uninstallTemplate(name);
    if (!result.ok) {
      console.error(`Error: ${result.summary}`);
      process.exit(1);
    }
    console.log(result.summary);
  });

// ── apply ───────────────────────────────────────────────────────────────────

program
  .command("apply")
  .description("Apply a template (write its scaffold files)")
  .argument("<name>", "Template name to apply")
  .option("-o, --out <dir>", "Target directory (default: cwd)")
  .action(async (name: string, opts: { out?: string }) => {
    const result = await applyTemplate(name, opts.out);
    if (!result.ok) {
      console.error(`Error: ${result.summary}`);
      process.exit(1);
    }
    console.log(result.summary);
  });

// ── create ──────────────────────────────────────────────────────────────────

const createCmd = program
  .command("create")
  .description("Scaffold a new template and save it to .oracle/templates/");

createCmd
  .command("skill")
  .description("Create a new skill template")
  .argument("<name>", "Skill name")
  .option("-d, --description <desc>", "Description")
  .option("-a, --author <author>", "Author")
  .option("-t, --tags <tags>", "Comma-separated tags")
  .action(
    async (
      name: string,
      opts: { description?: string; author?: string; tags?: string },
    ) => {
      const result = createSkillTemplate({
        name,
        description: opts.description ?? `Skill template for ${name}`,
        author: opts.author,
        tags: opts.tags?.split(",").map((s) => s.trim()).filter(Boolean),
      });
      if (!result.ok || !result.data) {
        console.error(`Error: ${result.summary}`);
        process.exit(1);
      }
      // Save to .oracle/templates/
      const { writeJson } = await import("./utils.js");
      const { userTemplateDir } = await import("./utils.js");
      const path = await import("node:path");
      const dir = userTemplateDir();
      const dest = path.join(dir, `${result.data.name}.json`);
      await writeJson(dest, result.data);
      console.log(`Created skill template → ${dest}`);
    },
  );

createCmd
  .command("oracle")
  .description("Create a new oracle template")
  .argument("<name>", "Oracle name")
  .option("-d, --description <desc>", "Description")
  .option("-a, --author <author>", "Author")
  .option("-t, --tags <tags>", "Comma-separated tags")
  .option("-m, --model <model>", "Default model (e.g. sonnet, opus)")
  .action(
    async (
      name: string,
      opts: {
        description?: string;
        author?: string;
        tags?: string;
        model?: string;
      },
    ) => {
      const result = createOracleTemplate({
        name,
        description: opts.description ?? `Oracle template for ${name}`,
        author: opts.author,
        tags: opts.tags?.split(",").map((s) => s.trim()).filter(Boolean),
        model: opts.model,
      });
      if (!result.ok || !result.data) {
        console.error(`Error: ${result.summary}`);
        process.exit(1);
      }
      const { writeJson } = await import("./utils.js");
      const { userTemplateDir } = await import("./utils.js");
      const path = await import("node:path");
      const dir = userTemplateDir();
      const dest = path.join(dir, `${result.data.name}.json`);
      await writeJson(dest, result.data);
      console.log(`Created oracle template → ${dest}`);
    },
  );

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Fatal: ${message}`);
  process.exit(1);
});
