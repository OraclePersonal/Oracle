import http, {
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { SchedulerService } from "./schedulerService.js";
import type { RuntimeEventBus } from "./events.js";

export interface LocalApiServerOptions {
  host: string;
  port: number;
  token: string;
  version: string;
  scheduler: SchedulerService;
  events: RuntimeEventBus;
  onShutdown: () => void;
}

export class LocalApiServer {
  private readonly server: Server;
  private readonly webSockets = new WebSocketServer({ noServer: true });
  private unsubscribeEvents?: () => void;

  constructor(private readonly options: LocalApiServerOptions) {
    this.server = http.createServer((request, response) => {
      void this.route(request, response);
    });
    this.server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", `http://${this.options.host}`);
      if (url.pathname !== "/v1/events" || !this.authorized(request, url)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        this.webSockets.emit("connection", webSocket, request);
      });
    });
    this.webSockets.on("connection", (socket, request) => {
      const url = new URL(request.url ?? "/", `http://${this.options.host}`);
      const after = this.integer(url.searchParams.get("after"), 0);
      socket.send(JSON.stringify({
        type: "runtime.connected",
        payload: {
          version: this.options.version,
          schedulerRunning: this.options.scheduler.isRunning
        }
      }));
      for (const event of this.options.events.history(after, 100)) {
        socket.send(JSON.stringify(event));
      }
    });
  }

  async start(): Promise<{ host: string; port: number }> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.unsubscribeEvents = this.options.events.subscribe((event) => {
      const encoded = JSON.stringify(event);
      for (const client of this.webSockets.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(encoded);
      }
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Runtime API did not bind a TCP port.");
    return { host: this.options.host, port: address.port };
  }

  async stop(): Promise<void> {
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = undefined;
    for (const client of this.webSockets.clients) client.close(1001, "daemon stopping");
    await new Promise<void>((resolve) => this.webSockets.close(() => resolve()));
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${this.options.host}`);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        this.json(response, 200, {
          status: "ok",
          version: this.options.version,
          pid: process.pid,
          uptimeSeconds: Math.floor(process.uptime()),
          schedulerRunning: this.options.scheduler.isRunning,
          storage: "sqlite"
        });
        return;
      }

      if (!this.authorized(request, url)) {
        this.json(response, 401, { error: "Unauthorized" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/events") {
        const after = this.integer(url.searchParams.get("after"), 0);
        const limit = this.integer(url.searchParams.get("limit"), 100);
        this.json(response, 200, { events: this.options.events.history(after, limit) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/daemon/stop") {
        this.json(response, 202, { stopping: true });
        setImmediate(this.options.onShutdown);
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/schedules") {
        this.json(response, 200, { tasks: await this.options.scheduler.list() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/schedules") {
        const body = await this.body(request);
        const task = await this.options.scheduler.create({
          name: this.requiredString(body.name, "name"),
          cron: this.requiredString(body.cron, "cron"),
          command: this.requiredString(body.command, "command"),
          description: this.optionalString(body.description, "description")
        });
        this.json(response, 201, { task });
        return;
      }

      const match = url.pathname.match(/^\/v1\/schedules\/([a-z0-9-]+)(?:\/(run))?$/i);
      if (match) {
        const taskId = match[1];
        if (request.method === "GET" && !match[2]) {
          const task = await this.options.scheduler.get(taskId);
          this.json(response, task ? 200 : 404, task ? { task } : { error: "Task not found" });
          return;
        }
        if (request.method === "PATCH" && !match[2]) {
          const body = await this.body(request);
          const task = await this.options.scheduler.update(taskId, {
            name: this.optionalString(body.name, "name"),
            cron: this.optionalString(body.cron, "cron"),
            command: this.optionalString(body.command, "command"),
            description: this.optionalString(body.description, "description"),
            status: body.status === undefined
              ? undefined
              : this.taskStatus(body.status)
          });
          this.json(response, task ? 200 : 404, task ? { task } : { error: "Task not found" });
          return;
        }
        if (request.method === "DELETE" && !match[2]) {
          const removed = await this.options.scheduler.remove(taskId);
          this.json(response, removed ? 200 : 404, removed ? { removed: true } : { error: "Task not found" });
          return;
        }
        if (request.method === "POST" && match[2] === "run") {
          const result = await this.options.scheduler.run(taskId);
          // Command failure is a scheduler result, not an HTTP transport
          // failure. Callers need the structured output to set their own
          // process status and display stderr.
          this.json(response, 200, result);
          return;
        }
      }

      this.json(response, 404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /not found/i.test(message) ? 404 : 400;
      this.json(response, status, { error: message });
    }
  }

  private authorized(request: IncomingMessage, url: URL): boolean {
    const bearer = request.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
    const header = request.headers["x-oracle-token"];
    const query = url.searchParams.get("token");
    return bearer === this.options.token || header === this.options.token || query === this.options.token;
  }

  private async body(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 1_000_000) throw new Error("Request body exceeds 1 MB.");
      chunks.push(buffer);
    }
    if (!chunks.length) return {};
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Request body must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
  }

  private requiredString(value: unknown, field: string): string {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
    return value;
  }

  private optionalString(value: unknown, field: string): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") throw new Error(`${field} must be a string.`);
    return value;
  }

  private taskStatus(value: unknown): "active" | "paused" | "deleted" {
    if (value === "active" || value === "paused" || value === "deleted") return value;
    throw new Error("status must be active, paused, or deleted.");
  }

  private integer(value: string | null, fallback: number): number {
    if (value === null) return fallback;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
  }

  private json(response: ServerResponse, status: number, payload: unknown): void {
    const encoded = JSON.stringify(payload);
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(encoded),
      "cache-control": "no-store"
    });
    response.end(encoded);
  }
}
