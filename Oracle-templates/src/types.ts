/**
 * Core type definitions for Oracle-templates.
 *
 * Templates are JSON files that define reusable scaffolding for skills,
 * oracles, and consult sessions within the Oracle ecosystem.
 */

import { z } from "zod";

// ── Template types ──────────────────────────────────────────────────────────

export type TemplateType = "skill" | "oracle" | "session";

export const TEMPLATE_TYPES: TemplateType[] = ["skill", "oracle", "session"];

// ── Zod schemas ─────────────────────────────────────────────────────────────

export const TemplateFileSchema = z.object({
  /** Relative file path inside the scaffolded project */
  path: z.string(),
  /** File content (plain text, can be markdown, JSON, etc.) */
  content: z.string(),
});

export const TemplateSchema = z.object({
  /** Unique template name */
  name: z.string().min(1),
  /** Template category */
  type: z.enum(["skill", "oracle", "session"]),
  /** Human-readable description */
  description: z.string(),
  /** Semver version */
  version: z.string().default("1.0.0"),
  /** Original author / generator */
  author: z.string().optional(),
  /** Search / filter tags */
  tags: z.array(z.string()).default([]),
  /** Files to scaffold when the template is applied */
  files: z.array(TemplateFileSchema).default([]),
  /**
   * Arbitrary metadata payload. Each template type may define its own
   * expected shape (e.g. "skill" templates expect `oracleSkillVersion`).
   */
  metadata: z.record(z.unknown()).default({}),
});

/** Inferred type from the Zod schema */
export type Template = z.infer<typeof TemplateSchema>;

// ── Result shapes ───────────────────────────────────────────────────────────

export interface TemplateResult<T = unknown> {
  ok: boolean;
  summary: string;
  data?: T;
  error?: string;
}

export interface TemplateSummary {
  name: string;
  type: TemplateType;
  description: string;
  version: string;
  tags: string[];
}
