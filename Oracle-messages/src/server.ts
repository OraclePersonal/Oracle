import crypto from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { MessageStore } from "./store.js";
import { TaskStore } from "./tasks.js";
import { ACK_STATUSES, MESSAGE_KINDS, PRESENCE_STATUSES, TASK_STATUSES } from "./types.js";
import type { MessageKind } from "./types.js";

// ─── Helpers ───────────────────────────────────────────────────

const agentSchema = z.string().trim().min(1).max(128);
const messageIdSchema = z.string().trim().min(1).max(256);
const optionalMetaSchema = z.record(z.string(), z.unknown()).optional();

function ok(data: Record<string, unknown>) {
  const output = { success: true, ...data };
  return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }], structuredContent: output };
}

function fail(error: unknown) {
  const msg = error instanceof Error ? error.message : String(error);
  const output = { success: false, error: msg };
  return { content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output, isError: true };
}

// ─── Create Server ─────────────────────────────────────────────

const SERVER_INFO = { name: "oracle-messages", version: "0.2.0" };

const SERVER_INSTRUCTIONS = `# oracle-messages — multi-agent MCP message bus

A vendor-neutral mailbox for AI coding agents. Any MCP-compatible agent
(Claude Code, Codex, Gemini CLI, Cline, OpenCode, KilloCode, Clew Code, etc.)
can send, receive, and coordinate via this bus.

## Quick start

1. \`register_agent(agent="my-name", client="MyClient")\` — join the bus
2. \`send_message(sender="my-name", recipient="other-agent", body="...")\` — send a message
3. \`sync_messages(agent="my-name")\` — pull unread messages
4. \`reply_message(message_id="...", sender="my-name", body="...")\` — reply in thread
5. \`wait_for_message(agent="my-name")\` — block until a new message arrives

## Message kinds that open threads (require resolution)
- \`question\` — needs an answer
- \`review-request\` — needs a review
- \`proposal\` — needs acceptance/rejection

## Task lifecycle
\`pending → assigned → in_progress → completed | failed | cancelled\`

## Tips
- Use \`broadcast\` for announcements visible to all agents
- Use \`subscribe/unsubscribe\` for channel-based messaging
- Use \`advance_cursor\` to track your read position
- \`get_thread(root_id)\` fetches a root + all replies
- \`onboard()\` combines registration + status in one call

## Prompt templates
- \`save_prompt(name, template)\` — save a reusable template with \`{{variable}}\` placeholders
- \`render_prompt(name, variables)\` — render it; also exposed as MCP prompt \`custom_<name>\`
`;

