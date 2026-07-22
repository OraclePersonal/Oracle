# Using Oracle MCP with Claude Code

This guide shows you how to use Oracle's MCP tools within Claude Code to build multi-agent workflows.

---

## What You Can Do

| Goal | Tool | Example |
|------|------|---------|
| Ask questions with full project context | `oracle_ask` | "Why is the Dashboard slow?" |
| Save facts that persist across sessions | `oracle_memory_remember` | "Redis pool = 50 connections" |
| Search for past learnings | `oracle_memory_search` | "Connection pool size?" |
| Coordinate with other Claude Code sessions | `oracle_msg_register`, `oracle_msg_send` | Send tasks to other workers |
| Track structured work with verification | `oracle_task_create`, `oracle_task_submit` | Create task → checklist → submit |
| See who's working on what | `oracle_msg_agents` | "Is backend-worker online?" |

---

## Quick Examples in Claude Code

### Example 1: Ask a Question

```json
Tool: oracle_ask
Input: {
  "question": "Summarize the architecture of this project",
  "files": ["README.md", "docs/architecture.md", "src/mcp/server.ts"],
  "conversationId": "arch-discussion-1"
}
```

**Returns:** Comprehensive answer citing the files you specified.

---

### Example 2: Remember a Fact

```json
Tool: oracle_memory_remember
Input: {
  "content": "Dashboard component is in src/ui/Dashboard.tsx and uses React hooks for state management",
  "tags": ["frontend", "component", "dashboard", "react"],
  "importance": "high"
}
```

**Result:** Fact saved to `~/.oracle/memory/`. Future `oracle_ask` calls will include this when relevant.

---

### Example 3: Register and Check Who's Online

```json
Tool: oracle_msg_register
Input: {
  "name": "claude-code-session-1",
  "role": "backend developer"
}
```

Then:

```json
Tool: oracle_msg_agents
Input: {}
```

**Returns:**
```json
{
  "agents": [
    { "name": "claude-code-session-1", "role": "backend developer", "lastSeen": "2026-07-22T..." },
    { "name": "claude-code-session-2", "role": "frontend developer", "lastSeen": "2026-07-22T..." }
  ]
}
```

---

### Example 4: Send a Message to Another Agent

```json
Tool: oracle_msg_send
Input: {
  "to": "claude-code-session-2",
  "body": "I finished the auth API. Ready for integration testing?"
}
```

Then in another Claude Code session, they can check their inbox:

```json
Tool: oracle_msg_inbox
Input: {
  "agent": "claude-code-session-2"
}
```

---

### Example 5: Create and Track a Task

**Session A (Lead):** Create task
```json
Tool: oracle_task_create
Input: {
  "title": "Build payment processing API",
  "createdBy": "lead",
  "assignee": "backend-worker",
  "checklist": ["Design API schema", "Implement endpoints", "Add unit tests", "Write API docs"]
}
```

Returns task ID: `20260722043009509-43ffa82d`

---

**Session B (Backend Worker):** Start work

```json
Tool: oracle_task_update
Input: {
  "id": "20260722043009509-43ffa82d",
  "agent": "backend-worker",
  "status": "in_progress",
  "note": "Started with API schema design"
}
```

Check off items as you complete them:

```json
Tool: oracle_task_checklist
Input: {
  "id": "20260722043009509-43ffa82d",
  "agent": "backend-worker",
  "index": 0,
  "checked": true
}
```

Continue until all checked... then submit:

```json
Tool: oracle_task_submit
Input: {
  "id": "20260722043009509-43ffa82d",
  "agent": "backend-worker",
  "summary": "API complete with tests and docs. Ready for review."
}
```

⚠️ **Important:** If any checklist item is unchecked, submit **fails**. This ensures work is truly verified before the lead is notified.

---

**Session A (Lead):** Review and approve

```json
Tool: oracle_task_close
Input: {
  "id": "20260722043009509-43ffa82d",
  "agent": "lead"
}
```

Task status changes to `done`. Backend worker is notified automatically.

---

## Real Workflow: Multi-Agent Feature Development

### Scenario

You have 3 Claude Code sessions:
- **Session A (Lead):** Plans work
- **Session B (Frontend):** Builds React component
- **Session C (Backend):** Builds API

### Step 1: Lead Plans Work

In Session A:

```json
Tool: oracle_msg_register
Input: {
  "name": "lead",
  "role": "Project Lead"
}
```

Create 2 tasks:

```json
Tool: oracle_task_create
Input: {
  "title": "Build Dashboard Component",
  "createdBy": "lead",
  "assignee": "frontend-worker",
  "checklist": ["Component structure", "Unit tests", "Storybook stories"]
}
```

```json
Tool: oracle_task_create
Input: {
  "title": "Build Dashboard API",
  "createdBy": "lead",
  "assignee": "backend-worker",
  "checklist": ["API schema", "Endpoints", "Database query"]
}
```

Broadcast a message:

```json
Tool: oracle_msg_send
Input: {
  "to": "*",
  "body": "Dashboard feature tasks assigned! Check your inbox and task list."
}
```

