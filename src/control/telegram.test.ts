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

  test("adds callback buttons only when remote decisions are explicitly enabled", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { "content-type": "application/json" } }
    ));
    const notifier = new TelegramApprovalNotifier({
      botToken: "token",
      chatId: "123",
      allowedUserIds: ["42"],
      fetchImpl
    });
    await notifier.notify({
      id: "approval-1",
      kind: "command",
      title: "Review release",
      requestedBy: "worker",
      assignedTo: "telegram:42",
      authorizedReviewers: ["telegram:42"],
      risk: "medium",
      status: "pending",
      version: 3,
      requiredApprovals: 1,
      approvalCount: 0,
      localOnly: false,
      votes: [],
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }, "callback-token");

    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      reply_markup: {
        inline_keyboard: [[
          { callback_data: "o:a:callback-token:3" },
          { callback_data: "o:r:callback-token:3" }
        ]]
      }
    });
  });

  test("validates Telegram chat and user before forwarding a versioned decision", async () => {
    let notifier: TelegramApprovalNotifier;
    const fetchImpl = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/getUpdates")) {
        return new Response(JSON.stringify({
          ok: true,
          result: [{
            update_id: 7,
            callback_query: {
              id: "callback-1",
              data: "o:a:callback-token:4",
              from: { id: 42 },
              message: { chat: { id: 123 } }
            }
          }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    notifier = new TelegramApprovalNotifier({
      botToken: "token",
      chatId: "123",
      allowedUserIds: ["42"],
      fetchImpl,
      pollTimeoutSeconds: 1
    });
    const decision = new Promise<unknown>((resolve) => {
      notifier.startCallbacks(async (input) => {
        notifier.stopCallbacks();
        resolve(input);
        return "Approved.";
      });
    });

    await expect(decision).resolves.toEqual({
      token: "callback-token",
      decision: "approve",
      userId: "42",
      expectedVersion: 4
    });
  });
});
