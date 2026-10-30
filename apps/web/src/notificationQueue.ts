import { Toast } from "@base-ui/react/toast";

import type { ThreadToastData } from "./components/ui/toast";
import { createNotificationQueue } from "./lib/notificationQueue";

export const notificationQueue = createNotificationQueue(
  Toast.createToastManager<ThreadToastData>(),
);
export const toastManager = notificationQueue.manager;
