import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { serializeOracleError } from "../errors.js";
import type { MessageStore } from "../messaging/store.js";

function success(text: string, structuredContent: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], structuredContent };
}

function failure(error: unknown) {
  const serialized = serializeOracleError(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(serialized) }],
    structuredContent: serialized as unknown as Record<string, unknown>
  };
}

/**
 * Register the inter-agent messaging tools (`oracle_msg_*`) on an MCP server.
 *
 * Shared by the full Oracle server (`registerOracleTools`) and the standalone
 * messaging-only server (`src/mcp-messaging.ts`), so the tool surface stays
 * identical whichever binary a client wires up.
 */
export function registerMessagingTools(server: McpServer, messages: MessageStore): void {
  server.registerTool(
    "oracle_msg_send",
    {
      title: "Send Agent Message",
      description:
        "Send a message to another agent through Oracle's shared message bus. Use to: '*' to broadcast to all agents. Set replyTo to continue a thread.",
      inputSchema: {
        from: z.string().min(1).describe("Your agent name, e.g. 'claude-code'"),
        to: z.string().min(1).describe("Recipient agent name, or '*' for broadcast"),
        body: z.string().min(1).max(20000),
        subject: z.string().max(200).optional(),
        replyTo: z.string().optional().describe("Message id this replies to")
      }
    },
    async ({ from, to, body, subject, replyTo }) => {
      try {
        const msg = await messages.send({ from, to, body, subject, replyTo });
        return success(`Sent ${msg.id} to ${to}.`, { id: msg.id, ts: msg.ts, to });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_msg_inbox",
    {
      title: "Check Agent Inbox",
      description:
        "Read messages addressed to you (including broadcasts). Unread only by default; ack them with oracle_msg_ack after handling.",
      inputSchema: {
        agent: z.string().min(1).describe("Your agent name"),
        unreadOnly: z.boolean().default(true),
        limit: z.number().int().min(1).max(200).default(50)
      }
    },
    async ({ agent: agentName, unreadOnly, limit }) => {
      try {
        const inbox = await messages.inbox(agentName, { unreadOnly, limit });
        const lines = inbox.map(
          (m) => `${m.id} | ${m.ts} | from ${m.from}${m.subject ? ` | ${m.subject}` : ""}\n${m.body}`
        );
        return success(
          inbox.length ? lines.join("\n---\n") : "Inbox empty.",
          { count: inbox.length, messages: inbox as unknown as Record<string, unknown>[] }
        );
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_msg_ack",
    {
      title: "Acknowledge Messages",
      description: "Mark messages as read so they stop appearing in your unread inbox.",
      inputSchema: {
        agent: z.string().min(1).describe("Your agent name"),
        ids: z.array(z.string().min(1)).min(1).max(200)
      }
    },
    async ({ agent: agentName, ids }) => {
      try {
        const acked = await messages.ack(agentName, ids);
        return success(`Acked ${acked.length}/${ids.length}.`, { acked });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_msg_thread",
    {
      title: "Read Message Thread",
      description: "Fetch the full conversation thread containing the given message id.",
      inputSchema: { id: z.string().min(1) }
    },
    async ({ id }) => {
      try {
        const thread = await messages.thread(id);
        const lines = thread.map((m) => `${m.id} | ${m.ts} | ${m.from} → ${m.to}\n${m.body}`);
        return success(
          thread.length ? lines.join("\n---\n") : `No thread found for ${id}.`,
          { count: thread.length, messages: thread as unknown as Record<string, unknown>[] }
        );
      } catch (error) { return failure(error); }
    }
  );
}
