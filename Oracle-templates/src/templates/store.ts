/**
 * Template I/O operations.
 *
 * High-level functions that the CLI and MCP tools call to list, install,
 * uninstall, and apply templates.
 */

import path from "node:path";
import {
  builtinTemplateDir,
  ensureDir,
  listJsonFiles,
  readJson,
  removeFile,
  userTemplateDir,
  writeJson,
} from "../utils.js";
import type { Template, TemplateResult, TemplateSummary } from "../types.js";
import { TemplateSchema } from "../types.js";

// ── Listing ─────────────────────────────────────────────────────────────────

/**
 * List all installed templates (from `.oracle/templates/`).
 */
export async function listTemplates(
  projectRoot?: string,
): Promise<TemplateResult<TemplateSummary[]>> {
  const dir = userTemplateDir(projectRoot);
  const files = await listJsonFiles(dir);
  const templates: TemplateSummary[] = [];

  for (const file of files) {
    const tpl = await readJson<Template>(file);
    if (tpl && tpl.name) {
      templates.push({
        name: tpl.name,
        type: tpl.type,
        description: tpl.description,
        version: tpl.version,
        tags: tpl.tags ?? [],
      });
    }
  }

  return {
    ok: true,
    summary: `Found ${templates.length} installed template(s)`,
    data: templates,
  };
}

/**
 * List built-in templates shipped with the package.
 */
export async function listBuiltinTemplates(): Promise<
  TemplateResult<TemplateSummary[]>
> {
  const dir = builtinTemplateDir();
  const files = await listJsonFiles(dir);
  const templates: TemplateSummary[] = [];

  for (const file of files) {
    const tpl = await readJson<Template>(file);
    if (tpl && tpl.name) {
      templates.push({
        name: tpl.name,
        type: tpl.type,
        description: tpl.description,
        version: tpl.version,
        tags: tpl.tags ?? [],
      });
    }
  }

  return {
    ok: true,
    summary: `Found ${templates.length} built-in template(s)`,
    data: templates,
  };
}

// ── Install ─────────────────────────────────────────────────────────────────

/**
 * Install a template from a JSON file path into `.oracle/templates/`.
 *
 * The file is validated against the TemplateSchema before copying.
 */
export async function installTemplate(
  sourcePath: string,
  projectRoot?: string,
): Promise<TemplateResult<Template>> {
  const tpl = await readJson<Template>(sourcePath);
  if (!tpl) {
    return {
      ok: false,
      summary: `Cannot read template file: ${sourcePath}`,
    };
  }

  const parsed = TemplateSchema.safeParse(tpl);
  if (!parsed.success) {
    return {
      ok: false,
      summary: `Invalid template schema: ${parsed.error.message}`,
    };
  }

  const destDir = userTemplateDir(projectRoot);
  await ensureDir(destDir);

  const destPath = path.join(destDir, `${parsed.data.name}.json`);
  await writeJson(destPath, parsed.data);

  return {
    ok: true,
    summary: `Installed template "${parsed.data.name}"`,
    data: parsed.data,
  };
}

// ── Uninstall ───────────────────────────────────────────────────────────────

/**
 * Uninstall a template by name from `.oracle/templates/`.
 */
export async function uninstallTemplate(
  name: string,
  projectRoot?: string,
): Promise<TemplateResult> {
  const dir = userTemplateDir(projectRoot);
  const filePath = path.join(dir, `${name}.json`);

  await removeFile(filePath);

  return {
    ok: true,
    summary: `Uninstalled template "${name}"`,
  };
}

// ── Apply ───────────────────────────────────────────────────────────────────

/**
 * Apply a template: write all its scaffolded files to the target directory.
 *
 * By default files are written to `process.cwd()`.
 */
export async function applyTemplate(
  name: string,
  targetDir?: string,
  projectRoot?: string,
): Promise<TemplateResult> {
  const dir = userTemplateDir(projectRoot);
  const filePath = path.join(dir, `${name}.json`);

  const tpl = await readJson<Template>(filePath);
  if (!tpl) {
    return {
      ok: false,
      summary: `Template "${name}" not found in ${dir}`,
    };
  }

  const dest = targetDir ?? process.cwd();

  for (const file of tpl.files ?? []) {
    const fullPath = path.join(dest, file.path);
    await ensureDir(path.dirname(fullPath));
    // Write as a plain file — content is already a string
    const { writeFile } = await import("node:fs/promises");
    await writeFile(fullPath, file.content, "utf-8");
  }

  return {
    ok: true,
    summary: `Applied template "${name}" — wrote ${tpl.files?.length ?? 0} file(s) to ${dest}`,
  };
}
