import type { ContextFile } from "../types.js";

export const DEFAULT_SYSTEM_PROMPT = [
  "You are a senior software engineering consultant.",
  "Analyze the supplied problem and files.",
  "State assumptions and uncertainty.",
  "Give concrete findings, recommended fixes, and verification steps.",
  "Do not invent missing code or APIs."
].join(" ");

function markdownFence(content: string): string {
  const longestRun = Math.max(0, ...Array.from(content.matchAll(/`+/g), ([run]) => run.length));
  return "`".repeat(Math.max(3, longestRun + 1));
}

export function buildUserPrompt(prompt: string, files: ContextFile[]): string {
  const parts: string[] = [prompt.trim()];
  if (files.length > 0) {
    parts.push("", "[FILES]");
    for (const file of files) {
      if (file.base64) {
        parts.push("", `## ${file.path}`, `![${file.path}](data:${file.mimeType};base64,${file.base64})`);
      } else {
        const fence = markdownFence(file.content);
        parts.push("", `## ${file.path}`, fence, file.content, fence);
      }
    }
  }
  return parts.join("\n").trim();
}

export function renderBundle(input: {
  prompt: string;
  files: ContextFile[];
  systemPrompt?: string;
}): string {
  return [
    "[SYSTEM]",
    input.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT,
    "",
    "[USER]",
    buildUserPrompt(input.prompt, input.files)
  ].join("\n").trim();
}
