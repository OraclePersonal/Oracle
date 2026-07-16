#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { ConsultService } from "./core/consult.js";
import {
  checkProvider,
  createProvider,
  parseProviderName
} from "./providers/factory.js";
import { FileSessionStore } from "./session/store.js";
import {
  ensureProjectConfig,
  generateMcpSetup,
  writeMcpSetup,
  type McpClient
} from "./setup/mcp.js";
import { AnthropicOAuthClient } from "./auth/anthropic-oauth.js";
import { TokenStore } from "./auth/store.js";
import { SkillRegistry } from "./skills/registry.js";
import { OracleRegistry } from "./oracles/registry.js";
import { MemoryAdapter } from "./memory/adapter.js";
import { MessagesAdapter } from "./peer/mesh.js";
import { DEFAULT_SYSTEM_PROMPT } from "./context/bundle.js";
import * as peer from "./peer/peer.js";
import { ProfileStore } from "./identity/profile.js";

const homeDir = (): string =>
  process.env.ORACLE_HOME_DIR ?? path.join(os.homedir(), ".oracle");

const program = new Command()
  .name("oracle")
  .description("Oracle — MCP-powered AI coding consultant")
  .version("0.4.0");

// ── consult ──────────────────────────────────────────────────────
program
  .command("consult")
  .description("Consult an oracle with a prompt and project context")
  .requiredOption("-p, --prompt <text>", "Consultation prompt")
  .option("--oracle <name>", "Oracle profile to use")
  .option("--skill <name>", "Skill to apply (default: review)")
  .option("-f, --file <pattern...>", "File paths or glob patterns", [])
  .option("--diff [target]", "Include git diff (against branch, default: HEAD~1)")
  .option("-m, --model <model>", "Model override")
  .option("--provider <provider>", "Provider override")
  .option("--cwd <path>", "Working directory", process.cwd())
  .option("--json", "Print JSON result")
  .action(async (options) => {
    const cwd = path.resolve(options.cwd);
    const skillReg = new SkillRegistry(homeDir(), cwd);
    await skillReg.load();
    const oracleReg = new OracleRegistry(homeDir(), cwd);

    let skillName = options.skill ?? "review";
    let model = options.model;
    let providerName = options.provider;

    // Load oracle profile if specified
    if (options.oracle) {
      const profile = await oracleReg.getOracle(options.oracle);
      if (!profile) throw new Error(`Oracle not found: ${options.oracle}`);
      skillName = profile.skill;
      model = model ?? profile.model;
      providerName = providerName ?? profile.provider;
      if (profile.systemPrompt) {
        // prepend custom system prompt
      }
    }

    const skill = skillReg.get(skillName);
    if (!skill) throw new Error(`Unknown skill: ${skillName}. Available: ${skillReg.names().join(", ")}`);

    const finalProvider = providerName ?? "codex";
    const parsedProvider = parseProviderName(finalProvider);
    const checks = await checkProvider(parsedProvider);
    const failedCheck = checks.find((chk) => !chk.ok);
    if (failedCheck) throw new Error(`${failedCheck.name}: ${failedCheck.detail}`);

    const service = new ConsultService(createProvider(parsedProvider));
    const systemPrompt = skillReg.compose(skillName, DEFAULT_SYSTEM_PROMPT);
    const profile = new ProfileStore(homeDir());
    const personalCtx = await profile.buildPersonalContext();
    const personalizedPrompt = personalCtx ? `${personalCtx}\n\n${systemPrompt}` : systemPrompt;
    const memory = new MemoryAdapter(cwd);

    // Build memory context if oracle has memory enabled
    let finalSystemPrompt = personalizedPrompt;
    if (options.oracle) {
      const profile = await oracleReg.getOracle(options.oracle);
      if (profile?.memory) {
        const entries = await memory.recall(undefined, options.oracle);
        if (entries.length > 0) {
          const ctx = entries.map((e) => `[${e.type}] ${e.content.slice(0, 200)}`).join("\n\n");
          finalSystemPrompt = `${systemPrompt}\n\n[PREVIOUS CONTEXT]\n${ctx}`;
        }
      }
    }

    // Include git diff if --diff is passed
    if (options.diff !== undefined) {
      const target = options.diff || "HEAD~1";
      try {
        const { execFileSync } = await import("node:child_process");
        const diff = execFileSync("git", ["diff", target], { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 });
        if (diff.trim()) {
          options.prompt = `${options.prompt}\n\n[GIT DIFF: ${target}]\n\`\`\`\n${diff.trim()}\n\`\`\``;
        }
      } catch (e: any) {
        console.error(`Warning: git diff failed: ${e.message}`);
      }
    }

    const result = await service.consult({
      prompt: options.prompt,
      preset: skillName,
      provider: finalProvider,
      files: options.file,
      model: model ?? skill.model ?? "gpt-5.4",
      cwd,
      systemPrompt: finalSystemPrompt
    });

    // Save memory if oracle has memory enabled
    if (options.oracle) {
      const profile = await oracleReg.getOracle(options.oracle);
      if (profile?.memory && result.status === "completed") {
        await memory.remember(options.oracle, "insight", result.output.slice(0, 500), {
          tags: [skillName, "consult"],
          meta: { sessionId: result.sessionId, prompt: options.prompt }
        });
      }
    }

    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Session: ${result.sessionId}`);
      console.log(`Status: ${result.status}`);
      const tokens = result.estimatedInputTokens
        ? `~${result.estimatedInputTokens.toLocaleString()} in`
        : "";
      if (result.usage?.totalTokens) {
        console.log(`Tokens: ${tokens} | ${result.usage.totalTokens.toLocaleString()} total`);
      } else if (result.estimatedInputTokens) {
        console.log(`Tokens: ${tokens}`);
      }
      if (result.error) console.error(`Error: ${result.error}`);
      if (result.output) console.log(`\n${result.output}`);
    }
    process.exitCode = result.status === "completed" ? 0 : 1;
  });

// ── oracle ───────────────────────────────────────────────────────
const oracleCmd = program.command("oracle").description("Manage oracle profiles");

oracleCmd
  .command("list")
  .description("List registered oracles")
  .action(async () => {
    const reg = new OracleRegistry(homeDir());
    const list = await reg.listOracles();
    if (!list.length) { console.log("No oracles registered."); return; }
    for (const o of list) {
      const mem = o.memory ? " +memory" : "";
      console.log(`${o.name.padEnd(20)} skill=${o.skill}${mem}`);
    }
  });

oracleCmd
  .command("register")
  .description("Register a new oracle profile")
  .requiredOption("-n, --name <name>", "Oracle name")
  .requiredOption("-s, --skill <skill>", "Assigned skill")
  .option("-d, --description <text>", "Description")
  .option("-m, --model <model>", "Default model")
  .option("-p, --provider <provider>", "Default provider")
  .option("--memory", "Enable memory", false)
  .action(async (options) => {
    const reg = new OracleRegistry(homeDir());
    await reg.registerOracle({
      name: options.name,
      skill: options.skill,
      description: options.description,
      model: options.model,
      provider: options.provider,
      memory: options.memory
    });
    console.log(`Registered oracle: ${options.name}`);
  });

oracleCmd
  .command("unregister")
  .description("Remove an oracle profile")
  .argument("<name>", "Oracle name")
  .action(async (name) => {
    const reg = new OracleRegistry(homeDir());
    await reg.unregisterOracle(name);
    console.log(`Unregistered oracle: ${name}`);
  });

oracleCmd
  .command("show")
  .description("Show oracle profile details")
  .argument("<name>", "Oracle name")
  .action(async (name) => {
    const reg = new OracleRegistry(homeDir());
    const profile = await reg.getOracle(name);
    if (!profile) throw new Error(`Oracle not found: ${name}`);
    console.log(JSON.stringify(profile, null, 2));
  });

// ── memory ───────────────────────────────────────────────────────
const memCmd = program.command("memory").description("Manage oracle memory");

memCmd
  .command("list")
  .description("Show memory entries for an agent")
  .argument("[agent]", "Agent name (default: all)")
  .option("-n, --limit <number>", "Entries", "10")
  .action(async (agent, options) => {
    const memory = new MemoryAdapter(process.cwd());
    const entries = await memory.recall(undefined, agent ?? undefined, Number(options.limit));
    if (!entries.length) { console.log("No memory entries."); return; }
    for (const e of entries) {
      console.log(`${e.ts.slice(0, 19)}  [${e.type.padEnd(8)}]  ${e.agent.padEnd(12)}  ${e.content.slice(0, 60)}`);
    }
  });

memCmd
  .command("clear")
  .description("Clear working memory for an agent (or all)")
  .argument("[agent]", "Agent name (omit for all)")
  .action(async (agent) => {
    const memory = new MemoryAdapter(process.cwd());
    const count = await memory.clearWorking(agent ?? undefined);
    console.log(`Cleared ${count} working memory entries.`);
  });

// ── peer ─────────────────────────────────────────────────────────
const peerCmd = program.command("peer").description("Share oracles and messages between instances");

peerCmd
  .command("export")
  .description("Export oracle(s) to a shareable file")
  .requiredOption("-o, --output <file>", "Output file path")
  .argument("<names...>", "Oracle name(s) to export")
  .action(async (names, options) => {
    const reg = new OracleRegistry(homeDir());
    const pkg = await peer.exportPeerPackage(reg, names);
    await fs.writeFile(options.output, JSON.stringify(pkg, null, 2), "utf8");
    console.log(`Exported ${names.length} oracle(s) to ${options.output}`);
  });

peerCmd
  .command("import")
  .description("Import oracle(s) from a peer file")
  .argument("<file>", "Peer package file path")
  .action(async (file) => {
    const reg = new OracleRegistry(homeDir());
    const imported = await peer.importPeerPackage(reg, file);
    console.log(`Imported: ${imported.join(", ")}`);
  });

peerCmd
  .command("send")
  .description("Send a message via Oracle-messages mesh")
  .requiredOption("--to <agent>", "Recipient agent name (or * for broadcast)")
  .requiredOption("-b, --body <text>", "Message body")
  .option("--from <agent>", "Sender name", "oracle")
  .option("--kind <kind>", "Message kind", "message")
  .option("--subject <subject>", "Message subject")
  .action(async (options) => {
    const mesh = new MessagesAdapter(process.cwd());
    const msg = await mesh.send(options.from, options.to, options.body, options.kind as any, {
      subject: options.subject
    });
    console.log(`Sent: ${msg.id}`);
  });

peerCmd
  .command("list")
  .description("List messages from Oracle-messages mesh")
  .option("--agent <agent>", "Filter by recipient")
  .option("--kind <kind>", "Filter by kind")
  .option("-n, --limit <number>", "Messages", "20")
  .action(async (options) => {
    const mesh = new MessagesAdapter(process.cwd());
    const msgs = await mesh.getMessages({
      agent: options.agent,
      kind: options.kind as any,
      limit: Number(options.limit)
    });
    for (const m of msgs) {
      console.log(`${m.id.slice(0, 22)}  ${m.sender.padEnd(12)} → ${m.recipient.padEnd(12)}  ${(m.subject ?? m.body).slice(0, 50)}`);
    }
  });

peerCmd
  .command("monitor")
  .description("Follow incoming messages live (poll-based)")
  .option("--agent <agent>", "Your agent name", "oracle")
  .option("--since <id>", "Start from message id")
  .option("-i, --interval <ms>", "Poll interval (ms)", "5000")
  .action(async (options) => {
    const mesh = new MessagesAdapter(process.cwd());
    let cursor = options.since;
    console.log(`Monitoring messages for ${options.agent}...`);
    for (;;) {
      const msgs = await mesh.getUnread(options.agent, cursor);
      for (const m of msgs) {
        console.log(`[${m.kind}] ${m.sender}: ${(m.subject ?? m.body).slice(0, 80)}`);
        cursor = m.id;
      }
      await new Promise((r) => setTimeout(r, Number(options.interval)));
    }
  });

// ── existing commands ────────────────────────────────────────────
program
  .command("doctor")
  .option("--provider <provider>", "Provider: codex, openai, or anthropic", "codex")
  .action(async (options) => {
    const checks = await checkProvider(parseProviderName(options.provider));
    for (const check of checks) {
      console.log(`${check.ok ? "OK" : "FAIL"}  ${check.name}: ${check.detail}`);
    }
    process.exitCode = checks.every((check) => check.ok) ? 0 : 1;
  });

program
  .command("setup-mcp")
  .option("--client <client>", "Client: claude-code or codex", "claude-code")
  .option("--cwd <path>", "Project root", process.cwd())
  .option("--print", "Print generated configuration without writing")
  .option("--force", "Replace an existing configuration")
  .action(async (options) => {
    if (options.client !== "claude-code" && options.client !== "codex") {
      throw new Error("Expected --client claude-code or codex.");
    }
    const serverPath = fileURLToPath(new URL("./mcp.js", import.meta.url));
    const file = generateMcpSetup({
      root: path.resolve(options.cwd),
      client: options.client as McpClient,
      serverPath
    });
    if (options.print) {
      console.log(file.content.trimEnd());
      return;
    }
    const projectConfigPath = await ensureProjectConfig(path.resolve(options.cwd));
    await writeMcpSetup(file, options.force);
    console.log(`Created ${projectConfigPath}`);
    console.log(`Created ${file.path}`);
  });

program
  .command("session")
  .argument("<id>", "Session id")
  .action(async (id) => {
    const record = await new FileSessionStore().read(id);
    if (!record) {
      console.error(`Session not found: ${id}`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(record, null, 2));
  });

program
  .command("status")
  .option("-n, --limit <number>", "Number of sessions", "20")
  .action(async (options) => {
    const records = await new FileSessionStore().list(Number(options.limit));
    for (const item of records) {
      console.log(
        `${item.createdAt}  ${item.status.padEnd(9)}  ${item.model.padEnd(16)}  ${item.sessionId}`
      );
    }
  });

program
  .command("login")
  .description("Authenticate with an OAuth provider")
  .option("--provider <provider>", "Provider", "anthropic")
  .option("--client-id <id>", "OAuth client ID")
  .option("--force", "Re-authenticate")
  .action(async (options) => {
    const store = new TokenStore(homeDir());
    const existing = await store.read(options.provider);
    if (existing && !options.force) {
      console.log(`Already logged in to ${options.provider}. Use --force to re-authenticate.`);
      return;
    }
    if (options.provider !== "anthropic") throw new Error(`Login not supported for provider: ${options.provider}`);
    const clientId = options.clientId ?? process.env.ANTHROPIC_CLIENT_ID;
    if (!clientId) throw new Error("ANTHROPIC_CLIENT_ID is required.");
    const oauth = new AnthropicOAuthClient(clientId, store);
    const session = await oauth.startDeviceFlow();
    console.log(`\nOpen: ${session.verificationUri}\nCode: ${session.userCode}\n`);
    console.log("Waiting for authorization...");
    await oauth.pollForToken(session.deviceCode, session.interval);
    console.log("Authenticated.");
  });

program
  .command("logout")
  .description("Clear OAuth session")
  .option("--provider <provider>", "Provider", "anthropic")
  .action(async (options) => {
    await new TokenStore(homeDir()).delete(options.provider);
    console.log(`Logged out of ${options.provider}.`);
  });

program
  .command("skill")
  .description("Manage skills")
  .argument("[action]", "list, install", "list")
  .argument("[arg]", "Skill name or file path")
  .action(async (action, arg) => {
    const reg = new SkillRegistry(homeDir());
    await reg.load();
    if (action === "list") {
      for (const skill of reg.list()) {
        console.log(`${skill.name.padEnd(20)} ${skill.description}`);
      }
    } else if (action === "install") {
      if (!arg) throw new Error("Usage: oracle skill install <file.json>");
      const name = await reg.install(arg);
      console.log(`Installed skill: ${name}`);
    } else {
      throw new Error(`Unknown action: ${action}. Use list or install.`);
    }
  });

// ── identity ────────────────────────────────────────────────────
const identityCmd = program.command("identity").description("Manage your personal identity");

identityCmd
  .command("show")
  .description("Show identity profile")
  .action(async () => {
    const store = new ProfileStore(homeDir());
    const identity = await store.getIdentity();
    const persona = await store.getPersona();
    console.log("Persona:", JSON.stringify(persona, null, 2));
    console.log("Identity:", JSON.stringify(identity ?? "not set", null, 2));
  });

identityCmd
  .command("setup")
  .description("Set up your identity profile")
  .requiredOption("-n, --name <name>", "Your name")
  .option("--title <title>", "Your title")
  .option("--role <role>", "Your role")
  .option("-d, --description <text>", "About you")
  .option("--prefs <items>", "Preferences (comma-separated)")
  .option("--habits <items>", "Habits (comma-separated)")
  .option("--goals <items>", "Goals (comma-separated)")
  .action(async (options) => {
    const store = new ProfileStore(homeDir());
    await store.saveIdentity({
      name: options.name,
      title: options.title,
      role: options.role,
      description: options.description,
      preferences: options.prefs?.split(",").map((s: string) => s.trim()),
      habits: options.habits?.split(",").map((s: string) => s.trim()),
      goals: options.goals?.split(",").map((s: string) => s.trim())
    });
    console.log(`Identity saved for ${options.name}. Every consult now knows who you are.`);
  });

identityCmd
  .command("persona")
  .description("Set Oracle's voice/personality")
  .option("--name <name>", "Oracle's name", "Oracle")
  .option("--tone <tone>", "professional | casual | friendly | witty", "professional")
  .option("--style <text>", "Custom style description")
  .option("--greeting <text>", "Greeting message")
  .action(async (options) => {
    const store = new ProfileStore(homeDir());
    await store.savePersona({
      name: options.name,
      tone: options.tone,
      style: options.style,
      greeting: options.greeting
    });
    console.log(`Persona saved: ${options.name}`);
  });

identityCmd
  .command("forget")
  .description("Clear your identity profile")
  .action(async () => {
    const store = new ProfileStore(homeDir());
    await store.saveIdentity({ name: "" });
    console.log("Identity cleared.");
  });

await program.parseAsync(process.argv);
