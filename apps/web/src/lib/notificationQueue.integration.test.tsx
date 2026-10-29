import { Toast, type ToastObject } from "@base-ui/react/toast";
import { useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";

import { createNotificationQueue } from "./notificationQueue";

it("starts toast timeouts only when displayed through the real provider", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", { activeElement: null });
  const queue = createNotificationQueue(Toast.createToastManager<object>());
  let rendered: ToastObject<object>[] = [];
  let renderer: ReactTestRenderer | undefined;
  function Probe() {
    const { toasts } = Toast.useToastManager<object>();
    useEffect(() => {
      rendered = toasts;
    }, [toasts]);
    useEffect(() => queue.setFilter(() => true), []);
    return null;
  }
  const first = queue.manager.add({ title: "First", timeout: 100 });
  const second = queue.manager.add({ title: "Second", timeout: 20 });
  try {
    await act(async () => {
      renderer = create(
        <Toast.Provider toastManager={queue.manager}>
          <Probe />
        </Toast.Provider>,
      );
    });
    expect(
      rendered.filter((toast) => toast.transitionStatus !== "ending").map((toast) => toast.id),
    ).toEqual([first]);
    await act(async () => {
      vi.advanceTimersByTime(99);
    });
    expect(queue.getActiveId()).toBe(first);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(queue.getActiveId()).toBe(second);
    expect(
      rendered.filter((toast) => toast.transitionStatus !== "ending").map((toast) => toast.id),
    ).toEqual([second]);
    await act(async () => {
      vi.advanceTimersByTime(19);
    });
    expect(queue.getActiveId()).toBe(second);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(queue.getSnapshot()).toEqual([]);
  } finally {
    await act(async () => renderer?.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
