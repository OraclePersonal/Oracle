import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MemoryAdapter } from "../memory/adapter.js";
import { recordSelfLog, getSelfLog, formatSelfLog, getConversationContext } from "./selfMemory.js";

describe("self-memory", () => {
  let tmp: string;
  let memory: MemoryAdapter;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-selfmem-test-"));
    memory = new MemoryAdapter(tmp);
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 100));
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
  });

  it("returns nothing for a session that has never recorded anything", async () => {
    expect(await getSelfLog(memory, "session-a")).toEqual([]);
  });

  it("recalls entries recorded under the same session", async () => {
    await recordSelfLog(memory, "session-a", { question: "what is X?", answerSummary: "X is Y" });
    const log = await getSelfLog(memory, "session-a");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ question: "what is X?", answerSummary: "X is Y" });
  });

  it("does not leak entries from a different session", async () => {
    await recordSelfLog(memory, "session-a", { question: "q1", answerSummary: "a1" });
    await recordSelfLog(memory, "session-b", { question: "q2", answerSummary: "a2" });
    const logA = await getSelfLog(memory, "session-a");
    expect(logA).toHaveLength(1);
    expect(logA[0].question).toBe("q1");
  });

  it("respects the limit and returns most-recent-first from recall order", async () => {
    for (let i = 0; i < 5; i++) {
      await recordSelfLog(memory, "session-a", { question: `q${i}`, answerSummary: `a${i}` });
      await new Promise((r) => setTimeout(r, 5));
    }
    const log = await getSelfLog(memory, "session-a", 2);
    expect(log).toHaveLength(2);
  });

  it("formatSelfLog returns an empty string for no entries", () => {
    expect(formatSelfLog([])).toBe("");
  });

  it("formatSelfLog renders oldest-first as a readable block", () => {
    const block = formatSelfLog([
      { question: "q2", answerSummary: "a2", ts: "2026-01-01T00:00:01.000Z" },
      { question: "q1", answerSummary: "a1", ts: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(block).toContain("What I already told you earlier in this session");
    expect(block.indexOf("q1")).toBeLessThan(block.indexOf("q2"));
  });

  describe("getConversationContext", () => {
    it("returns empty string for a session with no history", async () => {
      expect(await getConversationContext(memory, "session-a")).toBe("");
    });

    it("includes all turns when comfortably under the token budget", async () => {
      await recordSelfLog(memory, "session-a", { question: "q1", answerSummary: "a1" });
      await recordSelfLog(memory, "session-a", { question: "q2", answerSummary: "a2" });
      const ctx = await getConversationContext(memory, "session-a", { maxTokens: 1000 });
      expect(ctx).toContain("q1");
      expect(ctx).toContain("q2");
      expect(ctx).not.toContain("omitted");
    });

    it("keeps only the most recent turns and reports how many were omitted once over budget", async () => {
      for (let i = 0; i < 10; i++) {
        await recordSelfLog(memory, "session-a", {
          question: `question number ${i} with some extra padding text to consume tokens`,
          answerSummary: `answer number ${i} with some extra padding text to consume tokens as well`,
        });
        await new Promise((r) => setTimeout(r, 5));
      }
      // Small budget: only the newest turn or two should survive.
      const ctx = await getConversationContext(memory, "session-a", { maxTokens: 60, maxTurns: 20 });
      expect(ctx).toContain("question number 9"); // most recent turn always kept
      expect(ctx).not.toContain("question number 0"); // oldest dropped
      expect(ctx).toMatch(/\d+ earlier turns? in this session omitted/);
    });

    it("respects maxTurns independently of the token budget", async () => {
      for (let i = 0; i < 5; i++) {
        await recordSelfLog(memory, "session-a", { question: `q${i}`, answerSummary: `a${i}` });
        await new Promise((r) => setTimeout(r, 5));
      }
      const ctx = await getConversationContext(memory, "session-a", { maxTokens: 100_000, maxTurns: 2 });
      expect(ctx).toContain("q4");
      expect(ctx).toContain("q3");
      expect(ctx).not.toContain("q2");
    });

    it("does not leak another session's turns into the budgeted context", async () => {
      await recordSelfLog(memory, "session-a", { question: "mine", answerSummary: "a" });
      await recordSelfLog(memory, "session-b", { question: "not-mine", answerSummary: "b" });
      const ctx = await getConversationContext(memory, "session-a");
      expect(ctx).toContain("mine");
      expect(ctx).not.toContain("not-mine");
    });
  });
});
