#!/usr/bin/env node
import "dotenv/config";
import path from "node:path";
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

const program = new Command()
  .name("oracle")
  .description("Bundle a prompt and project files, then ask an expert model.")
  .version("0.1.0");

program
  .command("consult")
  .requiredOption("-p, --prompt <text>", "Consultation prompt")
  .option("-f, --file <pattern...>", "File paths or glob patterns", [])
  .option("-m, --model <model>", "Model", "gpt-5.4")
  .option("--provider <provider>", "Provider: codex or openai", "codex")
  .option("--cwd <path>", "Working directory", process.cwd())
  .option("--json", "Print JSON result")
  .action(async (options) => {
    const providerName = parseProviderName(options.provider);
    const checks = await checkProvider(providerName);
    const failedCheck = checks.find((check) => !check.ok);
    if (failedCheck) throw new Error(`${failedCheck.name}: ${failedCheck.detail}`);
    const service = new ConsultService(createProvider(providerName));
    const result = await service.consult({
      prompt: options.prompt,
      files: options.file,
      model: options.model,
      cwd: options.cwd
    });

    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Session: ${result.sessionId}`);
      console.log(`Status: ${result.status}`);
      if (result.error) console.error(`Error: ${result.error}`);
      if (result.output) console.log(`\n${result.output}`);
    }
    process.exitCode = result.status === "completed" ? 0 : 1;
  });

program
  .command("doctor")
  .option("--provider <provider>", "Provider: codex or openai", "codex")
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

await program.parseAsync(process.argv);
