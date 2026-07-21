#!/usr/bin/env node
/**
 * Claude Code Stop hook: turn Oracle's pull-based message bus into push-on-idle.
 *
 * When Claude finishes responding, this script checks ~/.oracle/messages/ for
 * unread messages addressed to this agent (or broadcasts). If any exist, it
 * blocks the stop with a reason telling Claude to read the inbox — so the
 * agent "wakes up" and handles messages exactly when it would otherwise idle.
 *
 * Register in .claude/settings.json:
 *   {
 *     "hooks": {
 *       "Stop": [{ "hooks": [{ "type": "command",
 *         "command": "node D:/path/to/Oracle/scripts/oracle-msg-stop-hook.mjs my-agent-name" }] }]
 *     }
 *   }
 *
 * Agent name comes from argv[2] or ORACLE_AGENT_NAME. No name → no-op, so the
 * hook is safe to install globally before deciding names per project.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const agent = process.argv[2] ?? process.env.ORACLE_AGENT_NAME;

let input = "";
for await (const chunk of process.stdin) input += chunk;
let hook = {};
try { hook = JSON.parse(input); } catch { /* tolerate missing/bad stdin */ }

// stop_hook_active means we already blocked this stop once and Claude tried to
// stop again — let it go, otherwise an ignored inbox would loop forever.
if (!agent || hook.stop_hook_active) process.exit(0);

const homeDir = process.env.ORACLE_HOME_DIR ?? path.join(os.homedir(), ".oracle");
const dir = path.join(homeDir, "messages");

let files = [];
try { files = await fs.readdir(dir); } catch { process.exit(0); }

const unread = [];
for (const name of files.filter((f) => f.endsWith(".json"))) {
  try {
    const m = JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
    const forMe = (m.to === agent || m.to === "*") && m.from !== agent;
    if (forMe && !(m.readBy ?? []).includes(agent)) unread.push(m);
  } catch { /* skip partial/corrupt files */ }
}

if (unread.length === 0) process.exit(0);

unread.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
const preview = unread
  .slice(-3)
  .map((m) => `- ${m.id} | from ${m.from}${m.subject ? ` | ${m.subject}` : ""}: ${String(m.body).slice(0, 100)}`)
  .join("\n");

console.log(JSON.stringify({
  decision: "block",
  reason:
    `You have ${unread.length} unread Oracle message(s) on the inter-agent bus:\n${preview}\n\n` +
    `Read them with the oracle_msg_inbox MCP tool (agent: "${agent}"), act on anything that needs you, ` +
    `reply via oracle_msg_send if appropriate, then mark them handled with oracle_msg_ack. ` +
    `If nothing needs action, just ack them and finish.`
}));