---

### Step 2: Frontend and Backend Work (Parallel)

**Session B (Frontend):**

```json
Tool: oracle_msg_register
Input: {
  "name": "frontend-worker",
  "role": "Frontend Developer"
}
```

Check messages:

```json
Tool: oracle_msg_inbox
Input: {
  "agent": "frontend-worker"
}
```

See the task assignment. List tasks:

```json
Tool: oracle_task_list
Input: {
  "assignee": "frontend-worker"
}
```

Get task details:

```json
Tool: oracle_task_get
Input: {
  "id": "<task-id-from-list>"
}
```

Update status:

```json
Tool: oracle_task_update
Input: {
  "id": "<task-id>",
  "agent": "frontend-worker",
  "status": "in_progress",
  "note": "Building component structure"
}
```

Check off items as you complete them (1, 2, 3...)

Send message to backend when you need the API:

```json
Tool: oracle_msg_send
Input: {
  "to": "backend-worker",
  "body": "Frontend component ready. Need /api/dashboard endpoint by tomorrow!"
}
```

When done, check off all items and submit:

```json
Tool: oracle_task_submit
Input: {
  "id": "<task-id>",
  "agent": "frontend-worker",
  "summary": "Dashboard component complete with tests and stories"
}
```

Lead is notified automatically.

---

**Session C (Backend):** Same pattern, different task

Check inbox for frontend's message:

```json
Tool: oracle_msg_inbox
Input: {
  "agent": "backend-worker"
}
```

Reply:

```json
Tool: oracle_msg_send
Input: {
  "to": "frontend-worker",
  "body": "API will be ready by EOD. Swagger docs included."
}
```

Build the API, check off all items, submit to lead.

---

### Step 3: Lead Reviews Everything

List all tasks:

```json
Tool: oracle_task_list
Input: {
  "status": "review"
}
```

Approve frontend work:

```json
Tool: oracle_task_close
Input: {
  "id": "<frontend-task-id>",
  "agent": "lead"
}
```

Approve backend work:

```json
Tool: oracle_task_close
Input: {
  "id": "<backend-task-id>",
  "agent": "lead"
}
```

Both workers are notified. Dashboard feature is complete!

---

## Best Practices

### 1. Always Register First

Before doing anything, register your session:

```json
Tool: oracle_msg_register
Input: {
  "name": "my-session-name",
  "role": "my-role"
}
```

### 2. Use Conversation IDs for Recall

When asking follow-up questions, use the same `conversationId`:

```json
Tool: oracle_ask
Input: {
  "question": "Is there more about this?",
  "conversationId": "my-discussion-1"
}
```

Oracle will recall prior answers in the same conversation.

### 3. Verify Before Reporting Done

Always check off **all** checklist items before calling `oracle_task_submit`. The submit **blocks** if anything is unchecked.

### 4. Tag Your Memory Carefully

When remembering facts, use specific tags so they're easy to find:

```json
Tool: oracle_memory_remember
Input: {
  "content": "The payment service has a 30-second timeout on POST /process-payment",
  "tags": ["payment", "api", "timeout", "sla"],
  "importance": "high"
}
```

### 5. Use Broadcasts Sparingly

Broadcast messages (`to: "*"`) are useful for urgent announcements, but for normal coordination, message specific agents.

---

## Troubleshooting

### "Tool not found: oracle_ask"

Did you:
1. Run `setup-mcp --client claude-code`?
2. Restart Claude Code?

If still not showing:
- Close Claude Code completely
- Delete `.mcp.json` from project root
- Run `setup-mcp --client claude-code` again
- Restart Claude Code

### "My message isn't reaching the other agent"

1. Did you use their exact agent name?
2. Are they registered? Call `oracle_msg_agents` to see who's online
3. Check they called `oracle_msg_inbox` for the same agent name

### "Task won't submit"

Call `oracle_task_get <id>` to see which items are unchecked. Check them off one by one:

```json
Tool: oracle_task_checklist
Input: {
  "id": "<task-id>",
  "agent": "your-agent-name",
  "index": 0,
  "checked": true
}
```

### "Memory search returning nothing"

1. Did you remember the fact? `oracle_memory_remember` first
2. Memory consolidation runs every 1 hour. If urgent, call `oracle_memory_consolidate`
3. Try a broader search query

---

## Advanced: Custom Workflows

See `examples/workflow-dashboard.mjs` for a complete example of:
- Lead creating tasks for multiple workers
- Workers coordinating via messages
- All workers submitting work in parallel
- Lead approving/rejecting

You can use this as a template for your own multi-agent workflows!

---

## Summary

Oracle + Claude Code enables:

✅ **Persistent memory** across sessions
✅ **Inter-agent messaging** for coordination
✅ **Structured task tracking** with verification gates
✅ **Consultation** with full project context
✅ **Audit trails** of who did what

All stored locally in `~/.oracle/` — no external services, no network, full control.

**Start with:** Pick one tool above, try it in Claude Code, and expand from there!
