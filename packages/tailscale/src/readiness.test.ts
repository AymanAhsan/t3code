// @effect-diagnostics preferSchemaOverJson:off - Fixtures are written as objects, then serialized, so their shape stays readable.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { mockSpawnerLayer } from "./mockSpawner.ts";
import {
  parseTailscaleNodeFacts,
  parseTailscaleServeConfig,
  readTailscaleNodeFacts,
  readTailscaleServeConfig,
  tailscaleBlockedReason,
  tailscaleBlockedReasonOfFailure,
  type TailscaleNodeFacts,
} from "./readiness.ts";
import {
  TailscaleCommandExitError,
  TailscaleCommandSpawnError,
  TailscaleCommandTimeoutError,
  TailscaleStatusParseError,
} from "./tailscale.ts";

const statusJson = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    BackendState: "Running",
    CertDomains: ["desk.tail.ts.net"],
    CurrentTailnet: { MagicDNSEnabled: true },
    Self: {
      DNSName: "desk.tail.ts.net.",
      CapMap: { https: null, funnel: null, "is-admin": null },
    },
    ...overrides,
  });

const readyFacts: TailscaleNodeFacts = {
  backendState: "running",
  magicDnsName: "desk.tail.ts.net",
  magicDnsEnabled: true,
  httpsEnabled: true,
  funnelAllowed: true,
};

describe("tailscale readiness", () => {
  it.effect("reads the facts that decide whether sharing can work", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* parseTailscaleNodeFacts(statusJson()), readyFacts);
    }),
  );

  it.effect("reads backend states, and treats unknown ones as not connected", () =>
    Effect.gen(function* () {
      const states = [
        ["NeedsLogin", "needs-login"],
        ["NeedsMachineAuth", "needs-machine-auth"],
        ["Stopped", "stopped"],
        ["Starting", "other"],
      ] as const;
      for (const [raw, expected] of states) {
        const facts = yield* parseTailscaleNodeFacts(statusJson({ BackendState: raw }));
        assert.equal(facts.backendState, expected);
      }
    }),
  );

  it.effect("reports https and funnel as off only when the CLI says so", () =>
    Effect.gen(function* () {
      const httpsOff = yield* parseTailscaleNodeFacts(
        statusJson({
          CertDomains: null,
          Self: { DNSName: "desk.tail.ts.net.", CapMap: { "is-admin": null } },
        }),
      );
      assert.equal(httpsOff.httpsEnabled, false);
      assert.equal(httpsOff.funnelAllowed, false);

      // Nothing reported: unknown, which must not read as "off".
      const silent = yield* parseTailscaleNodeFacts(
        JSON.stringify({ BackendState: "Running", Self: { DNSName: "desk.tail.ts.net." } }),
      );
      assert.equal(silent.httpsEnabled, null);
      assert.equal(silent.funnelAllowed, null);
      assert.equal(silent.magicDnsEnabled, null);
    }),
  );

  it.effect("accepts the older Capabilities list and a missing Self", () =>
    Effect.gen(function* () {
      const older = yield* parseTailscaleNodeFacts(
        JSON.stringify({
          BackendState: "Running",
          Self: { DNSName: "desk.tail.ts.net.", Capabilities: ["https", "funnel"] },
        }),
      );
      assert.equal(older.httpsEnabled, true);
      assert.equal(older.funnelAllowed, true);

      const loggedOut = yield* parseTailscaleNodeFacts(
        JSON.stringify({ BackendState: "NeedsLogin" }),
      );
      assert.equal(loggedOut.magicDnsName, null);
    }),
  );

  it.effect("fails with a parse error on malformed status", () =>
    Effect.gen(function* () {
      const error = yield* parseTailscaleNodeFacts("{nope").pipe(Effect.flip);
      assert.instanceOf(error, TailscaleStatusParseError);
    }),
  );

  it("names the single thing blocking a share", () => {
    const blocked = (facts: Partial<TailscaleNodeFacts>, exposure: "serve" | "funnel" = "serve") =>
      tailscaleBlockedReason({ ...readyFacts, ...facts }, { exposure });

    assert.equal(blocked({}), null);
    assert.equal(blocked({ backendState: "needs-login" }), "signed-out");
    assert.equal(blocked({ backendState: "needs-machine-auth" }), "awaiting-approval");
    assert.equal(blocked({ backendState: "stopped" }), "stopped");
    assert.equal(blocked({ backendState: "other" }), "stopped");
    assert.equal(blocked({ httpsEnabled: false }), "https-disabled");
    assert.equal(blocked({ magicDnsEnabled: false }), "https-disabled");
    assert.equal(blocked({ magicDnsName: null }), "https-disabled");
    // Funnel is only required when the admin chose public sharing.
    assert.equal(blocked({ funnelAllowed: false }, "serve"), null);
    assert.equal(blocked({ funnelAllowed: false }, "funnel"), "funnel-not-allowed");
    // Unknown never blocks.
    assert.equal(blocked({ httpsEnabled: null, funnelAllowed: null }, "funnel"), null);
  });

  it.effect("maps command failures to the setup problem they imply", () => {
    const failureOf = (code: number, stderr: string) =>
      readTailscaleNodeFacts.pipe(
        Effect.flip,
        Effect.provide(mockSpawnerLayer(() => ({ code, stderr }))),
      );

    return Effect.gen(function* () {
      const daemon = yield* failureOf(1, "failed to connect to local tailscaled");
      assert.instanceOf(daemon, TailscaleCommandExitError);
      assert.equal(tailscaleBlockedReasonOfFailure(daemon), "daemon-not-running");

      const signedOut = yield* failureOf(1, "Logged out.");
      assert.equal(tailscaleBlockedReasonOfFailure(signedOut), "signed-out");

      const unknown = yield* failureOf(1, "something novel");
      assert.equal(tailscaleBlockedReasonOfFailure(unknown), null);

      assert.equal(
        tailscaleBlockedReasonOfFailure(
          new TailscaleCommandSpawnError({
            executable: "tailscale",
            subcommand: "status",
            argumentCount: 2,
            cause: new Error("ENOENT"),
          }),
        ),
        "not-installed",
      );
      assert.equal(
        tailscaleBlockedReasonOfFailure(
          new TailscaleCommandTimeoutError({
            executable: "tailscale",
            subcommand: "status",
            argumentCount: 2,
            timeoutMs: 1_500,
            cause: new Error("timeout"),
          }),
        ),
        "daemon-not-running",
      );
    });
  });

  it.effect("reads node facts through the process spawner", () => {
    const layer = mockSpawnerLayer((command, args) => {
      assert.equal(command, "tailscale");
      assert.deepEqual(args, ["status", "--json"]);
      return { stdout: statusJson() };
    });
    return Effect.gen(function* () {
      assert.deepEqual(yield* readTailscaleNodeFacts, readyFacts);
    }).pipe(Effect.provide(layer));
  });
});

