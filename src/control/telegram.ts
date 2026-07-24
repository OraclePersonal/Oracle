import type { ApprovalRequest } from "./types.js";

export interface TelegramApprovalNotifierOptions {
  botToken?: string;
  chatId?: string;
  fetchImpl?: typeof fetch;
}

export class TelegramApprovalNotifier {
  private readonly botToken?: string;
  private readonly chatId?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TelegramApprovalNotifierOptions = {}) {
    this.botToken = options.botToken ?? process.env.ORACLE_TELEGRAM_BOT_TOKEN;
    this.chatId = options.chatId ?? process.env.ORACLE_TELEGRAM_CHAT_ID;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get enabled(): boolean {
    return Boolean(this.botToken && this.chatId);
  }

  async notify(approval: ApprovalRequest): Promise<boolean> {
    if (!this.botToken || !this.chatId) return false;
    const text = [
      "<b>Oracle approval requested</b>",
      `<b>${this.escape(approval.title)}</b>`,
      approval.description ? this.escape(approval.description) : undefined,
      "",
      `Risk: <b>${approval.risk.toUpperCase()}</b>`,
      `From: ${this.escape(approval.requestedBy)}`,
      `Reviewer: ${this.escape(approval.assignedTo)}`,
      `ID: <code>${this.escape(approval.id)}</code>`,
      "",
      `Review locally: <code>oracle approval show ${this.escape(approval.id)}</code>`
    ].filter((line): line is string => line !== undefined).join("\n");

    let response: Response;
    try {
      response = await this.fetchImpl(
        `https://api.telegram.org/bot${this.botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: this.chatId,
            text,
            parse_mode: "HTML",
            disable_web_page_preview: true
          }),
          signal: AbortSignal.timeout(5000)
        }
      );
    } catch {
      // Never surface a fetch error that could include the bot-token URL.
      throw new Error("Telegram notification request failed.");
    }
    if (!response.ok) {
      throw new Error(`Telegram notification failed with HTTP ${response.status}.`);
    }
    return true;
  }

  private escape(value: string): string {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }
}
