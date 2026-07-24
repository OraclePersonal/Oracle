import type { CreateTaskInput, CronTask, UpdateTaskInput } from "../scheduler/taskStore.js";
import { readDaemonState, type DaemonState } from "./state.js";

export interface RuntimeHealth {
  status: "ok";
  version: string;
  pid: number;
  uptimeSeconds: number;
  schedulerRunning: boolean;
  storage: "sqlite";
}

export class RuntimeClient {
  constructor(readonly state: DaemonState) {}

  static async connect(homeDir: string): Promise<RuntimeClient | null> {
    const state = await readDaemonState(homeDir);
    if (!state) return null;
    const client = new RuntimeClient(state);
    try {
      await client.health();
      return client;
    } catch {
      return null;
    }
  }

  health(): Promise<RuntimeHealth> {
    return this.request<RuntimeHealth>("GET", "/health", undefined, false);
  }

  async listSchedules(): Promise<CronTask[]> {
    return (await this.request<{ tasks: CronTask[] }>("GET", "/v1/schedules")).tasks;
  }

  async getSchedule(id: string): Promise<CronTask | null> {
    try {
      return (await this.request<{ task: CronTask }>("GET", `/v1/schedules/${id}`)).task;
    } catch (error) {
      if (error instanceof RuntimeApiError && error.status === 404) return null;
      throw error;
    }
  }

  async createSchedule(input: CreateTaskInput): Promise<CronTask> {
    return (await this.request<{ task: CronTask }>("POST", "/v1/schedules", input)).task;
  }

  async updateSchedule(id: string, input: UpdateTaskInput): Promise<CronTask | null> {
    try {
      return (await this.request<{ task: CronTask }>("PATCH", `/v1/schedules/${id}`, input)).task;
    } catch (error) {
      if (error instanceof RuntimeApiError && error.status === 404) return null;
      throw error;
    }
  }

  async removeSchedule(id: string): Promise<boolean> {
    try {
      return (await this.request<{ removed: boolean }>("DELETE", `/v1/schedules/${id}`)).removed;
    } catch (error) {
      if (error instanceof RuntimeApiError && error.status === 404) return false;
      throw error;
    }
  }

  runSchedule(id: string): Promise<{ result: "success" | "error"; output: string }> {
    return this.request("POST", `/v1/schedules/${id}/run`, undefined, true, 300_000);
  }

  requestStop(): Promise<{ stopping: boolean }> {
    return this.request("POST", "/v1/daemon/stop");
  }

  webSocketUrl(after = 0): string {
    const url = new URL(this.baseUrl().replace(/^http/, "ws"));
    url.pathname = "/v1/events";
    url.searchParams.set("token", this.state.token);
    if (after > 0) url.searchParams.set("after", String(after));
    return url.toString();
  }

  private async request<T>(
    method: string,
    pathname: string,
    body?: unknown,
    authenticated = true,
    timeoutMs = 2000
  ): Promise<T> {
    const response = await fetch(new URL(pathname, this.baseUrl()), {
      method,
      headers: {
        accept: "application/json",
        ...(authenticated ? { authorization: `Bearer ${this.state.token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const payload = await response.json() as T & { error?: string };
    if (!response.ok) {
      throw new RuntimeApiError(response.status, payload.error ?? `Runtime API returned ${response.status}.`);
    }
    return payload;
  }

  private baseUrl(): string {
    const host = this.state.host.includes(":") ? `[${this.state.host}]` : this.state.host;
    return `http://${host}:${this.state.port}/`;
  }
}

export class RuntimeApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "RuntimeApiError";
  }
}
