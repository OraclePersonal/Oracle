import { describe, it, expect, vi } from "vitest";
import { withRetry } from "./retry.js";

describe("withRetry", () => {
  it("returns the value on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withRetry(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on transient errors then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("EBUSY: resource busy"))
      .mockRejectedValueOnce(new Error("EIO: input/output error"))
      .mockResolvedValue("recovered");
    await expect(withRetry(fn, { maxRetries: 3, baseDelayMs: 10 })).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("re-throws after exhausting retries", async () => {
    const err = new Error("EBUSY: still busy");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 10 })).rejects.toThrow("EBUSY");
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("does not retry logical errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("ENOENT: no such file"));
    await expect(withRetry(fn)).rejects.toThrow("ENOENT");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry JSON parse errors", async () => {
    const err = new SyntaxError("Unexpected token");
    Object.defineProperty(err, "message", { value: "Unexpected token" });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn)).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on ECONNRESET", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET: socket hang up"))
      .mockResolvedValue("ok");
    await expect(withRetry(fn, { baseDelayMs: 10 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
