import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDebouncer, reviewWorkingTreeDiff } from "./watch.js";
import { ConsultService } from "./consult.js";
import type { Provider, ProviderRequest } from "../providers/provider.js";
import type { CommandRunner } from "../providers/codex.js";

describe("createDebouncer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires once after the debounce window", () => {
    const fn = vi.fn();
    const d = createDebouncer(fn, 1000);
    d.trigger();
    vi.advanceTimersByTime(999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("collapses rapid repeated triggers into a single fire", () => {
    const fn = vi.fn();
    const d = createDebouncer(fn, 1000);
    d.trigger();
    vi.advanceTimersByTime(500);
    d.trigger(); // resets the window
    vi.advanceTimersByTime(500);
    expect(fn).not.toHaveBeenCalled(); // only 500ms since the last trigger
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("cancel() prevents a pending fire", () => {
    const fn = vi.fn();
    const d = createDebouncer(fn, 1000);
    d.trigger();
    d.cancel();
    vi.advanceTimersByTime(2000);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("reviewWorkingTreeDiff", () => {
  function fakeProvider(output = "looks fine"): Provider {
    return {
      id: "fake",
      async run(_req: ProviderRequest) {
        return { responseId: "r1", text: output, usage: {} };
      }
    };
  }

  function fakeRunner(stdout: string, exitCode = 0): CommandRunner {
    return async () => ({ exitCode, stdout, stderr: "" });
  }

  it("returns null when the working tree is clean", async () => {
    const service = new ConsultService(fakeProvider());
    const result = await reviewWorkingTreeDiff(service, {
      cwd: "/repo",
      provider: "fake",
      model: "test-model",
      skillName: "review",
      systemPrompt: "sys",
      runner: fakeRunner("")
    });
    expect(result).toBeNull();
  });

  it("reviews a non-empty diff and returns the provider's output", async () => {
    const service = new ConsultService(fakeProvider("found a bug on line 3"));
    const result = await reviewWorkingTreeDiff(service, {
      cwd: "/repo",
      provider: "fake",
      model: "test-model",
      skillName: "review",
      systemPrompt: "sys",
      runner: fakeRunner("diff --git a/x.ts b/x.ts\n+const x = 1;\n")
    });
    expect(result).not.toBeNull();
    expect(result!.output).toBe("found a bug on line 3");
    expect(result!.diff).toContain("const x = 1;");
  });

  it("throws when git diff itself fails", async () => {
    const service = new ConsultService(fakeProvider());
    await expect(
      reviewWorkingTreeDiff(service, {
        cwd: "/repo",
        provider: "fake",
        model: "test-model",
        skillName: "review",
        systemPrompt: "sys",
        runner: fakeRunner("", 128)
      })
    ).rejects.toThrow(/git diff failed/);
  });

  it("truncates an oversized diff before sending it to the provider", async () => {
    const runSpy = vi.fn(async (_req: ProviderRequest) => ({ responseId: "r1", text: "ok", usage: {} }));
    const service = new ConsultService({ id: "fake", run: runSpy });
    const hugeDiff = "x".repeat(100_000);
    await reviewWorkingTreeDiff(service, {
      cwd: "/repo",
      provider: "fake",
      model: "test-model",
      skillName: "review",
      systemPrompt: "sys",
      runner: fakeRunner(hugeDiff),
      maxDiffChars: 1000
    });
    const sentPrompt = runSpy.mock.calls[0][0].userPrompt;
    expect(sentPrompt.length).toBeLessThan(hugeDiff.length);
  });
});
