import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { serializeOracleError } from "../errors.js";
import type { MessageStore } from "../messaging/store.js";
import type { AgentRegistry } from "../messaging/registry.js";

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
 * Injected into the MCP client's context the moment it connects (via the
 * server `instructions` field), so every agent learns the onboarding flow
 * without anyone telling it manually.
 */
export const MESSAGING_INSTRUCTIONS = [
  "Oracle inter-agent message bus is available. Other AI agents on this machine may send you work or questions through it.",
  "BEFORE starting any task in this session: (1) call oracle_msg_register with a stable agent name (kebab-case, e.g. 'claude-main') and a short role; it returns the roster of other agents and your unread messages in one call. (2) Handle anything urgent in that unread list, ack it, then proceed with your task.",
  "During work: reply with replyTo to keep threads, ack every message you have handled, and check oracle_msg_inbox again at natural pauses (after finishing a subtask, before declaring done).",
  "Use oracle_msg_agents anytime to see who is registered and recently active before addressing them."
].join(" ");

/**
 * Register the inter-agent messaging tools (`oracle_msg_*`) on an MCP server.
 *
 * Shared by the full Oracle server (`registerOracleTools`) and the standalone
 * messaging-only server (`src/mcp-messaging.ts`), so the tool surface stays
 * identical whichever binary a client wires up.
 */
export function registerMessagingTools(server: McpServer, messages: MessageStore, registry: AgentRegistry): void {
  server.registerTool(
    "oracle_msg_register",
    {
      title: "Register on the Agent Bus",
      description:
        "Onboard onto the inter-agent bus: register your agent name (and optional role), see who else is active, and get your unread messages — one call, do this before starting work in a session. Idempotent; re-registering just updates presence.",
      inputSchema: {
        name: z.string().min(1).max(64).describe("Your stable agent name, kebab-case, e.g. 'claude-main'"),
        role: z.string().max(200).optional().describe("Short role description, e.g. 'refactoring the Oracle repo'")
      }
    },
    async ({ name, role }) => {
      try {
        const record = await registry.register(name, role);
        const [roster, unread] = await Promise.all([
          registry.list(),
          messages.inbox(record.name, { unreadOnly: true, limit: 20 })
        ]);
        const others = roster.filter((a) => a.name !== record.name);
        const lines = [
          `Registered as "${record.name}"${record.role ? ` (${record.role})` : ""}.`,
          others.length
            ? `Other agents: ${others.map((a) => `${a.name}${a.active ? " [active]" : ""}`).join(", ")}`
            : "No other agents registered yet.",
          unread.length
            ? `You have ${unread.length} unread message(s) — handle and ack them before starting other work:\n` +
              unread.map((m) => `- ${m.id} | from ${m.from}${m.subject ? ` | ${m.subject}` : ""}: ${m.body.slice(0, 120)}`).join("\n")
            : "No unread messages."
        ];
        return success(lines.join("\n"), {
          agent: record as unknown as Record<string, unknown>,
          roster: roster as unknown as Record<string, unknown>[],
          unreadCount: unread.length,
          unread: unread as unknown as Record<string, unknown>[]
        });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_msg_agents",
    {
      title: "List Registered Agents",
      description:
        "Show every agent registered on the bus with their role, last-seen time, and whether they were active in the last 10 minutes.",
      inputSchema: {}
    },
    async () => {
      try {
        const roster = await registry.list();
        const lines = roster.map(
          (a) => `${a.name}${a.active ? " [active]" : ""}${a.role ? ` — ${a.role}` : ""} (last seen ${a.lastSeen})`
        );
        return success(
          roster.length ? lines.join("\n") : "No agents registered yet.",
          { count: roster.length, agents: roster as unknown as Record<string, unknown>[] }
        );
      } catch (error) { return failure(error); }
    }
  );

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
        await registry.touch(from);
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
        await registry.touch(agentName);
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
        await registry.touch(agentName);
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
