// @effect-diagnostics globalConsole:off - The standalone process prints its one-time setup link to the operator.
import { createHubServer } from "./server.ts";
import { HubStore } from "./store.ts";

const dataDir = process.env.HUB_DATA_DIR ?? "./.hub-data";
const host = process.env.HUB_HOST ?? "127.0.0.1";
const port = Number(process.env.HUB_PORT ?? "8080");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("HUB_PORT must be between 1 and 65535");
}
const store = new HubStore(dataDir);
const server = await createHubServer(store, { host, port });
console.log(`Team hub listening on ${host}:${server.port}`);
if (store.setupToken) {
  const baseUrl = process.env.HUB_PUBLIC_URL ?? `http://localhost:${server.port}`;
  console.log(
    `One-time setup link: ${new URL(`/setup#token=${encodeURIComponent(store.setupToken)}`, baseUrl)}`,
  );
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close().then(() => store.close());
  });
}
