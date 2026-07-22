import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { serializeOracleError } from "../errors.js";
import type { TaskStore, TaskStatus } from "../tasks/store.js";
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

const STATUS_ENUM = z.enum(["pending", "in_progress", "review", "done", "blocked", "cancelled"]);

/**
 * Injected alongside MESSAGING_INSTRUCTIONS into the MCP client's context on
 * connect, so every agent learns the plan/track/verify/report flow without
 * anyone telling it manually.
 */
export const TASK_INSTRUCTIONS = [
  "A task tracker sits on top of the message bus for planning and accountability.",
  "As a lead breaking down work: use oracle_task_create per unit of work, assigned to a specific agent, with a checklist of concrete verification steps if the task has a clear definition of done. This automatically messages the assignee.",
  "As an assignee: call oracle_task_update to record progress notes and status changes as you go — this is the audit trail, not just an end-of-task summary. Check off each checklist item via oracle_task_checklist as you actually complete it, not preemptively.",
  "Before reporting a task done: call oracle_task_submit. It BLOCKS if any checklist item is unchecked, and on success automatically notifies the task creator — you do not need to separately message them that you're done.",
  "As a lead reviewing: oracle_task_get shows the full checklist and note history; oracle_task_close with approved=true finishes it, or approved=false with a note sends it back to in_progress.",
  "Use oracle_task_list { assignee: <you>, activeOnly: true } to see your open work at a glance. Leads can use oracle_task_board to see an ASCII work board combining the agent roster and all main TODOs."
].join(" ");

function formatTask(t: { id: string; title: string; status: TaskStatus; assignee: string; createdBy: string; checklist: { text: string; done: boolean }[] }): string {
  const checklist = t.checklist.length
    ? "\n  " + t.checklist.map((c) => `[${c.done ? "x" : " "}] ${c.text}`).join("\n  ")
    : "";
  return `${t.id} | ${t.status} | ${t.title} | ${t.createdBy} -> ${t.assignee}${checklist}`;
}

/**
 * Register task-planning tools (`oracle_task_*`) that build on the message
 * bus: a lead breaks work into tasks and assigns them, agents track
 * progress and check off a verification checklist, then submit for review
 * — which auto-reports to the task creator over oracle_msg_send so no one
 * has to manually "tell the boss it's done."
 */
function boardRow(task: { id: string; title: string; assignee: string; createdBy: string; status: TaskStatus }): string {
  const title = task.title.length > 42 ? `${task.title.slice(0, 39)}...` : task.title;
  return `| ${task.status.padEnd(11)} | ${task.assignee.padEnd(20)} | ${title.padEnd(42)} | ${task.id} |`;
}

/** Render a terminal-safe overview so every MCP client can inspect the work. */
export function formatTaskBoard(
  agents: Array<{ name: string; role?: string; active: boolean }>,
  tasks: Array<{ id: string; title: string; assignee: string; createdBy: string; status: TaskStatus }>
): string {
  const agentLines = agents.length
    ? agents.map((agent) => `| ${agent.name.padEnd(22)} | ${(agent.active ? "ACTIVE" : "idle").padEnd(6)} | ${(agent.role ?? "-").slice(0, 48).padEnd(48)} |`)
    : ["| (no registered agents)                                                    |"];
  const todoLines = tasks.length ? tasks.map(boardRow) : ["| (no TODOs on this board)                                                      |"];
  return [
    "+--------------------------+--------+--------------------------------------------------+",
    "| AGENT ROSTER             | STATE  | ROLE                                             |",
    "+--------------------------+--------+--------------------------------------------------+",
    ...agentLines,
    "+--------------------------+--------+--------------------------------------------------+",
    "",
    "+-------------+----------------------+--------------------------------------------+--------------------+",
    "| STATUS      | ASSIGNEE             | MAIN TODO                                  | TASK ID            |",
    "+-------------+----------------------+--------------------------------------------+--------------------+",
    ...todoLines,
    "+-------------+----------------------+--------------------------------------------+--------------------+"
  ].join("\n");
}

