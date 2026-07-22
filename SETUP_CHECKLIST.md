# Oracle MCP Setup Checklist

Use this checklist to verify Oracle is properly configured for Claude Code.

---

## ✅ Prerequisites

- [ ] Node.js ≥ 24 installed (`node --version`)
- [ ] Claude Code installed and running
- [ ] This project cloned: `Oracle-Ecosystems`
- [ ] API provider configured (Codex, Anthropic, or OpenAI)

---

## ✅ Installation

- [ ] Run `npm install` in project root
- [ ] Run `npm run build` to compile TypeScript
- [ ] Verify build: `ls dist/cli.js dist/mcp.js`
- [ ] Test CLI: `node dist/cli.js doctor` (shows provider status)

---

## ✅ MCP Configuration

- [ ] Run `node dist/cli.js setup-mcp --client claude-code`
- [ ] Verify `.mcp.json` created in project root
- [ ] Verify `.oracle/config.json` created (project-level config)
- [ ] Check `.mcp.json` contains:
  ```json
  {
    "mcpServers": {
      "oracle": {
        "command": "node",
        "args": ["<path>/dist/mcp.js"],
        "env": { "ORACLE_WORKSPACE_ROOT": "<path>" }
      }
    }
  }
  ```

---

## ✅ Claude Code Integration

- [ ] Close Claude Code completely (all windows)
- [ ] Reopen Claude Code
- [ ] In Claude Code terminal, verify MCP loaded:
  - Look for `oracle` in the tool list
  - Try typing `oracle_` to see autocomplete
- [ ] Test a tool: Try calling `oracle_doctor`
  - Should show provider status

---

## ✅ Multi-Agent Setup

Create identity files for agents:

```bash
# In project directory:
node dist/cli.js identity setup -n "agent-1"
node dist/cli.js identity setup -n "agent-2"
node dist/cli.js identity setup -n "agent-3"
```

- [ ] Agent identities created in `~/.oracle/agents/`
- [ ] Verify: `ls ~/.oracle/agents/`

---

## ✅ Test Each Component

### Memory System
```bash
node dist/cli.js memory list
```
- [ ] Shows existing memories (or empty if new)

### Messaging Bus
```bash
# Send message
node dist/cli.js msg send -f "agent-1" -t "agent-2" -b "test"

# Receive message
node dist/cli.js msg inbox -a "agent-2"
```
- [ ] Message appears in inbox
- [ ] Message has from/to/body fields

### Task Tracker
```bash
node dist/cli.js task create \
  --title "Test Task" \
  --created-by "test" \
  --assignee "agent-1" \
  --checklist "Item 1" "Item 2"

node dist/cli.js task list
```
- [ ] Task created with ID
- [ ] Task shows in list with `pending` status
- [ ] All checklist items present

---

## ✅ Run Example Workflow

### Terminal 1: Lead (Planning)
```bash
cd <project-path>
node examples/workflow-dashboard.mjs lead
```
- [ ] Task IDs printed for frontend/backend/reviewer

### Terminal 2: Frontend
```bash
cd <project-path>
node examples/workflow-dashboard.mjs frontend
```
- [ ] Status messages show progress
- [ ] Ends with "Submitted to lead!"

### Terminal 3: Backend
```bash
cd <project-path>
node examples/workflow-dashboard.mjs backend
```
- [ ] Status messages show progress
- [ ] Ends with "Submitted to lead!"

### Terminal 4: Reviewer
```bash
cd <project-path>
node examples/workflow-dashboard.mjs reviewer
```
- [ ] Status messages show progress
- [ ] Ends with "Submitted to lead!"

### Back to Terminal 1: Lead Reviews
- [ ] Lead sees all 3 submissions
- [ ] Tasks transition to `done`
- [ ] All agents notified

---

## ✅ MCP Tools Accessible

In Claude Code, verify these tools are available:

