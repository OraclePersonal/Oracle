#!/usr/bin/env node
/**
 * Oracle Ecosystem — Live Demo
 * Tests all components end-to-end via MCP stdio protocol.
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, ".");
const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

let passed = 0, failed = 0;

function ok(name) { console.log(`  ${PASS} ${name}`); passed++; }
function ng(name, err) { console.log(`  ${FAIL} ${name}: ${err}`); failed++; }

// ─── MCP stdio client helper ────────────────────────────────
function mcpCall(process, tool, args) {
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    const req = JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } });
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      for (const line of lines) {
        try {
          const resp = JSON.parse(line);
          if (resp.id === id) {
            cleanup();
            if (resp.error) reject(new Error(resp.error.message));
            else {
              const r = resp.result;
              // MCP SDK wraps response in structuredContent; oracle-memory puts success inside text JSON
              resolve(r?.structuredContent ?? (r?.content?.[0]?.text ? JSON.parse(r.content[0].text) : r));
            }
          }
        } catch { /* incomplete */ }
      }
      buf = lines[lines.length - 1] || "";
    };
    const onError = (e) => { cleanup(); reject(e); };
    const cleanup = () => {
      process.stdout.removeListener("data", onData);
      process.removeListener("error", onError);
    };
    process.stdout.on("data", onData);
    process.on("error", onError);
    process.stdin.write(req + "\n");
    setTimeout(() => { cleanup(); reject(new Error("timeout")); }, 8000);
  });
}

// ─── Also send initialize first ──────────────────────────────
function mcpInit(process) {
  return new Promise((resolve, reject) => {
    const req = JSON.stringify({ jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "demo", version: "1.0" } } });
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString();
      try {
        const resp = JSON.parse(buf);
        if (resp.id === "init") {
          process.stdout.removeListener("data", onData);
          if (resp.error) reject(new Error(resp.error.message));
          else resolve(resp.result);
        }
      } catch { /* wait for more data */ }
    };
    const timeout = setTimeout(() => { process.stdout.removeListener("data", onData); reject(new Error("init timeout")); }, 5000);
    process.stdout.on("data", (chunk) => { clearTimeout(timeout); onData(chunk); });
    process.stdin.write(req + "\n");
  });
}

console.log(`\n${BOLD}═══ Oracle Ecosystem — Live Demo ═══${RESET}\n`);

// ─── 1. oracle-messages ─────────────────────────────────────
console.log(`${BOLD}1. oracle-messages (MCP Message Bus)${RESET}`);
let msgProc;
try {
  msgProc = spawn("node", [resolve(ROOT, "Oracle-messages", "dist/index.js")], {
    cwd: resolve(ROOT, "Oracle-messages"),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ORACLE_MESSAGES_DIR: ".oracle-messages-demo" },
  });
  msgProc.stderr.on("data", () => {});

  await mcpInit(msgProc);

  // onboard agent
  const onboard = await mcpCall(msgProc, "onboard", { agent: "agent-alpha", client: "Demo", role: "builder", capabilities: ["code", "review"] });
  if (onboard.success) ok("onboard agent-alpha");
  else ng("onboard", onboard.error);

  // onboard second agent
  await mcpCall(msgProc, "onboard", { agent: "agent-beta", client: "Demo", role: "reviewer", capabilities: ["review", "test"] });
  ok("onboard agent-beta");

  // send message
  const sent = await mcpCall(msgProc, "send_message", {
    sender: "agent-alpha", recipient: "agent-beta",
    body: "Can you review the PR?",
    kind: "review-request", subject: "PR #42 review",
  });
  if (sent.success && sent.message) ok("send_message alpha→beta");
  else ng("send_message", JSON.stringify(sent));

  // sync messages for beta
  const sync = await mcpCall(msgProc, "sync_messages", { agent: "agent-beta" });
  if (sync.success && sync.count > 0) ok(`sync_messages beta → ${sync.count} unread`);
  else ng("sync_messages", JSON.stringify(sync));

  // reply
  if (sync.messages?.[0]) {
    await mcpCall(msgProc, "reply_message", {
      message_id: sync.messages[0].id,
      sender: "agent-beta",
      body: "Sure, I'll review it now.",
    });
    ok("reply_message beta→alpha");
  }

  // list agents
  const agents = await mcpCall(msgProc, "list_agents", {});
  if (agents.success && agents.count >= 2) ok(`list_agents → ${agents.count} agents`);
  else ng("list_agents", JSON.stringify(agents));

  // mailbox stats
  const stats = await mcpCall(msgProc, "mailbox_stats", {});
  if (stats.success) ok(`mailbox_stats → ${stats.stats.total_messages} msgs`);
  else ng("mailbox_stats", JSON.stringify(stats));

  msgProc.kill();
} catch (e) {
  ng("oracle-messages", e.message);
  msgProc?.kill();
}

