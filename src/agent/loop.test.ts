import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runAgentLoop } from "./loop.js";
import { defaultAgentTools } from "./tools.js";
import type { AgentProvider, AgentTurn } from "./types.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-agent-loop-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/**
 * Scripted provider: returns a queued turn each call. Lets us drive the loop
 * deterministically without a real model, verifying tool execution + feedback.
 */
function scriptedProvider(turns: AgentTurn[]): AgentProvider & { calls: number } {
  const provider = {
    id: "scripted",
    calls: 0,
    async runAgentTurn(): Promise<AgentTurn> {
      const turn = turns[provider.calls];
      provider.calls += 1;
      if (!turn) throw new Error("scripted provider ran out of turns");
      return turn;
    },
  };
  return provider;
}

describe("runAgentLoop", () => {
  test("executes a tool call then returns the final text", async () => {
    const provider = scriptedProvider([
      {
        message: {
          role: "assistant",
          text: "Writing the file.",
          toolCalls: [{ id: "c1", name: "write_file", input: { path: "hello.txt", content: "hi" } }],
        },
      },
      { message: { role: "assistant", text: "Done — created hello.txt.", toolCalls: [] } },
    ]);

    const result = await runAgentLoop({
      provider,
      model: "test",
      system: "sys",
      prompt: "create hello.txt",
      tools: defaultAgentTools(),
      context: { workspaceRoot: root, readOnly: false },
    });

    expect(provider.calls).toBe(2);
    expect(result.finalText).toBe("Done — created hello.txt.");
    expect(result.stoppedOnLimit).toBe(false);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].toolsUsed).toEqual(["write_file"]);
    // The file was actually written by the tool during the loop.
    expect(await fs.readFile(path.join(root, "hello.txt"), "utf8")).toBe("hi");
  });

  test("feeds tool errors back to the model instead of throwing", async () => {
    const provider = scriptedProvider([
      {
        message: {
          role: "assistant",
          text: "",
          toolCalls: [{ id: "c1", name: "read_file", input: { path: "missing.txt" } }],
        },
      },
      { message: { role: "assistant", text: "That file does not exist.", toolCalls: [] } },
    ]);

    const result = await runAgentLoop({
      provider,
      model: "test",
      system: "sys",
      prompt: "read missing.txt",
      tools: defaultAgentTools(),
      context: { workspaceRoot: root, readOnly: false },
    });

    expect(result.finalText).toBe("That file does not exist.");
    const toolMsg = result.transcript.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    if (toolMsg?.role === "tool") expect(toolMsg.results[0].isError).toBe(true);
  });

  test("stops at maxSteps when the model keeps calling tools", async () => {
    const loopingTurn: AgentTurn = {
      message: {
        role: "assistant",
        text: "still working",
        toolCalls: [{ id: "c", name: "list_dir", input: {} }],
      },
    };
    const provider = scriptedProvider([loopingTurn, loopingTurn, loopingTurn]);

    const result = await runAgentLoop({
      provider,
      model: "test",
      system: "sys",
      prompt: "loop forever",
      tools: defaultAgentTools(),
      context: { workspaceRoot: root, readOnly: false },
      maxSteps: 3,
    });

    expect(result.stoppedOnLimit).toBe(true);
    expect(result.steps).toHaveLength(3);
    expect(provider.calls).toBe(3);
  });

  test("reports an unknown tool back to the model", async () => {
    const provider = scriptedProvider([
      {
        message: {
          role: "assistant",
          text: "",
          toolCalls: [{ id: "c1", name: "no_such_tool", input: {} }],
        },
      },
      { message: { role: "assistant", text: "ok", toolCalls: [] } },
    ]);

    const result = await runAgentLoop({
      provider,
      model: "test",
      system: "sys",
      prompt: "x",
      tools: defaultAgentTools(),
      context: { workspaceRoot: root, readOnly: false },
    });

    const toolMsg = result.transcript.find((m) => m.role === "tool");
    if (toolMsg?.role === "tool") {
      const contentText = toolMsg.results[0].content
        .filter((c) => c.type === "text")
        .map((c) => (c as any).text)
        .join("");
      expect(contentText).toContain("Unknown tool");
      expect(toolMsg.results[0].isError).toBe(true);
    }
  });

  test("persists audit records and enforces the mutation limit", async () => {
    const provider = scriptedProvider([
      {
        message: {
          role: "assistant",
          text: "",
          toolCalls: [
            { id: "c1", name: "write_file", input: { path: "one.txt", content: "one" } },
            { id: "c2", name: "write_file", input: { path: "two.txt", content: "two" } }
          ],
        },
      },
      { message: { role: "assistant", text: "Stopped after the policy denial.", toolCalls: [] } },
    ]);

    await runAgentLoop({
      provider,
      model: "test",
      system: "sys",
      prompt: "write two files",
      tools: defaultAgentTools(),
      context: {
        workspaceRoot: root,
        readOnly: false,
        policy: {
          forbiddenGlobs: [],
          forbiddenCommands: [],
          maxMutationsPerSession: 1
        }
      },
    });

    expect(await fs.readFile(path.join(root, "one.txt"), "utf8")).toBe("one");
    await expect(fs.readFile(path.join(root, "two.txt"), "utf8")).rejects.toThrow();

    const auditLines = (await fs.readFile(path.join(root, ".oracle", "audit.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { action: string; target: string; details?: { rule?: string } });
    expect(auditLines).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "write", target: "one.txt" }),
      expect.objectContaining({
        action: "policy_denied",
        target: "two.txt",
        details: expect.objectContaining({ rule: "max_mutations_per_session" })
      })
    ]));
  });
});
