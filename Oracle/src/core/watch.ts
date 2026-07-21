import type { ConsultService } from "./consult.js";
import { runCommand, type CommandRunner } from "../providers/codex.js";

/**
 * A trailing debouncer: repeated trigger() calls within `ms` of each other
 * collapse into a single `fn()` run, fired `ms` after the *last* call. This
 * is the Autonomy Layer's edge-detector — a chokidar watcher fires once per
 * touched file (an editor save can touch several at once), and reviewing on
 * every individual fs event would spam a consult per keystroke-adjacent
 * save instead of once per "the user is done editing for now."
 */
export function createDebouncer(fn: () => void, ms: number): { trigger(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    trigger() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fn, ms);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    }
  };
}

export interface DiffReviewResult {
  diff: string;
  output: string;
  sessionId: string;
}

/**
 * Run `git diff` and, if there's anything uncommitted, send it to the
 * configured provider for review. Returns null when the working tree is
 * clean — the watcher should treat that as "nothing to do," not an error.
 */
export async function reviewWorkingTreeDiff(
  service: ConsultService,
  opts: {
    cwd: string;
    provider: string;
    model: string;
    skillName: string;
    systemPrompt: string;
    runner?: CommandRunner;
    maxDiffChars?: number;
  }
): Promise<DiffReviewResult | null> {
  const runner = opts.runner ?? runCommand;
  const result = await runner("git", ["diff"], { cwd: opts.cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git diff failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
  }
  const diff = result.stdout;
  if (!diff.trim()) return null;

  const maxDiffChars = opts.maxDiffChars ?? 50_000;
  const consultResult = await service.consult({
    prompt: `Review this diff. Flag correctness bugs, risky changes, and anything worth a second look before committing.\n\n[GIT DIFF]\n\`\`\`diff\n${diff.slice(0, maxDiffChars)}\n\`\`\``,
    preset: opts.skillName,
    provider: opts.provider,
    files: [],
    model: opts.model,
    cwd: opts.cwd,
    systemPrompt: opts.systemPrompt,
    allowEmptyFiles: true
  });

  return { diff, output: consultResult.output, sessionId: consultResult.sessionId };
}