// ─── 2. oracle-memory ───────────────────────────────────────
console.log(`\n${BOLD}2. oracle-memory (Persistent Memory)${RESET}`);
let memProc;
try {
  memProc = spawn("node", [resolve(ROOT, "Oracle-memory", "dist/index.js")], {
    cwd: resolve(ROOT, "Oracle-memory"),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ORACLE_MEMORY_DISABLE_VECTORS: "1", ORACLE_MEMORY_ROOT_DIR: resolve(ROOT, ".oracle-memory-demo") },
  });
  memProc.stderr.on("data", () => {});

  await mcpInit(memProc);

  // remember
  const rem = await mcpCall(memProc, "remember", {
    agent: "agent-alpha", type: "fact",
    content: "Database port is 5432",
    tags: ["config", "database"],
  });
  if (rem.success) ok("remember fact: db port");
  else ng("remember", JSON.stringify(rem));

  // second fact
  await mcpCall(memProc, "remember", {
    agent: "agent-alpha", type: "insight",
    content: "Use connection pooling for better performance",
    tags: ["database", "performance"],
  });
  ok("remember insight: connection pooling");

  // recall
  const recall = await mcpCall(memProc, "recall", { query: "database" });
  if (recall.success && recall.results?.length > 0) ok(`recall 'database' → ${recall.results.length} results`);
  else ng("recall", JSON.stringify(recall));

  // stats
  const mStats = await mcpCall(memProc, "get_stats", {});
  if (mStats.success) ok(`get_stats → ${mStats.stats?.totalMemories ?? "?"} total`);
  else ng("get_stats", JSON.stringify(mStats));

  memProc.kill();
} catch (e) {
  ng("oracle-memory", e.message);
  memProc?.kill();
}

// ─── 3. oracle-templates CLI ─────────────────────────────────
console.log(`\n${BOLD}3. oracle-templates (Template System)${RESET}`);
try {
  const { execSync } = await import("node:child_process");
  const tDir = resolve(ROOT, "Oracle-templates");

  // list templates via CLI
  execSync(`node "${resolve(tDir, "dist/cli.js")}" list`, { cwd: tDir, encoding: "utf8", stdio: "pipe" });
  ok("templates list command");

  // read the built-in template
  const tmpl = resolve(tDir, "templates/built-in/skill-review.json");
  if (existsSync(tmpl)) {
    const content = JSON.parse(readFileSync(tmpl, "utf8"));
    ok(`built-in template: ${content.name ?? "skill-review"}`);
  } else {
    ng("built-in template", "file not found");
  }
} catch (e) {
  ng("oracle-templates", e.message);
}

// ─── 4. oracle-dashboard ─────────────────────────────────────
console.log(`\n${BOLD}4. oracle-dashboard (Web Dashboard)${RESET}`);
try {
  const resp = await fetch("http://127.0.0.1:3456/");
  if (resp.ok) {
    const html = await resp.text();
    if (html.includes("Oracle Dashboard") || html.includes("Oracle Ecosystem")) {
      ok("dashboard serving at http://localhost:3456");
    } else {
      ng("dashboard content", "missing expected text");
    }
  } else {
    ng("dashboard", `HTTP ${resp.status}`);
  }
} catch (e) {
  ng("oracle-dashboard", e.message);
}

// ─── 5. oracle-eval bench ────────────────────────────────────
console.log(`\n${BOLD}5. oracle-eval (Benchmark)${RESET}`);
try {
  const eDir = resolve(ROOT, "Oracle-eval");
  // verify source compiles
  const { execSync } = await import("node:child_process");
  execSync("npx tsc --noEmit", { cwd: eDir, encoding: "utf8", stdio: "pipe" });
  ok("eval type-check clean");
  // verify bench runner exists
  if (existsSync(resolve(eDir, "bench/run.ts"))) ok("bench/run.ts exists");
  // verify SVG report generation code (report.ts)
  if (existsSync(resolve(eDir, "src/report.ts"))) ok("src/report.ts (SVG generator)");
} catch (e) {
  ng("oracle-eval", e.message);
}

// ─── Summary ─────────────────────────────────────────────────
console.log(`\n${BOLD}═══ Results: ${passed} passed, ${failed} failed ═══${RESET}\n`);
process.exit(failed > 0 ? 1 : 0);