export function createServer(rootDir: string): McpServer {
  const store = new MessageStore(rootDir);
  const tasks = new TaskStore(rootDir);

  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {}, resources: {}, prompts: {} },
    instructions: SERVER_INSTRUCTIONS,
  });

  // ═══════════════════ TOOLS ═══════════════════

  // ─── Identity ─────────────────────────────────

  server.registerTool("onboard", {
    description: "Register agent identity and get status, open threads, and unread count in one call.",
    inputSchema: {
      agent: agentSchema,
      role: z.string().trim().max(128).optional(),
      group: z.string().trim().max(128).optional(),
      client: z.string().trim().max(128).optional(),
      capabilities: z.array(z.string().trim().min(1).max(128)).max(100).optional(),
    },
  }, async (args) => {
    try {
      const registration = await store.registerAgent(args);
      await store.recordSession(args.agent);
      const unread = await store.readUnread(args.agent, 10);
      const openThreads = await store.listOpenThreads(args.agent);
      const stats = await store.mailboxStats();
      return ok({
        agent: registration.agent,
        registered_at: registration.registered_at,
        unread_count: unread.length,
        open_thread_count: openThreads.length,
        total_agents: stats.total_agents,
        total_messages: stats.total_messages,
        role: registration.role ?? null,
        group: registration.group ?? null,
      });
    } catch (error) { return fail(error); }
  });

  server.registerTool("register_identity", {
    description: "Register or update agent identity and capabilities.",
    inputSchema: {
      agent: agentSchema,
      client: z.string().trim().max(128).optional(),
      capabilities: z.array(z.string().trim().min(1).max(128)).max(100).optional(),
      meta: optionalMetaSchema,
    },
  }, async (args) => {
    try { return ok({ registration: await store.registerAgent(args) }); }
    catch (error) { return fail(error); }
  });

  server.registerTool("get_status", {
    description: "Get current mailbox status: counts, agents, latest activity.",
    inputSchema: z.object({}),
  }, async () => {
    try {
      const stats = await store.mailboxStats();
      const agents = await store.listAgents();
      return ok({ stats, agents: agents.map((a) => ({ agent: a.agent, role: a.role, last_seen: a.last_seen_at })) });
    } catch (error) { return fail(error); }
  });

  server.registerTool("get_agent_instructions", {
    description: "Get instructions and metadata for a registered agent.",
    inputSchema: { agent: agentSchema },
  }, async ({ agent }) => {
    try { return ok({ instructions: await store.getAgentInstructions(agent) }); }
    catch (error) { return fail(error); }
  });

  // ─── Roster ───────────────────────────────────

  server.registerTool("list_agents", {
    description: "List all registered agents with their client, role, group, capabilities, and last-seen.",
    inputSchema: z.object({}),
  }, async () => {
    try {
      const agents = await store.listAgents();
      return ok({ agents, count: agents.length });
    } catch (error) { return fail(error); }
  });

  server.registerTool("add_agent", {
    description: "Register a new agent explicitly.",
    inputSchema: {
      agent: agentSchema,
      client: z.string().trim().max(128).optional(),
      role: z.string().trim().max(128).optional(),
      capabilities: z.array(z.string().trim().min(1).max(128)).max(100).optional(),
    },
  }, async (args) => {
    try { return ok({ registration: await store.registerAgent(args) }); }
    catch (error) { return fail(error); }
  });

  server.registerTool("retire_agent", {
    description: "Remove an agent from the registry permanently. Also cleans up cards, subscriptions, and cursors.",
    inputSchema: { agent: agentSchema },
  }, async ({ agent }) => {
    try {
      const result = await store.retireAgent(agent);
      return ok(result);
    } catch (error) { return fail(error); }
  });

  server.registerTool("set_agent_role", {
    description: "Set or update an agent's role.",
    inputSchema: { agent: agentSchema, role: z.string().trim().min(1).max(128) },
  }, async ({ agent, role }) => {
    try { return ok({ registration: await store.setAgentRole(agent, role) }); }
    catch (error) { return fail(error); }
  });

  server.registerTool("set_agent_group", {
    description: "Set or update an agent's group.",
    inputSchema: { agent: agentSchema, group: z.string().trim().min(1).max(128) },
  }, async ({ agent, group }) => {
    try { return ok({ registration: await store.setAgentGroup(agent, group) }); }
    catch (error) { return fail(error); }
  });

  // ─── Messaging ────────────────────────────────

  server.registerTool("send_message", {
    description: "Send a durable message to a specific agent. Use recipient='*' for broadcast.",
    inputSchema: {
      sender: agentSchema,
      recipient: agentSchema.or(z.literal("*")),
      body: z.string().min(1).max(1_000_000),
      kind: z.enum(MESSAGE_KINDS).optional(),
      subject: z.string().max(500).optional(),
      parent_id: messageIdSchema.optional(),
      in_reply_to: messageIdSchema.optional(),
      channel: z.string().trim().max(128).optional(),
      meta: optionalMetaSchema,
      ttl_seconds: z.number().int().positive().max(7776000).optional().describe("Auto-expire after N seconds (max 90 days)"),
    },
  }, async (args) => {
    try { return ok({ message: await store.send(args) }); }
    catch (error) { return fail(error); }
  });

  server.registerTool("broadcast", {
    description: "Send an event visible to every agent except the sender.",
    inputSchema: {
      sender: agentSchema,
      body: z.string().min(1).max(1_000_000),
      kind: z.enum(MESSAGE_KINDS).optional().default("event"),
      subject: z.string().max(500).optional(),
      channel: z.string().trim().max(128).optional(),
      meta: optionalMetaSchema,
    },
  }, async (args) => {
    try { return ok({ message: await store.send({ ...args, recipient: "*" } as Parameters<typeof store.send>[0]) }); }
    catch (error) { return fail(error); }
  });

  server.registerTool("wait_for_message", {
    description: "Block and poll for new messages to this agent. Returns empty array if timeout reached — call again.",
    inputSchema: {
      agent: agentSchema,
      timeout_seconds: z.number().int().min(1).max(300).optional().default(30),
      max_retries: z.number().int().min(0).max(100).optional().default(10),
    },
  }, async ({ agent, timeout_seconds, max_retries }) => {
    try {
      // Poll: check for unread, sleep, repeat
      const pollMs = Math.max(1000, Math.floor((timeout_seconds * 1000) / Math.max(1, max_retries)));
      let messages = await store.readUnread(agent, 50);
      let attempts = 0;
      while (messages.length === 0 && attempts < max_retries) {
        await new Promise((r) => setTimeout(r, pollMs));
        messages = await store.readUnread(agent, 50);
        attempts++;
      }
      const cursor = messages.length > 0 ? messages[messages.length - 1].id : undefined;
      return ok({ messages, count: messages.length, cursor, attempts });
    } catch (error) { return fail(error); }
  });

  server.registerTool("sync_messages", {
    description: "Pull unread direct and broadcast messages for an agent. Messages are marked read on delivery.",
    inputSchema: {
      agent: agentSchema,
      limit: z.number().int().min(1).max(200).optional().default(50),
    },
  }, async ({ agent, limit }) => {
    try {
      const messages = await store.readUnread(agent, limit);
      return ok({ messages, count: messages.length });
    } catch (error) { return fail(error); }
  });

  server.registerTool("list_messages", {
    description: "Browse message history with optional filters for agent, sender, kind, channel, and full-text query.",
    inputSchema: {
      agent: agentSchema.optional(),
      sender: agentSchema.optional(),
      kind: z.enum(MESSAGE_KINDS).optional(),
      channel: z.string().trim().max(128).optional(),
      query: z.string().max(500).optional(),
      limit: z.number().int().min(1).max(500).optional().default(100),
    },
  }, async (args) => {
    try {
      const messages = await store.listMessages(args);
      return ok({ messages, count: messages.length });
    } catch (error) { return fail(error); }
  });

  server.registerTool("search_messages", {
    description: "Full-text search across message bodies.",
    inputSchema: {
      query: z.string().min(1).max(500),
      limit: z.number().int().min(1).max(200).optional().default(50),
    },
  }, async ({ query, limit }) => {
    try {
      const messages = await store.searchMessages(query, limit);
      return ok({ messages, count: messages.length });
    } catch (error) { return fail(error); }
  });

  server.registerTool("get_message", {
    description: "Fetch a single message by its ID.",
    inputSchema: { message_id: messageIdSchema },
  }, async ({ message_id }) => {
    try {
      const message = await store.getMessage(message_id);
      if (!message) return fail(`Message not found: ${message_id}`);
      return ok({ message });
    } catch (error) { return fail(error); }
  });

  server.registerTool("reply_message", {
    description: "Reply to a message preserving thread linkage. Auto-fills parent_id, recipient, and reply kind.",
    inputSchema: {
      message_id: messageIdSchema,
      sender: agentSchema,
      body: z.string().min(1).max(1_000_000),
      kind: z.enum(MESSAGE_KINDS).optional().default("response"),
      subject: z.string().max(500).optional(),
      meta: optionalMetaSchema,
    },
  }, async ({ message_id, sender, body, kind, subject, meta }) => {
    try {
      const original = await store.getMessage(message_id);
      if (!original) throw new Error(`Message not found: ${message_id}`);
      const rootId = original.parent_id ?? original.id;
      const message = await store.send({
        sender,
        recipient: original.sender,
        body,
        kind: kind as MessageKind,
        subject,
        parent_id: rootId,
        in_reply_to: original.id,
        channel: original.channel,
        meta,
      });
      return ok({ message });
    } catch (error) { return fail(error); }
  });

  server.registerTool("get_thread", {
    description: "Get a root message and all its direct replies (one level).",
    inputSchema: { root_id: messageIdSchema },
  }, async ({ root_id }) => {
    try { return ok({ thread: await store.getThread(root_id) }); }
    catch (error) { return fail(error); }
  });

  server.registerTool("list_open_threads", {
    description: "List unresolved threads (questions, review-requests, proposals) addressed to an agent.",
    inputSchema: { agent: agentSchema },
  }, async ({ agent }) => {
    try {
      const threads = await store.listOpenThreads(agent);
      return ok({ threads, count: threads.length });
    } catch (error) { return fail(error); }
  });

  server.registerTool("delete_message", {
    description: "Delete a single message by ID. Irreversible.",
    inputSchema: { message_id: messageIdSchema },
  }, async ({ message_id }) => {
    try {
      const deleted = await store.deleteMessage(message_id);
      return deleted ? ok({ deleted: true }) : fail(`Message not found: ${message_id}`);
    } catch (error) { return fail(error); }
  });

  // ─── Acknowledgements ─────────────────────────

  server.registerTool("acknowledge_message", {
    description: "Record processing status: received | accepted | completed | rejected | failed.",
    inputSchema: {
      message_id: messageIdSchema,
      agent: agentSchema,
      status: z.enum(ACK_STATUSES),
      note: z.string().max(2_000).optional(),
    },
  }, async ({ message_id, agent, status, note }) => {
    try {
      return ok({ acknowledgement: await store.acknowledge(message_id, agent, status, note) });
    } catch (error) { return fail(error); }
  });

  server.registerTool("get_acknowledgements", {
    description: "List all acknowledgements for a message.",
    inputSchema: { message_id: messageIdSchema },
  }, async ({ message_id }) => {
    try {
      const acknowledgements = await store.getAcknowledgements(message_id);
      return ok({ acknowledgements, count: acknowledgements.length });
    } catch (error) { return fail(error); }
  });

  // ─── Cursors ──────────────────────────────────

  server.registerTool("advance_cursor", {
    description: "Record that an agent has read up to a specific message. Tracks read position across sessions.",
    inputSchema: { agent: agentSchema, message_id: messageIdSchema },
  }, async ({ agent, message_id }) => {
    try { return ok({ cursor: await store.advanceCursor(agent, message_id) }); }
    catch (error) { return fail(error); }
  });

  // ─── Tasks ────────────────────────────────────

  server.registerTool("create_task", {
    description: "Create a new task. Starts as 'pending' — use transition_task to assign or progress.",
    inputSchema: {
      title: z.string().min(1).max(500),
      description: z.string().min(1).max(100_000),
      sender: agentSchema,
      assignee: agentSchema.optional(),
      meta: optionalMetaSchema,
    },
  }, async (args) => {
    try { return ok({ task: await tasks.createTask(args) }); }
    catch (error) { return fail(error); }
  });

  server.registerTool("transition_task", {
    description: "Change a task's status. Lifecycle: pending → assigned → in_progress → completed | failed | cancelled.",
    inputSchema: {
      task_id: z.string().min(1).max(256),
      status: z.enum(TASK_STATUSES),
      assignee: agentSchema.optional(),
    },
  }, async ({ task_id, status, assignee }) => {
    try { return ok({ task: await tasks.transitionTask(task_id, status, assignee) }); }
    catch (error) { return fail(error); }
  });

  server.registerTool("get_task", {
    description: "Get a task by ID.",
    inputSchema: { task_id: z.string().min(1).max(256) },
  }, async ({ task_id }) => {
    try {
      const task = await tasks.getTask(task_id);
      if (!task) return fail(`Task not found: ${task_id}`);
      return ok({ task });
    } catch (error) { return fail(error); }
  });

  server.registerTool("list_tasks", {
    description: "List tasks filtered by status, assignee, or sender.",
    inputSchema: {
      status: z.enum(TASK_STATUSES).optional(),
      assignee: agentSchema.optional(),
      sender: agentSchema.optional(),
      limit: z.number().int().min(1).max(200).optional().default(100),
    },
  }, async (args) => {
    try {
      const taskList = await tasks.listTasks(args);
      return ok({ tasks: taskList, count: taskList.length });
    } catch (error) { return fail(error); }
  });

  // ─── Agent Discovery ──────────────────────────

  server.registerTool("set_agent_card", {
    description: "Publish a discoverable card — name, description, contact info, channels.",
    inputSchema: {
      agent: agentSchema,
      name: z.string().max(200).optional(),
      description: z.string().max(2000).optional(),
      contact: z.string().max(500).optional(),
      channels: z.array(z.string().max(128)).max(50).optional(),
      meta: optionalMetaSchema,
    },
  }, async ({ agent, ...card }) => {
    try {
      await store.setAgentCard(agent, card);
      return ok({ agent, card_updated: true });
    } catch (error) { return fail(error); }
  });

  server.registerTool("get_agent_card", {
    description: "Get an agent's published card.",
    inputSchema: { agent: agentSchema },
  }, async ({ agent }) => {
    try {
      const card = await store.getAgentCard(agent);
      if (!card) return fail(`No card found for agent: ${agent}`);
      return ok({ card });
    } catch (error) { return fail(error); }
  });

  server.registerTool("find_agents", {
    description: "Find agents by name, role, group, or capability keyword.",
    inputSchema: { query: z.string().min(1).max(200) },
  }, async ({ query }) => {
    try {
      const agents = await store.findAgents(query);
      return ok({ agents, count: agents.length });
    } catch (error) { return fail(error); }
  });

  // ─── Channels ─────────────────────────────────

  server.registerTool("subscribe", {
    description: "Subscribe an agent to a channel. Channel messages are delivered via sync_messages.",
    inputSchema: { agent: agentSchema, channel: z.string().trim().min(1).max(128) },
  }, async ({ agent, channel }) => {
    try { return ok({ subscription: await store.subscribe(agent, channel) }); }
    catch (error) { return fail(error); }
  });

  server.registerTool("unsubscribe", {
    description: "Unsubscribe an agent from a channel.",
    inputSchema: { agent: agentSchema, channel: z.string().trim().min(1).max(128) },
  }, async ({ agent, channel }) => {
    try {
      await store.unsubscribe(agent, channel);
      return ok({ unsubscribed: true });
    } catch (error) { return fail(error); }
  });

  // ─── Server ───────────────────────────────────

  server.registerTool("mailbox_stats", {
    description: "Return total message and agent counts, plus oldest/newest timestamps.",
    inputSchema: z.object({}),
  }, async () => {
    try { return ok({ stats: await store.mailboxStats() }); }
    catch (error) { return fail(error); }
  });

  server.registerTool("prune", {
    description: "Remove messages, reads, and acknowledgements older than the given retention period.",
    inputSchema: { retention_hours: z.number().int().positive() },
  }, async ({ retention_hours }) => {
    try {
      const before = new Date(Date.now() - retention_hours * 3_600_000);
      return ok({ pruned: await store.prune(before) });
    } catch (error) { return fail(error); }
  });

  server.registerTool("server_status", {
    description: "Get server health, uptime, session count, and data directory info.",
    inputSchema: z.object({}),
  }, async () => {
    try {
      const stats = await store.mailboxStats();
      const agents = await store.listAgents();
      const sessions = await store.getSessions();
      return ok({
        server: "oracle-messages",
        version: "0.2.0",
        status: "running",
        data_dir: rootDir,
        stats,
        sessions: sessions.length,
        agents_online: agents.length,
      });
    } catch (error) { return fail(error); }
  });

  // ─── Presence ───────────────────────────────────

  server.registerTool("update_presence", {
    description: "Set your agent presence status: online | busy | idle | offline.",
    inputSchema: {
      agent: agentSchema,
      status: z.enum(PRESENCE_STATUSES),
    },
  }, async ({ agent, status }) => {
    try {
      const presence = await store.updatePresence(agent, status);
      return ok({ presence });
    } catch (error) { return fail(error); }
  });

  server.registerTool("get_presence", {
    description: "Get the current presence status of an agent.",
    inputSchema: { agent: agentSchema },
  }, async ({ agent }) => {
    try {
      const presence = await store.getPresence(agent);
      return ok({ presence: presence ?? null });
    } catch (error) { return fail(error); }
  });

  server.registerTool("list_presences", {
    description: "List all agents and their current presence status.",
    inputSchema: {},
  }, async () => {
    try {
      return ok({ presences: await store.listPresences() });
    } catch (error) { return fail(error); }
  });

  // ─── Reactions ──────────────────────────────────

  server.registerTool("react", {
    description: "React to a message with an emoji (👍👎🚀❤️🎉 etc).",
    inputSchema: {
      message_id: messageIdSchema,
      agent: agentSchema,
      emoji: z.string().min(1).max(20),
    },
  }, async ({ message_id, agent, emoji }) => {
    try {
      const reaction = await store.react(message_id, agent, emoji);
      return ok({ reaction });
    } catch (error) { return fail(error); }
  });

  server.registerTool("list_reactions", {
    description: "List all reactions on a message.",
    inputSchema: { message_id: messageIdSchema },
  }, async ({ message_id }) => {
    try {
      return ok({ reactions: await store.listReactions(message_id) });
    } catch (error) { return fail(error); }
  });

  // ─── Webhooks ───────────────────────────────────

  server.registerTool("set_webhook", {
    description: "Register a webhook URL for an agent. New messages to this agent will POST there.",
    inputSchema: {
      agent: agentSchema,
      url: z.string().url().describe("HTTP endpoint to receive message POSTs"),
    },
  }, async ({ agent, url }) => {
    try {
      const webhook = await store.setWebhook(agent, url);
      return ok({ webhook });
    } catch (error) { return fail(error); }
  });

  server.registerTool("get_webhook", {
    description: "Get the registered webhook for an agent.",
    inputSchema: { agent: agentSchema },
  }, async ({ agent }) => {
    try {
      const webhook = await store.getWebhook(agent);
      return ok({ webhook: webhook ?? null });
    } catch (error) { return fail(error); }
  });

  server.registerTool("remove_webhook", {
    description: "Remove the webhook registration for an agent.",
    inputSchema: { agent: agentSchema },
  }, async ({ agent }) => {
    try {
      const removed = await store.removeWebhook(agent);
      return ok({ agent, removed });
    } catch (error) { return fail(error); }
  });

  // ═══════════════════ RESOURCES ═══════════════════

  server.resource("instructions", "oracle://instructions", {
    description: "Server instructions and usage guide",
    mimeType: "text/markdown",
  }, async () => ({ contents: [{ uri: "oracle://instructions", text: SERVER_INSTRUCTIONS, mimeType: "text/markdown" }] }));

  server.resource("roster", "oracle://roster", {
    description: "All registered agents",
    mimeType: "application/json",
  }, async () => {
    const agents = await store.listAgents();
    return { contents: [{ uri: "oracle://roster", text: JSON.stringify(agents, null, 2), mimeType: "application/json" }] };
  });

  server.resource("messages", "oracle://messages", {
    description: "All messages (latest 200)",
    mimeType: "application/json",
  }, async () => {
    const messages = await store.listMessages({ limit: 200 });
    return { contents: [{ uri: "oracle://messages", text: JSON.stringify(messages, null, 2), mimeType: "application/json" }] };
  });

  server.resource("threads/open", "oracle://threads/open", {
    description: "All open threads across all agents",
    mimeType: "application/json",
  }, async () => {
    const agents = await store.listAgents();
    const allThreads: Record<string, unknown>[] = [];
    for (const a of agents) {
      const threads = await store.listOpenThreads(a.agent);
      allThreads.push({ agent: a.agent, count: threads.length, threads });
    }
    return { contents: [{ uri: "oracle://threads/open", text: JSON.stringify(allThreads, null, 2), mimeType: "application/json" }] };
  });

  server.resource("stats", "oracle://stats", {
    description: "Mailbox statistics",
    mimeType: "application/json",
  }, async () => {
    const stats = await store.mailboxStats();
    return { contents: [{ uri: "oracle://stats", text: JSON.stringify(stats, null, 2), mimeType: "application/json" }] };
  });

  server.resource("agent/{name}/unread", new ResourceTemplate("oracle://agent/{name}/unread", {
    list: async () => {
      const agents = await store.listAgents();
      return { resources: agents.map((a) => ({ uri: `oracle://agent/${a.agent}/unread`, name: `${a.agent}-unread`, description: `Unread messages for ${a.agent}`, mimeType: "application/json" })) };
    },
  }), {
    description: "Unread messages for a specific agent",
    mimeType: "application/json",
  }, async (uri, { name }) => {
    const messages = await store.readUnread(name as string, 50);
    return { contents: [{ uri: uri.href, text: JSON.stringify(messages, null, 2), mimeType: "application/json" }] };
  });

  server.resource("message/{id}", new ResourceTemplate("oracle://message/{id}", {
    list: async () => {
      const messages = await store.listMessages({ limit: 100 });
      return { resources: messages.map((m) => ({ uri: `oracle://message/${m.id}`, name: `msg-${m.id.slice(0, 16)}`, description: `${m.sender} → ${m.recipient}: ${(m.subject ?? m.body).slice(0, 40)}`, mimeType: "application/json" })) };
    },
  }), {
    description: "A single message by ID",
    mimeType: "application/json",
  }, async (uri, { id }) => {
    const message = await store.getMessage(id as string);
    if (!message) return { contents: [{ uri: uri.href, text: "Message not found", mimeType: "text/plain" }] };
    return { contents: [{ uri: uri.href, text: JSON.stringify(message, null, 2), mimeType: "application/json" }] };
  });

  server.resource("thread/{id}", new ResourceTemplate("oracle://thread/{id}", {
    list: async () => {
      const messages = await store.listMessages({ limit: 100 });
      const roots = messages.filter((m) => !m.parent_id);
      return { resources: roots.map((m) => ({ uri: `oracle://thread/${m.id}`, name: `thread-${m.id.slice(0, 16)}`, description: `Thread: ${(m.subject ?? m.body).slice(0, 40)}`, mimeType: "application/json" })) };
    },
  }), {
    description: "A message thread (root + replies)",
    mimeType: "application/json",
  }, async (uri, { id }) => {
    const thread = await store.getThread(id as string);
    return { contents: [{ uri: uri.href, text: JSON.stringify(thread, null, 2), mimeType: "application/json" }] };
  });

  // ═══════════════════ PROMPTS ═══════════════════

  server.prompt("standup", "Daily standup prompt — summarizes what happened since last check-in.", {
    agent: agentSchema.describe("Your agent name"),
  }, async ({ agent }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `# Standup for agent: ${agent}

Check your messages and report:
1. What messages arrived since your last cursor position?
2. Any open threads requiring your response?
3. Any tasks assigned to you?

Run \`sync_messages(agent="${agent}")\` and \`list_open_threads(agent="${agent}")\` to prepare.`,
      },
    }],
  }));

  server.prompt("triage_unread", "Triage all unread messages and open threads.", {
    agent: agentSchema.describe("Your agent name"),
  }, async ({ agent }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `# Triage for agent: ${agent}

1. Run \`sync_messages(agent="${agent}")\`
2. Categorize each message: actionable, informational, or spam
3. For actionable messages, decide: reply now, defer with a task, or acknowledge
4. Run \`list_open_threads(agent="${agent}")\` and resolve each one`,
      },
    }],
  }));

  server.prompt("handoff", "Handoff task from one agent to another.", {
    from: agentSchema.describe("Current agent"),
    to: agentSchema.describe("Target agent"),
    task: z.string().min(1).max(2000).describe("What needs to be done"),
  }, async ({ from, to, task }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `# Handoff: ${from} → ${to}

## Task
${task}

## Instructions
1. Create a task: \`create_task(title="Handoff from ${from}", description=..., sender="${from}", assignee="${to}")\`
2. Send a message: \`send_message(sender="${from}", recipient="${to}", body=..., kind="request")\`
3. The recipient should acknowledge and begin work`,
      },
    }],
  }));

  server.prompt("review_request", "Request a code review from another agent.", {
    reviewer: agentSchema.describe("The agent to review"),
    author: agentSchema.describe("The requesting agent"),
    context: z.string().min(1).max(5000).describe("What needs review"),
  }, async ({ reviewer, author, context }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `# Review Request: ${author} → ${reviewer}

${context}

## Flow
1. ${author}: \`send_message(sender="${author}", recipient="${reviewer}", body=..., kind="review-request")\`
2. ${reviewer}: review the code
3. ${reviewer}: \`reply_message(message_id=..., sender="${reviewer}", body="Review findings...")\``,
      },
    }],
  }));

  return server;
}

// ─── Transports ────────────────────────────────────────

function onShutdown(signal: string): never {
  console.error(`oracle-messages: ${signal}, exiting`);
  process.exit(0);
}

export async function runStdio(rootDir: string): Promise<void> {
  process.on("SIGINT", () => onShutdown("SIGINT"));
  process.on("SIGTERM", () => onShutdown("SIGTERM"));
  await createServer(rootDir).connect(new StdioServerTransport());
}

export async function runHttp(rootDir: string, port: number, host: string): Promise<void> {
  const server = createServer(rootDir);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
  await server.connect(transport);

  const httpServer = createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname === "/health") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (url.pathname !== "/mcp") {
        response.writeHead(404).end();
        return;
      }
      const token = process.env.ORACLE_MESSAGES_HTTP_TOKEN;
      if (token && request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      await transport.handleRequest(request, response);
    } catch (error) {
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  httpServer.listen(port, host, () => {
    console.error(`oracle-messages: http://${host}:${port}/mcp`);
  });

  const shutdown = (signal: string) => {
    console.error(`oracle-messages: ${signal}, closing`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
