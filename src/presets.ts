export const PRESET_NAMES = ["review", "debug", "architecture", "tests", "security"] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

const PRESET_INSTRUCTIONS: Record<PresetName, string> = {
  review: "Review for concrete correctness, maintainability, and verification gaps.",
  debug: "Find the root cause, distinguish evidence from hypotheses, and propose the smallest verified fix.",
  architecture: "Assess boundaries, dependencies, data flow, and trade-offs without inventing requirements.",
  tests: "Identify missing behavioral coverage, edge cases, and the highest-value tests.",
  security: "Audit trust boundaries, data exposure, injection risks, credential handling, and safe mitigations."
};

export function composePresetSystemPrompt(preset: PresetName, base: string): string {
  return `${base.trim()} ${PRESET_INSTRUCTIONS[preset]}`;
}
