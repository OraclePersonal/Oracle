/**
 * Templates — barrel export.
 */

export { createSkillTemplate } from "./skill.js";
export type { SkillTemplateOptions } from "./skill.js";

export { createOracleTemplate } from "./oracle.js";
export type { OracleTemplateOptions } from "./oracle.js";

export {
  listTemplates,
  listBuiltinTemplates,
  installTemplate,
  uninstallTemplate,
  applyTemplate,
} from "./store.js";
