import { AsyncResult } from "effect/unstable/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  connected: true,
  tasks: [] as Array<{ id: string; status: string; assigneeId: string | null; createdAt: number }>,
  mode: "notifications-and-sound",
  sound: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () =>
    AsyncResult.success({
      status: state.connected ? "connected" : "disconnected",
      snapshot: { selfId: "self", tasks: state.tasks },
    }),
}));
vi.mock("../state/teamHub", () => ({ teamHubStateAtom: () => null }));
vi.mock("../state/environments", () => ({ useEnvironmentIds: () => ["env"] }));
vi.mock("../hooks/useSettings", () => ({
  getClientSettings: () => ({ notificationMode: state.mode }),
}));
vi.mock("../threadNotifications", () => ({
  hasNotificationSound: (mode: string) => mode === "notifications-and-sound" || mode === "sound",
  playNotificationSound: state.sound,
}));

import { TeamHubNotificationCoordinator } from "./TeamHubNotificationCoordinator";

let renderer: ReactTestRenderer | undefined;
async function render() {
  await act(async () => {
    if (renderer) renderer.update(<TeamHubNotificationCoordinator />);
    else renderer = create(<TeamHubNotificationCoordinator />);
  });
}
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.connected = true;
  state.tasks = [];
  state.mode = "notifications-and-sound";
  vi.clearAllMocks();
});
const task = (id: string, assigneeId: string | null = "self") => ({
  id,
  assigneeId,
  status: "suggested",
  createdAt: 1,
});

describe("incoming team task sounds", () => {
  it("sounds for a new request once, including across reconnects", async () => {
    await render();
    state.tasks = [task("one")];
    await render();
    expect(state.sound).toHaveBeenCalledTimes(1);
    state.connected = false;
    await render();
    state.connected = true;
    await render();
    expect(state.sound).toHaveBeenCalledTimes(1);
    state.tasks = [task("one"), task("two", null)];
    await render();
    expect(state.sound).toHaveBeenCalledTimes(2);
  });

  it("ignores another member's tasks and respects the sound setting", async () => {
    state.tasks = [task("other", "teammate")];
    await render();
    expect(state.sound).not.toHaveBeenCalled();
    state.mode = "off";
    state.tasks = [task("mine")];
    await render();
    expect(state.sound).not.toHaveBeenCalled();
  });
});
