/**
 * oracle-messages benchmark evaluator.
 *
 * Tests message bus throughput:
 *   - Send latency (time to send a message)
 *   - Poll latency (time to receive/poll a message)
 *   - Throughput (messages per second)
 *
 * Designed to work against a running oracle-messages MCP server via HTTP.
 */

import type { PhaseResult } from "../types.js";

export interface MessagesEvalOptions {
  endpoint: string;
  iterations: number;
  payloadSize: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function avg(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function generatePayload(size: number): string {
  const base = "msg_" + Date.now() + "_";
  if (base.length >= size) return base.slice(0, size);
  return base + "x".repeat(size - base.length);
}

// ── HTTP client helpers for MCP tool calls ────────────────────────────────

async function mcpCall(endpoint: string, tool: string, args: Record<string, unknown>): Promise<any> {
  const url = endpoint.replace(/\/+$/, "");
  const response = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
  });
  if (!response.ok) {
    throw new Error(`MCP call failed (${response.status}): ${await response.text()}`);
  }
  const data = await response.json();
  if (data.error) throw new Error(`MCP error: ${data.error.message}`);
  return data;
}

// ── Main Evaluator ────────────────────────────────────────────────────────

/**
 * Run message bus throughput benchmarks against a live oracle-messages server.
 *
 * The benchmark sends messages from a sender inbox and polls from a receiver inbox,
 * measuring round-trip latency for each operation.
 */
export async function runMessagesEval(opts: MessagesEvalOptions): Promise<PhaseResult> {
  const { endpoint, iterations, payloadSize } = opts;
  const senderId = `eval-sender-${Date.now()}`;
  const receiverId = `eval-receiver-${Date.now()}`;
  const payload = generatePayload(payloadSize);

  console.error(`[oracle-eval] messages endpoint: ${endpoint}`);
  console.error(`[oracle-eval] sender=${senderId} receiver=${receiverId} iterations=${iterations} payloadSize=${payloadSize}`);

  // Check connectivity
  try {
    await mcpCall(endpoint, "tools/list", {});
    console.error(`[oracle-eval] messages endpoint reachable`);
  } catch {
    console.error(`[oracle-eval] warning: could not list tools from messages endpoint, will try operations directly`);
  }

  // Warmup
  console.error(`[oracle-eval] warmup...`);
  for (let i = 0; i < 3; i++) {
    try {
      await mcpCall(endpoint, "send_message", {
        sender: senderId,
        recipient: receiverId,
        body: `warmup-${i}`,
      });
    } catch {
      // ignore warmup failures
    }
    try {
      await mcpCall(endpoint, "sync_messages", {
        agent: receiverId,
      });
    } catch {
      // ignore
    }
  }

  // Bench: send + poll latency
  console.error(`[oracle-eval] measuring throughput (${iterations} iterations)...`);
  const sendTimes: number[] = [];
  const pollTimes: number[] = [];
  let errors = 0;

  for (let i = 0; i < iterations; i++) {
    const msgBody = `${payload}-${i}`;

    // Send
    try {
      const sendStart = process.hrtime.bigint();
      await mcpCall(endpoint, "send_message", {
        sender: senderId,
        recipient: receiverId,
        body: msgBody,
      });
      sendTimes.push(Number(process.hrtime.bigint() - sendStart) / 1e6);
    } catch {
      errors++;
    }

    // Small delay to let message propagate
    await new Promise((r) => setTimeout(r, 10));

    // Poll (sync_messages)
    try {
      const pollStart = process.hrtime.bigint();
      await mcpCall(endpoint, "sync_messages", {
        agent: receiverId,
      });
      pollTimes.push(Number(process.hrtime.bigint() - pollStart) / 1e6);
    } catch {
      errors++;
    }
  }

  const sendAvg = avg(sendTimes);
  const sendMin = sendTimes.length ? Math.min(...sendTimes) : 0;
  const sendMax = sendTimes.length ? Math.max(...sendTimes) : 0;
  const pollAvg = avg(pollTimes);
  const pollMin = pollTimes.length ? Math.min(...pollTimes) : 0;
  const pollMax = pollTimes.length ? Math.max(...pollTimes) : 0;

  const throughput = sendTimes.length > 0 && sendAvg > 0
    ? `${(iterations / (sendAvg / 1000)).toFixed(0)} msg/s`
    : "0 msg/s";

  return {
    phase: "messages_throughput",
    config: `${iterations}msgs`,
    metrics: {
      sendAvg: `${sendAvg.toFixed(1)}ms`,
      sendMin: `${sendMin.toFixed(1)}ms`,
      sendMax: `${sendMax.toFixed(1)}ms`,
      pollAvg: `${pollAvg.toFixed(1)}ms`,
      pollMin: `${pollMin.toFixed(1)}ms`,
      pollMax: `${pollMax.toFixed(1)}ms`,
      throughput,
      totalOps: iterations * 2,
      errors,
    },
  };
}
