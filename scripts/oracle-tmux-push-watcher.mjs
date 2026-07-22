#!/usr/bin/env node
/**
 * Oracle → tmux real-time push watcher.
 *
 * Watches the Oracle message store and, the moment an unread message lands for
 * a target agent, injects a nudge into that agent's tmux pane via
 * `tmux send-keys`. This is the only tier that wakes a *already-idle* Claude
 * session — the Stop hook only fires at end-of-turn, and `inbox --wait` needs
 * the agent to block on it deliberately. Here an external process does the push.
 *
 * Usage (run inside WSL, where tmux lives):
 *   node oracle-tmux-push-watcher.mjs --agent frontend --pane mywork:0.1
 *
 * Options:
 *   --agent <name>   agent whose inbox to watch (matches `to` or broadcast '*')
 *   --pane <target>  tmux target pane, e.g. "session:window.pane" (tmux -t syntax)
 *   --home <dir>     Oracle home dir (default: $ORACLE_HOME_DIR or ~/.oracle).
 *                    Point at /mnt/c/Users/<you>/.oracle to share the Windows bus.
 *   --interval <ms>  poll interval (default 1000). Polling, not inotify, so it
 *                    works across the /mnt/c 9p mount where inotify is unreliable.
 *   --dry-run        print the tmux command instead of running it
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

const agent = arg("agent");
const pane = arg("pane");
const dryRun = arg("dry-run", false) === true;
const home = arg("home", process.env.ORACLE_HOME_DIR ?? path.join(os.homedir(), ".oracle"));
const interval = Number(arg("interval", "1000"));

if (!agent || !pane) {
  console.error("Required: --agent <name> --pane <tmux-target>");
  process.exit(1);
}

const dir = path.join(home, "messages");
console.error(`[watcher] agent=${agent} pane=${pane} store=${dir} interval=${interval}ms${dryRun ? " (dry-run)" : ""}`);

// Seed "seen" with everything already present so we only react to NEW arrivals.
const seen = new Set();
let seededOk = false;
try {
  for (const f of await fs.readdir(dir)) if (f.endsWith(".json")) seen.add(f);
  seededOk = true;
} catch {
  console.error(`[watcher] store not readable yet at ${dir} — will retry`);
}

function tmuxSendKeys(text) {
  return new Promise((resolve) => {
    if (dryRun) {
      console.error(`[watcher] DRY: tmux send-keys -t ${pane} <text> Enter`);
      return resolve();
    }
    // Two calls: the literal text, then a separate Enter, so the text can't be
    // misparsed as a key name.
    execFile("tmux", ["send-keys", "-t", pane, "-l", text], (e1) => {
      if (e1) console.error(`[watcher] send-keys text failed: ${e1.message}`);
      execFile("tmux", ["send-keys", "-t", pane, "Enter"], (e2) => {
        if (e2) console.error(`[watcher] send-keys Enter failed: ${e2.message}`);
        resolve();
      });
    });
  });
}

async function tick() {
  let files;
  try {
    files = await fs.readdir(dir);
  } catch {
    return; // store not there yet
  }
  if (!seededOk) {
    for (const f of files) if (f.endsWith(".json")) seen.add(f);
    seededOk = true;
    return;
  }
  for (const name of files.filter((f) => f.endsWith(".json"))) {
    if (seen.has(name)) continue;
    seen.add(name);
    let m;
    try {
      m = JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
    } catch {
      continue; // partial write; next tick re-reads (it's already in `seen` though)
    }
    const forMe = (m.to === agent || m.to === "*") && m.from !== agent;
    const unread = !(m.readBy ?? []).includes(agent);
    if (!forMe || !unread) continue;

    const body = String(m.body ?? "").slice(0, 120);
    console.error(`[watcher] ⚡ push: from ${m.from} → ${agent}: ${body}`);
    await tmuxSendKeys(
      `[oracle] new message from ${m.from}: "${body}" — read it with oracle_msg_inbox (agent: "${agent}"), act, then oracle_msg_ack.`
    );
  }
}

// Poll loop. setInterval risks overlap on slow FS; use a self-scheduling loop.
async function loop() {
  await tick();
  setTimeout(loop, interval);
}
loop();
