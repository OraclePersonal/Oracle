import type { ApprovalRequest } from "./types.js";

export interface TelegramApprovalNotifierOptions {
  botToken?: string;
  chatId?: string;
  allowedUserIds?: string[];
  fetchImpl?: typeof fetch;
  pollTimeoutSeconds?: number;
}

export type TelegramDecisionHandler = (input: {
  token: string;
  decision: "approve" | "reject";
  userId: string;
  expectedVersion: number;
}) => Promise<string>;

interface TelegramUpdate {
  update_id?: number;
  callback_query?: {
    id?: string;
    data?: string;
    from?: { id?: number };
    message?: { chat?: { id?: number | string } };
  };
}

export class TelegramApprovalNotifier {
  private readonly botToken?: string;
  private readonly chatId?: string;
  private readonly allowedUserIds: Set<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly pollTimeoutSeconds: number;
  private polling = false;
  private pollAbort?: AbortController;
  private pollTimer?: NodeJS.Timeout;
  private updateOffset = 0;

  constructor(options: TelegramApprovalNotifierOptions = {}) {
    this.botToken = options.botToken ?? process.env.ORACLE_TELEGRAM_BOT_TOKEN;
    this.chatId = options.chatId ?? process.env.ORACLE_TELEGRAM_CHAT_ID;
    const allowed = options.allowedUserIds
      ?? process.env.ORACLE_TELEGRAM_ALLOWED_USER_IDS?.split(",")
      ?? [];
    this.allowedUserIds = new Set(allowed.map((value) => value.trim()).filter(Boolean));
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.pollTimeoutSeconds = Math.min(Math.max(options.pollTimeoutSeconds ?? 20, 1), 50);
  }

  get enabled(): boolean {
    return Boolean(this.botToken && this.chatId);
  }

  get callbacksEnabled(): boolean {
    return this.enabled && this.allowedUserIds.size > 0;
  }

  async notify(approval: ApprovalRequest, callbackToken?: string): Promise<boolean> {
    if (!this.botToken || !this.chatId) return false;
    const text = [
      "<b>Oracle approval requested</b>",
      `<b>${this.escape(approval.title)}</b>`,
      approval.description ? this.escape(approval.description) : undefined,
      "",
      `Risk: <b>${approval.risk.toUpperCase()}</b>`,
      `From: ${this.escape(approval.requestedBy)}`,
      `Reviewers: ${this.escape((approval.authorizedReviewers ?? [approval.assignedTo]).join(", "))}`,
      `Quorum: ${approval.approvalCount ?? 0}/${approval.requiredApprovals ?? 1}`,
      approval.expiresAt ? `Expires: ${this.escape(approval.expiresAt)}` : undefined,
      `ID: <code>${this.escape(approval.id)}</code>`,
      "",
      approval.localOnly
        ? "This request must be decided locally."
        : `Review locally: <code>oracle approval show ${this.escape(approval.id)}</code>`
    ].filter((line): line is string => line !== undefined).join("\n");

    const replyMarkup = this.callbacksEnabled && callbackToken && !approval.localOnly
      ? {
          inline_keyboard: [[
            {
              text: "Approve",
              callback_data: `o:a:${callbackToken}:${approval.version}`
            },
            {
              text: "Reject",
              callback_data: `o:r:${callbackToken}:${approval.version}`
            }
          ]]
        }
      : undefined;

    try {
      await this.telegramRequest("sendMessage", {
        chat_id: this.chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {})
      }, 5_000);
    } catch {
      throw new Error("Telegram notification request failed.");
    }
    return true;
  }

  startCallbacks(handler: TelegramDecisionHandler): void {
    if (!this.callbacksEnabled || this.polling) return;
    this.polling = true;
    void this.poll(handler);
  }

  stopCallbacks(): void {
    this.polling = false;
    this.pollAbort?.abort();
    this.pollAbort = undefined;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  private async poll(handler: TelegramDecisionHandler): Promise<void> {
    if (!this.polling) return;
    this.pollAbort = new AbortController();
    try {
      const payload = await this.telegramRequest<{
        ok?: boolean;
        result?: TelegramUpdate[];
      }>("getUpdates", {
        offset: this.updateOffset,
        timeout: this.pollTimeoutSeconds,
        allowed_updates: ["callback_query"]
      }, (this.pollTimeoutSeconds + 5) * 1000, this.pollAbort.signal);
      for (const update of payload.result ?? []) {
        if (typeof update.update_id === "number") {
          this.updateOffset = Math.max(this.updateOffset, update.update_id + 1);
        }
        await this.handleUpdate(update, handler);
      }
      this.schedulePoll(handler, 0);
    } catch (error) {
      if (!this.polling || (error instanceof Error && error.name === "AbortError")) return;
      this.schedulePoll(handler, 1_000);
    } finally {
      this.pollAbort = undefined;
    }
  }

  private schedulePoll(handler: TelegramDecisionHandler, delay: number): void {
    if (!this.polling) return;
    this.pollTimer = setTimeout(() => void this.poll(handler), delay);
    this.pollTimer.unref();
  }

  private async handleUpdate(
    update: TelegramUpdate,
    handler: TelegramDecisionHandler
  ): Promise<void> {
    const callback = update.callback_query;
    if (!callback?.id) return;
    const userId = String(callback.from?.id ?? "");
    const callbackChatId = String(callback.message?.chat?.id ?? "");
    if (callbackChatId !== this.chatId || !this.allowedUserIds.has(userId)) {
      await this.answerCallback(callback.id, "You are not authorized for this Oracle approval.", true);
      return;
    }
    const match = callback.data?.match(/^o:([ar]):([A-Za-z0-9_-]{8,32}):([1-9][0-9]*)$/);
    if (!match) {
      await this.answerCallback(callback.id, "This approval button is invalid.", true);
      return;
    }
    try {
      const message = await handler({
        token: match[2],
        decision: match[1] === "a" ? "approve" : "reject",
        userId,
        expectedVersion: Number(match[3])
      });
      await this.answerCallback(callback.id, message, false);
    } catch (error) {
      await this.answerCallback(
        callback.id,
        error instanceof Error ? error.message.slice(0, 180) : "Approval failed.",
        true
      );
    }
  }

  private async answerCallback(id: string, text: string, showAlert: boolean): Promise<void> {
    await this.telegramRequest("answerCallbackQuery", {
      callback_query_id: id,
      text,
      show_alert: showAlert
    }, 5_000).catch(() => undefined);
  }

  private async telegramRequest<T = { ok?: boolean }>(
    method: string,
    body: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<T> {
    if (!this.botToken) throw new Error("Telegram is not configured.");
    let response: Response;
    try {
      response = await this.fetchImpl(
        `https://api.telegram.org/bot${this.botToken}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
            : AbortSignal.timeout(timeoutMs)
        }
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new Error("Telegram request failed.");
    }
    if (!response.ok) {
      throw new Error(`Telegram request failed with HTTP ${response.status}.`);
    }
    return await response.json() as T;
  }

  private escape(value: string): string {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }
}