### Consultation
- [ ] `oracle_ask` — Ask questions with context

### Memory (should see these when typing `oracle_memory_`)
- [ ] `oracle_memory_remember`
- [ ] `oracle_memory_search`
- [ ] `oracle_memory_list`
- [ ] `oracle_memory_consolidate`
- [ ] (and others...)

### Messaging (should see these when typing `oracle_msg_`)
- [ ] `oracle_msg_register`
- [ ] `oracle_msg_send`
- [ ] `oracle_msg_inbox`
- [ ] `oracle_msg_ack`
- [ ] (and others...)

### Tasks (should see these when typing `oracle_task_`)
- [ ] `oracle_task_create`
- [ ] `oracle_task_list`
- [ ] `oracle_task_update`
- [ ] `oracle_task_checklist`
- [ ] `oracle_task_submit`
- [ ] `oracle_task_close`
- [ ] (and others...)

---

## ✅ Storage Verified

Check that data is persisted:

```bash
# Check messages
ls ~/.oracle/messages/ | wc -l
```
- [ ] Messages stored as JSON files

```bash
# Check tasks
ls ~/.oracle/tasks/ | wc -l
```
- [ ] Tasks stored as JSON files

```bash
# Check agents registry
ls ~/.oracle/agents/
```
- [ ] Agent presence files exist

```bash
# Check memory
ls ~/.oracle/memory/
```
- [ ] Memory directory exists (facts stored here)

---

## ✅ Multi-Claude-Code Workflow Ready

You can now:

- [ ] Open **Claude Code Instance A** (Lead)
  - Call `oracle_task_create` to assign work
  
- [ ] Open **Claude Code Instance B** (Worker 1)
  - Call `oracle_msg_register` to identify itself
  - Call `oracle_msg_inbox` to see assigned work
  
- [ ] Open **Claude Code Instance C** (Worker 2)
  - Same pattern as Instance B

Instances can now:
- [ ] Send messages to each other (`oracle_msg_send`)
- [ ] Share memory (`oracle_memory_*`)
- [ ] Track coordinated work (`oracle_task_*`)

---

## Troubleshooting

### "oracle_* tools not appearing in Claude Code"

1. Did you run `setup-mcp --client claude-code`?
2. Did you restart Claude Code **completely**?
3. Check `.mcp.json` exists and is valid JSON
4. Try: `cat .mcp.json` (should show MCP server config)
5. If still not working: 
   - Close Claude Code
   - Delete `.mcp.json` and `.oracle/`
   - Run setup again from scratch

### "oracle doctor shows no provider"

Set your API key:
```bash
export ANTHROPIC_API_KEY=sk-...
# or
export OPENAI_API_KEY=sk-...
```

Then run: `node dist/cli.js doctor`

### "Messages not showing up"

1. Are agents registered? `node dist/cli.js msg agents`
2. Check message file: `cat ~/.oracle/messages/<id>`
3. Verify agent name matches: `node dist/cli.js msg inbox -a "<agent-name>"`

### "Task stuck on verification"

Tasks **cannot be submitted** while items are unchecked.

```bash
# Check current status
node dist/cli.js task get <task-id>

# Mark items as done one by one
node dist/cli.js task check <task-id> 0
node dist/cli.js task check <task-id> 1
node dist/cli.js task check <task-id> 2

# Then submit
node dist/cli.js task submit <task-id> -a <agent> --summary "Done"
```

---

## Success Criteria

You're done when:

1. ✅ `.mcp.json` in project root
2. ✅ `oracle_*` tools visible in Claude Code
3. ✅ Example workflow runs to completion (all 4 terminals)
4. ✅ Multiple Claude Code instances can message each other
5. ✅ Tasks tracked and verified before "done"

---

## Next: Real Workflows

See `ORACLE_QUICKSTART.md` for:
- How to use `oracle_ask` for consultation
- How to build your own multi-agent workflows
- How to persist knowledge across sessions
