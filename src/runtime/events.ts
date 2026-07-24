import { EventEmitter } from "node:events";
import { RuntimeDatabase, type RuntimeEvent } from "./database.js";

export class RuntimeEventBus {
  private readonly emitter = new EventEmitter();

  constructor(private readonly database: RuntimeDatabase) {
    this.emitter.setMaxListeners(100);
  }

  publish(type: string, payload: Record<string, unknown>): RuntimeEvent {
    const event = this.database.recordEvent(type, payload);
    this.emitter.emit("event", event);
    return event;
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  history(afterId = 0, limit = 100): RuntimeEvent[] {
    return this.database.listEvents(afterId, limit);
  }
}
