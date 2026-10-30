import { useSyncExternalStore } from "react";

import { notificationQueue } from "../notificationQueue";
import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";

/** Failures remain available after their toast closes, until explicitly cleared. */
export function NotificationQueue() {
  const entries = useSyncExternalStore(notificationQueue.subscribe, notificationQueue.getSnapshot);
  if (entries.length === 0) return null;
  const failed = entries.filter((entry) => entry.status === "failed").length;
  const waiting = entries.filter((entry) => !entry.dismissed).length;

  return (
    <div className="pointer-events-auto fixed right-4 bottom-4 z-100 sm:right-8">
      <Popover>
        <PopoverTrigger render={<Button size="sm" variant="outline" />}>
          Notifications{waiting > 0 ? ` (${waiting})` : ""}
          {failed > 0 ? ` · ${failed} failed` : ""}
        </PopoverTrigger>
        <PopoverPopup side="top" align="end" width="lg" aria-label="Notification queue">
          <div className="flex max-h-96 flex-col gap-3 overflow-y-auto">
            <h2 className="text-sm font-medium">Notification queue</h2>
            <p className="text-xs text-muted-foreground">
              Notifications appear in order. Queued downloads run one at a time. Failed jobs stay
              here until dismissed.
            </p>
            <ol className="flex flex-col divide-y divide-border">
              {entries.map((entry) => {
                const busy = entry.job && (entry.status === "running" || entry.status === "queued");
                const action = entry.options.actionProps;
                return (
                  <li key={entry.id} className="flex min-w-0 flex-col gap-2 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 text-sm font-medium wrap-break-word">
                        {entry.options.title}
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {entry.status === "failed"
                          ? "Failed"
                          : entry.status === "running"
                            ? "Running"
                            : entry.status === "succeeded"
                              ? "Completed"
                              : notificationQueue.getActiveId() === entry.id
                                ? "Showing"
                                : "Queued"}
                      </span>
                    </div>
                    {entry.options.description ? (
                      <div className="max-h-40 overflow-y-auto text-xs whitespace-pre-wrap wrap-break-word text-muted-foreground">
                        {entry.options.description}
                      </div>
                    ) : null}
                    <div className="flex justify-end gap-2">
                      {entry.job && entry.status === "failed" ? (
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => notificationQueue.retry(entry.id)}
                        >
                          Retry
                        </Button>
                      ) : action?.children ? (
                        <Button {...action} size="xs" variant="outline" />
                      ) : null}
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => {
                          entry.options.data?.onClose?.();
                          if (busy) notificationQueue.manager.close(entry.id);
                          else notificationQueue.remove(entry.id);
                        }}
                      >
                        {busy ? "Hide notification" : "Dismiss"}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}