describe("tailscale serve config", () => {
  const configJson = JSON.stringify({
    TCP: {
      "443": { HTTPS: true },
      "8443": { HTTPS: true },
      "2222": { TCPForward: "127.0.0.1:22" },
    },
    Web: {
      "desk.tail.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8080" } } },
      "desk.tail.ts.net:8443": { Handlers: { "/": { Text: "hi" } } },
    },
    AllowFunnel: { "desk.tail.ts.net:443": true },
  });

  it.effect("lists web mappings with their target and whether they are public", () =>
    Effect.gen(function* () {
      const config = yield* parseTailscaleServeConfig(configJson);
      assert.deepEqual(config.mappings, [
        { host: "desk.tail.ts.net", port: 443, proxy: "http://127.0.0.1:8080", funnel: true },
        { host: "desk.tail.ts.net", port: 8443, proxy: null, funnel: false },
      ]);
      assert.deepEqual(config.otherPorts, [2222]);
    }),
  );

  it.effect("treats empty output as no mappings", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* parseTailscaleServeConfig(""), { mappings: [], otherPorts: [] });
      assert.deepEqual(yield* parseTailscaleServeConfig("{}"), { mappings: [], otherPorts: [] });
    }),
  );

  it.effect("reads the config through the process spawner", () => {
    const layer = mockSpawnerLayer((_command, args) => {
      assert.deepEqual(args, ["serve", "status", "--json"]);
      return { stdout: configJson };
    });
    return Effect.gen(function* () {
      const config = yield* readTailscaleServeConfig;
      assert.equal(config.mappings.length, 2);
    }).pipe(Effect.provide(layer));
  });
});
