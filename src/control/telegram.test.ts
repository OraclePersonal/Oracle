import { describe, expect, test, vi } from "vitest";
import { TelegramApprovalNotifier } from "./telegram.js";

describe("TelegramApprovalNotifier", () => {
  test("never exposes the bot token through transport errors", async () => {
    const token = "secret-bot-token";
    const notifier = new TelegramApprovalNotifier({
      botToken: token,
      chatId: "123",
      fetchImpl: vi.fn(async (input) => {
        throw new Error(`failed to fetch ${String(input)}`);
      })
    });

    const result = notifier.notify({
      id: "approval-1",
      kind: "custom",
      title: "Review release",
      requestedBy: "worker",
      assignedTo: "lead",
      risk: "medium",
      status: "pending",
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    await expect(result).rejects.toThrow("Telegram notification request failed.");
    await expect(result).rejects.not.toThrow(token);
  });
});
