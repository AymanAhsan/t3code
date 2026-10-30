import { Toast, type ToastManagerAddOptions } from "@base-ui/react/toast";
import { describe, expect, it, vi } from "vite-plus/test";

import { createNotificationQueue } from "./notificationQueue";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function setup() {
  type Data = { scope?: string };
  const display = Toast.createToastManager<Data>();
  const shown = new Map<string, ToastManagerAddOptions<Data>>();
  vi.spyOn(display, "add").mockImplementation((options) => {
    const id = options.id!;
    shown.set(id, options);
    return id;
  });
  vi.spyOn(display, "update").mockImplementation((id, updates) => {
    shown.set(id, { ...shown.get(id), ...updates });
  });
  vi.spyOn(display, "close").mockImplementation((id) => {
    if (id) shown.get(id)?.onClose?.();
  });
  const queue = createNotificationQueue(display);
  const connect = () => queue.manager[" subscribe"](() => {});
  const disconnect = connect();
  queue.setFilter(() => true);
  const dismissed = (id: string) => shown.get(id)?.onClose?.();
  return { queue, display, shown, dismissed, connect, disconnect };
}

describe("notification queue", () => {
  it("presents bursts in arrival order and only starts displaying each after its predecessor closes", () => {
    const { queue, display, dismissed } = setup();
    const first = queue.manager.add({ title: "First" });
    const second = queue.manager.add({ title: "Second" });
    const third = queue.manager.add({ title: "Third" });
    expect(display.add).toHaveBeenCalledTimes(1);
    dismissed(first);
    expect(queue.getActiveId()).toBe(second);
    dismissed(second);
    expect(queue.getActiveId()).toBe(third);
    dismissed(third);
    expect(queue.getSnapshot()).toEqual([]);
  });

  it("updates a waiting notification without publishing it or losing its position", () => {
    const { queue, display, shown, dismissed } = setup();
    const first = queue.manager.add({ title: "First" });
    const second = queue.manager.add({ type: "loading", title: "Downloading" });
    queue.manager.update(second, { type: "error", description: "Connection lost" });
    expect(display.update).not.toHaveBeenCalled();
    dismissed(first);
    expect(shown.get(second)).toMatchObject({ type: "error", description: "Connection lost" });
    dismissed(second);
    expect(queue.getSnapshot()).toMatchObject([{ id: second, dismissed: true, status: "failed" }]);
  });

  it("skips notifications for another thread and restores them when that thread opens", () => {
    const { queue, dismissed } = setup();
    queue.setFilter((options) => options.data?.scope === "a");
    const b = queue.manager.add({ title: "B", data: { scope: "b" } });
    const a = queue.manager.add({ title: "A", data: { scope: "a" } });
    expect(queue.getActiveId()).toBe(a);
    queue.setFilter((options) => options.data?.scope === "b");
    expect(queue.getActiveId()).toBe(b);
    dismissed(b);
    queue.setFilter((options) => options.data?.scope === "a");
    expect(queue.getActiveId()).toBe(a);
    expect(queue.getSnapshot()).toHaveLength(1);
  });

  it("ignores stale close callbacks after hiding and redisplaying the same notification", () => {
    const { queue, shown } = setup();
    const id = queue.manager.add({ title: "A" });
    const oldClose = shown.get(id)!.onClose;
    queue.setFilter(() => false);
    queue.setFilter(() => true);
    oldClose?.();
    expect(queue.getActiveId()).toBe(id);
    expect(queue.getSnapshot()).toHaveLength(1);
  });

  it("buffers notifications while the provider is disconnected", () => {
    const { queue, display, disconnect, connect } = setup();
    disconnect();
    const id = queue.manager.add({ title: "Before mount" });
    expect(display.add).not.toHaveBeenCalled();
    connect();
    expect(queue.getActiveId()).toBe(id);
    expect(display.add).toHaveBeenCalledOnce();
  });

  it("advances when an update changes the active notification's thread scope", () => {
    const { queue } = setup();
    queue.setFilter((options) => options.data?.scope === "a");
    const first = queue.manager.add({ title: "First", data: { scope: "a" } });
    const second = queue.manager.add({ title: "Second", data: { scope: "a" } });
    queue.manager.update(first, { data: { scope: "b" } });
    expect(queue.getActiveId()).toBe(second);
    expect(queue.getSnapshot()).toHaveLength(2);
  });

  it("preserves close handling when an active toast replaces its callback", () => {
    const { queue, dismissed } = setup();
    const onClose = vi.fn();
    const id = queue.manager.add({ title: "First" });
    const next = queue.manager.add({ title: "Next" });
    queue.manager.update(id, { onClose });
    dismissed(id);
    expect(onClose).toHaveBeenCalledOnce();
    expect(queue.getActiveId()).toBe(next);
  });

  it("clears archived failures explicitly and preserves details on undefined updates", () => {
    const { queue, dismissed } = setup();
    const id = queue.manager.add({ type: "error", title: "Failed", description: "Original error" });
    queue.manager.update(id, { description: undefined });
    dismissed(id);
    expect(queue.getSnapshot()[0]?.options.description).toBe("Original error");
    queue.remove(id);
    expect(queue.getSnapshot()).toEqual([]);
  });

  it("removes queued notifications before they can be shown and closes all without draining the backlog", () => {
    const { queue, display } = setup();
    queue.manager.add({ title: "First" });
    const removed = queue.manager.add({ title: "Second" });
    queue.manager.add({ title: "Third" });
    queue.manager.close(removed);
    queue.manager.close();
    expect(display.add).toHaveBeenCalledOnce();
    expect(queue.getSnapshot()).toEqual([]);
  });

  it("keeps promise notifications in the same queue and retains rejection details", async () => {
    const { queue, shown, dismissed } = setup();
    const first = queue.manager.add({ title: "First" });
    await expect(
      queue.manager.promise(Promise.reject(new Error("Offline")), {
        loading: "Loading",
        success: "Done",
        error: (error: Error) => ({ title: "Failed", description: error.message }),
      }),
    ).rejects.toThrow("Offline");
    expect(queue.getActiveId()).toBe(first);
    dismissed(first);
    expect(shown.get(queue.getActiveId()!)).toMatchObject({
      type: "error",
      description: "Offline",
    });
  });

  it("runs jobs serially, continues after failure, and retries at the tail without duplicate attempts", async () => {
    const { queue } = setup();
    const firstAttempt = deferred();
    const secondAttempt = deferred();
    const secondStarted = deferred();
    const retryStarted = deferred();
    const retryAttempt = deferred();
    const run = vi
      .fn()
      .mockImplementationOnce(() => firstAttempt.promise)
      .mockImplementationOnce(() => {
        retryStarted.resolve();
        return retryAttempt.promise;
      });
    const id = queue.enqueue({ title: "Download", successTitle: "Downloaded", run });
    const secondRun = vi.fn(() => {
      secondStarted.resolve();
      return secondAttempt.promise;
    });
    queue.enqueue({ title: "Second", successTitle: "Done", run: secondRun });
    expect(secondRun).not.toHaveBeenCalled();
    firstAttempt.reject(new Error("Network unavailable"));
    await secondStarted.promise;
    expect(queue.getSnapshot().find((entry) => entry.id === id)).toMatchObject({
      status: "failed",
      options: { description: "Network unavailable" },
    });
    queue.retry(id);
    queue.retry(id);
    expect(run).toHaveBeenCalledOnce();
    secondAttempt.resolve();
    await retryStarted.promise;
    expect(run).toHaveBeenCalledTimes(2);
    expect(queue.getSnapshot().find((entry) => entry.id === id)?.status).toBe("running");
    const settled = deferred();
    const unsubscribe = queue.subscribe(() => {
      if (queue.getSnapshot().find((entry) => entry.id === id)?.status === "succeeded")
        settled.resolve();
    });
    retryAttempt.resolve();
    await settled.promise;
    unsubscribe();
  });
});
