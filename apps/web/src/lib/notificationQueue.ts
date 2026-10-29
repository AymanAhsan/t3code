import type {
  ToastManager,
  ToastManagerAddOptions,
  ToastManagerPromiseOptions,
  ToastManagerUpdateOptions,
} from "@base-ui/react/toast";

type Job = {
  run: () => Promise<unknown>;
  title: string;
  successTitle: string;
};

export function createNotificationQueue<Data extends object>(display: ToastManager<Data>) {
  type Options = ToastManagerAddOptions<Data>;
  type Entry = {
    id: string;
    options: Options;
    dismissed: boolean;
    status: "queued" | "running" | "succeeded" | "failed";
    job?: Job;
  };

  let entries: readonly Entry[] = [];
  let activeId: string | undefined;
  let sequence = 0;
  let eligible: ((options: Options) => boolean) | undefined;
  let executing = false;
  let connected = false;
  let generation = 0;
  const jobs: string[] = [];
  const listeners = new Set<() => void>();
  const emit = () => {
    entries = [...entries];
    listeners.forEach((listener) => listener());
  };
  const find = (id: string) => entries.find((entry) => entry.id === id);
  const replace = (id: string, patch: Partial<Entry>) => {
    entries = entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
    emit();
  };

  const present = () => {
    if (!connected || activeId !== undefined || !eligible) return;
    const entry = entries.find((item) => !item.dismissed && eligible?.(item.options));
    if (!entry) return;
    activeId = entry.id;
    const presentation = entry;
    const token = ++generation;
    display.add({
      ...entry.options,
      id: entry.id,
      onClose: () => {
        // A route change can hide a toast without dismissing its queued notification.
        if (token !== generation || activeId !== presentation.id) return;
        activeId = undefined;
        const current = find(presentation.id);
        if (current?.options.type === "error" || (current?.job && current.status !== "succeeded")) {
          replace(presentation.id, { dismissed: true });
        } else {
          entries = entries.filter((item) => item.id !== presentation.id);
          emit();
        }
        current?.options.onClose?.();
        present();
      },
    });
    emit();
  };

  const hide = (id: string) => {
    if (activeId !== id) return;
    generation++;
    activeId = undefined;
    display.close(id);
  };

  const add = (options: Options) => {
    const id = options.id ?? `notification-${++sequence}`;
    if (find(id)) {
      update(id, options);
      return id;
    }
    entries = [
      ...entries,
      {
        id,
        options,
        dismissed: false,
        status:
          options.type === "error" ? "failed" : options.type === "loading" ? "running" : "queued",
      },
    ];
    emit();
    present();
    return id;
  };

  const update = (id: string, updates: ToastManagerUpdateOptions<Data>) => {
    const entry = find(id);
    if (!entry) return;
    // Match Base UI: undefined update fields leave the existing value intact.
    const defined = Object.fromEntries(
      Object.entries(updates).filter(([, value]) => value !== undefined),
    );
    const options = { ...entry.options, ...defined };
    replace(id, {
      options,
      ...(updates.type
        ? {
            status:
              updates.type === "error"
                ? "failed"
                : updates.type === "loading"
                  ? "running"
                  : updates.type === "success"
                    ? "succeeded"
                    : "queued",
            dismissed:
              updates.type === "error" ||
              (entry.options.type === "error" && updates.type === "loading")
                ? false
                : entry.dismissed,
          }
        : {}),
    });
    const { onClose: _onClose, ...displayUpdates } = updates;
    if (activeId === id && eligible && !eligible(options)) hide(id);
    if (activeId === id) display.update(id, displayUpdates);
    present();
  };

  const close = (id?: string) => {
    const targets = id === undefined ? entries : entries.filter((entry) => entry.id === id);
    for (const entry of targets) {
      hide(entry.id);
      if (entry.options.type === "error" || (entry.job && entry.status !== "succeeded")) {
        replace(entry.id, { dismissed: true });
      } else {
        entries = entries.filter((item) => item.id !== entry.id);
      }
      entry.options.onClose?.();
    }
    emit();
    present();
  };

  const work = async () => {
    if (executing) return;
    executing = true;
    try {
      let id: string | undefined;
      while ((id = jobs.shift()) !== undefined) {
        const entry = find(id);
        if (!entry?.job || entry.status !== "queued") continue;
        const { job } = entry;
        replace(id, { status: "running" });
        update(id, {
          type: "loading",
          title: job.title,
          description: "",
          timeout: 0,
          actionProps: { children: null },
        });
        try {
          await job.run();
          replace(id, { status: "succeeded" });
          update(id, {
            type: "success",
            title: job.successTitle,
            timeout: 5_000,
            actionProps: { children: null },
          });
          if (find(id)?.dismissed) {
            entries = entries.filter((item) => item.id !== id);
            emit();
          }
        } catch (error) {
          const failedId = id;
          update(id, {
            type: "error",
            title: `${job.title} failed`,
            description:
              error instanceof Error
                ? error.message
                : String(error ?? "An unknown error occurred."),
            timeout: 8_000,
            actionProps: { children: "Retry", onClick: () => retry(failedId) },
          });
        }
      }
    } finally {
      executing = false;
    }
  };

  const retry = (id: string) => {
    const entry = find(id);
    if (!entry?.job || entry.status !== "failed") return;
    hide(id);
    replace(id, {
      status: "queued",
      dismissed: false,
      options: {
        ...entry.options,
        type: "info",
        title: entry.job.title,
        description: "Waiting for earlier jobs",
        timeout: 0,
        actionProps: { children: null },
      },
    });
    entries = [...entries.filter((item) => item.id !== id), find(id)!];
    emit();
    jobs.push(id);
    present();
    void work();
  };

  const promise = async <Value>(
    value: Promise<Value>,
    options: ToastManagerPromiseOptions<Value, Data>,
  ) => {
    const normalize = (option: string | ToastManagerUpdateOptions<Data>) =>
      typeof option === "string" ? { title: option } : option;
    const id = add({ ...normalize(options.loading), type: "loading" });
    try {
      const result = await value;
      update(id, {
        ...normalize(
          typeof options.success === "function" ? options.success(result) : options.success,
        ),
        type: "success",
      });
      return result;
    } catch (error) {
      update(id, {
        ...normalize(typeof options.error === "function" ? options.error(error) : options.error),
        type: "error",
      });
      throw error;
    }
  };

  return {
    manager: {
      ...display,
      add,
      update,
      close,
      promise,
      " subscribe": (listener: Parameters<(typeof display)[" subscribe"]>[0]) => {
        const unsubscribe = display[" subscribe"](listener);
        connected = true;
        present();
        return () => {
          connected = false;
          if (activeId !== undefined) hide(activeId);
          unsubscribe();
        };
      },
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => entries,
    getActiveId: () => activeId,
    setFilter: (filter: (options: Options) => boolean) => {
      eligible = filter;
      const active = activeId === undefined ? undefined : find(activeId);
      if (active && !filter(active.options)) hide(active.id);
      present();
    },
    retry,
    remove: (id: string) => {
      const entry = find(id);
      if (entry?.job && (entry.status === "running" || entry.status === "queued")) return;
      close(id);
      entries = entries.filter((item) => item.id !== id);
      emit();
    },
    enqueue: (job: Job) => {
      const id = add({
        type: "info",
        title: job.title,
        description: "Waiting for earlier jobs",
        timeout: 0,
      });
      replace(id, { job });
      jobs.push(id);
      void work();
      return id;
    },
  };
}
