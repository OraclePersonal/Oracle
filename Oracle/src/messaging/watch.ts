import fs from "node:fs/promises";
import path from "node:path";
import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import type { AgentMessage } from "./store.js";

/**
 * Real-time inbox watcher: fires `onMessage` the moment another process drops
 * a message for `agent` into ~/.oracle/messages/. This is the push half of
 * the bus — the store is pull-based, but a watcher process (e.g. `oracle msg
 * watch --exec "tmux send-keys ..."`) can wake an idle agent session the
 * instant something arrives instead of waiting for its next Stop hook.
 *
 * Relies on the store's atomic tmp+rename writes: chokidar sees a single
 * "add" of a complete file, never a partial write. `.tmp` files are ignored
 * defensively anyway.
 */
export async function watchInbox(
  homeDir: string,
  agent: string,
  onMessage: (msg: AgentMessage) => void | Promise<void>
): Promise<FSWatcher> {
  const dir = path.join(homeDir, "messages");
  await fs.mkdir(dir, { recursive: true });

  const watcher = chokidarWatch(dir, {
    ignoreInitial: true,
    depth: 0,
    ignored: (p) => p.endsWith(".tmp"),
  });

  watcher.on("add", async (filePath) => {
    if (!filePath.endsWith(".json")) return;
    let msg: AgentMessage;
    try {
      msg = JSON.parse(await fs.readFile(filePath, "utf8")) as AgentMessage;
    } catch {
      return; // partial/corrupt file — the store's atomic writes make this rare
    }
    const forMe = (msg.to === agent || msg.to === "*") && msg.from !== agent;
    if (forMe && !(msg.readBy ?? []).includes(agent)) {
      await onMessage(msg);
    }
  });

  return watcher;
}