export function registerTaskTools(server: McpServer, tasks: TaskStore, messages: MessageStore, registry: AgentRegistry): void {
  server.registerTool(
    "oracle_task_board",
    {
      title: "Show ASCII Work Board",
      description: "Render an ASCII board of registered agents (with roles and activity) plus the main TODOs created by a lead. Filter by createdBy to see one lead's work board; activeOnly hides completed and cancelled TODOs.",
      inputSchema: {
        createdBy: z.string().min(1).optional().describe("Optional lead/creator name, e.g. claude-lead"),
        activeOnly: z.boolean().default(true)
      }
    },
    async ({ createdBy, activeOnly }) => {
      try {
        const [agents, list] = await Promise.all([
          registry.list(),
          tasks.list({ createdBy, activeOnly })
        ]);
        const board = formatTaskBoard(agents, list);
        return success(board, {
          createdBy: createdBy ?? null,
          activeOnly,
          agents: agents as unknown as Record<string, unknown>[],
          tasks: list as unknown as Record<string, unknown>[]
        });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_task_create",
    {
      title: "Create and Assign Task",
      description:
        "Break off a unit of work and assign it to an agent. Optionally attach a verification checklist — the assignee must check off every item before they can submit the task for review. Also sends the assignee a message so they see it in their inbox.",
      inputSchema: {
        title: z.string().min(1).max(200),
        description: z.string().max(5000).optional(),
        createdBy: z.string().min(1).describe("Your agent name (the one who will review/close this task)"),
        assignee: z.string().min(1).describe("Agent responsible for doing the work"),
        checklist: z.array(z.string().min(1)).max(50).optional().describe("Verification steps required before submit"),
        parentId: z.string().optional().describe("Parent task id, for breaking a larger plan into subtasks")
      }
    },
    async ({ title, description, createdBy, assignee, checklist, parentId }) => {
      try {
        const task = await tasks.create({ title, description, createdBy, assignee, checklist, parentId });
        await messages.send({
          from: createdBy,
          to: assignee,
          subject: `Task assigned: ${title}`,
          body: `New task ${task.id}: ${title}${description ? `\n${description}` : ""}${
            checklist?.length ? `\nChecklist:\n- ${checklist.join("\n- ")}` : ""
          }\nUse oracle_task_update to track progress, oracle_task_submit when done.`
        });
        return success(`Created ${task.id}, assigned to ${assignee}.`, { task: task as unknown as Record<string, unknown> });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_task_list",
    {
      title: "List Tasks",
      description: "List tasks, optionally filtered by assignee, creator, or status. activeOnly excludes done/cancelled.",
      inputSchema: {
        assignee: z.string().optional(),
        createdBy: z.string().optional(),
        status: STATUS_ENUM.optional(),
        activeOnly: z.boolean().default(false)
      }
    },
    async ({ assignee, createdBy, status, activeOnly }) => {
      try {
        const list = await tasks.list({ assignee, createdBy, status, activeOnly });
        return success(
          list.length ? list.map(formatTask).join("\n") : "No tasks found.",
          { count: list.length, tasks: list as unknown as Record<string, unknown>[] }
        );
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_task_get",
    {
      title: "Get Task Detail",
      description: "Full detail for one task: description, checklist, and the complete progress-note history.",
      inputSchema: { id: z.string().min(1) }
    },
    async ({ id }) => {
      try {
        const task = await tasks.get(id);
        if (!task) return success(`Not found: ${id}`, { found: false });
        const notes = task.notes.map((n) => `  [${n.ts}] ${n.agent}: ${n.text}`).join("\n");
        return success(`${formatTask(task)}${notes ? `\nNotes:\n${notes}` : ""}`, {
          found: true,
          task: task as unknown as Record<string, unknown>
        });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_task_update",
    {
      title: "Update Task Progress",
      description:
        "Record progress on a task: add a note and/or change its status (pending/in_progress/review/done/blocked/cancelled). Use this liberally while working, not just at the end — it's the audit trail of what happened.",
      inputSchema: {
        id: z.string().min(1),
        agent: z.string().min(1).describe("Your agent name"),
        note: z.string().max(2000).optional(),
        status: STATUS_ENUM.optional()
      }
    },
    async ({ id, agent, note, status }) => {
      try {
        const task = await tasks.update(id, agent, { note, status });
        if (!task) return failure(new Error(`Task not found: ${id}`));
        return success(`Updated ${id}.`, { task: task as unknown as Record<string, unknown> });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_task_checklist",
    {
      title: "Check Off a Verification Item",
      description: "Mark one checklist item done or not-done, by its 0-based index (see oracle_task_get for indices).",
      inputSchema: {
        id: z.string().min(1),
        index: z.number().int().min(0),
        done: z.boolean().default(true)
      }
    },
    async ({ id, index, done }) => {
      try {
        const task = await tasks.setChecklistItem(id, index, done);
        if (!task) return failure(new Error(`Task or checklist index not found: ${id}[${index}]`));
        return success(`${done ? "Checked" : "Unchecked"} item ${index}.`, { task: task as unknown as Record<string, unknown> });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_task_submit",
    {
      title: "Submit Task for Review",
      description:
        "Submit a task for review — the verification gate before reporting done. FAILS if any checklist item is still unchecked (check them via oracle_task_checklist first). On success, automatically messages the task creator with your summary so they know to review it — no need to separately notify them.",
      inputSchema: {
        id: z.string().min(1),
        agent: z.string().min(1).describe("Your agent name"),
        summary: z.string().min(1).max(2000).describe("What you did, for the reviewer")
      }
    },
    async ({ id, agent, summary }) => {
      try {
        const task = await tasks.submitForReview(id, agent, summary);
        await messages.send({
          from: agent,
          to: task.createdBy,
          subject: `Task ready for review: ${task.title}`,
          body: `Task ${task.id} submitted by ${agent}.\n${summary}\nUse oracle_task_get to see the checklist and notes, then oracle_task_close to approve or send back.`
        });
        return success(`Submitted ${id} for review; ${task.createdBy} notified.`, { task: task as unknown as Record<string, unknown> });
      } catch (error) { return failure(error); }
    }
  );

  server.registerTool(
    "oracle_task_close",
    {
      title: "Close (Approve or Reject) a Task",
      description:
        "Reviewer's decision on a submitted task. approved=true marks it done. approved=false sends it back to in_progress with your note explaining what's missing — the assignee should address it and submit again.",
      inputSchema: {
        id: z.string().min(1),
        agent: z.string().min(1).describe("Your agent name (the reviewer)"),
        approved: z.boolean(),
        note: z.string().max(2000).optional()
      }
    },
    async ({ id, agent, approved, note }) => {
      try {
        const task = await tasks.close(id, agent, approved, note);
        await messages.send({
          from: agent,
          to: task.assignee,
          subject: approved ? `Task approved: ${task.title}` : `Task sent back: ${task.title}`,
          body: approved
            ? `Task ${task.id} approved and closed.${note ? ` ${note}` : ""}`
            : `Task ${task.id} needs more work: ${note ?? "see notes"}`
        });
        return success(approved ? `Closed ${id} as done.` : `Sent ${id} back to in_progress.`, {
          task: task as unknown as Record<string, unknown>
        });
      } catch (error) { return failure(error); }
    }
  );
}
