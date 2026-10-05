// @effect-diagnostics preferSchemaOverJson:off - Fixtures are written as objects, then serialized, so their shape stays readable.
import { assert, describe, it } from "@effect/vitest";
import type { TeamHubNetworkInput } from "@t3tools/contracts/teamHub";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as TeamHubNetwork from "./TeamHubNetwork.ts";

const encoder = new TextEncoder();

const readyStatus = {
  BackendState: "Running",
  CertDomains: ["desk.tail.ts.net"],
  CurrentTailnet: { MagicDNSEnabled: true },
  Self: { DNSName: "desk.tail.ts.net.", CapMap: { https: null, funnel: null } },
};

interface Mapping {
  port: number;
  proxy: string;
  funnel: boolean;
}

/** The fake machine: a Tailscale CLI and the hubs reachable from it. */
interface World {
  status: unknown;
  mappings: Array<Mapping>;
  otherPorts: Array<number>;
  /** Every `serve`/`funnel` command that changed something. */
  changes: Array<ReadonlyArray<string>>;
  statusReads: number;
  /** A hub is listening on loopback at this port. */
  localHubPort: number | null;
  /** Public mapping answers /health once it has been probed this many times. */
  publicAnswersAfter: number;
  publicProbes: number;
  /** What answers at the public name once a mapping exists. */
  publicBody: "hub" | "other";
  /** Hosts (other than the tailnet name) whose /health answers as a hub. */
  reachableHosts: Array<string>;
  failChange: { code: number; stderr: string } | null;
}

const makeWorld = (overrides: Partial<World> = {}): World => ({
  status: readyStatus,
  mappings: [],
  otherPorts: [],
  changes: [],
  statusReads: 0,
  localHubPort: 8080,
  publicAnswersAfter: 0,
  publicProbes: 0,
  publicBody: "hub",
  reachableHosts: [],
  failChange: null,
  ...overrides,
});

const serveConfigOf = (world: World) =>
  world.mappings.length === 0 && world.otherPorts.length === 0
    ? ""
    : JSON.stringify({
        TCP: Object.fromEntries(
          [...world.mappings.map((mapping) => mapping.port), ...world.otherPorts].map((port) => [
            String(port),
            { HTTPS: true },
          ]),
        ),
        Web: Object.fromEntries(
          world.mappings.map((mapping) => [
            `desk.tail.ts.net:${String(mapping.port)}`,
            { Handlers: { "/": { Proxy: mapping.proxy } } },
          ]),
        ),
        AllowFunnel: Object.fromEntries(
          world.mappings
            .filter((mapping) => mapping.funnel)
            .map((mapping) => [`desk.tail.ts.net:${String(mapping.port)}`, true]),
        ),
      });

const handleCommand = (world: World, args: ReadonlyArray<string>) => {
  if (args[0] === "status") {
    world.statusReads += 1;
    return { stdout: JSON.stringify(world.status) };
  }
  if (args[0] === "serve" && args[1] === "status") return { stdout: serveConfigOf(world) };

  world.changes.push([...args]);
  if (world.failChange !== null) return world.failChange;
  const [subcommand, ...rest] = args;
  const port = Number(rest.find((arg) => arg.startsWith("--https="))?.split("=")[1]);
  const existing = world.mappings.some((mapping) => mapping.port === port);
  if (rest.includes("off")) {
    if (!existing) return { code: 1, stderr: "error: handler does not exist" };
    world.mappings = world.mappings.filter((mapping) => mapping.port !== port);
    return {};
  }
  world.mappings = [
    ...world.mappings.filter((mapping) => mapping.port !== port),
    { port, proxy: rest[rest.length - 1] ?? "", funnel: subcommand === "funnel" },
  ];
  return {};
};

const spawnerFor = (world: World) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const { args } = command as unknown as { readonly args: ReadonlyArray<string> };
      const result = handleCommand(world, args) as {
        stdout?: string;
        stderr?: string;
        code?: number;
      };
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode(result.stdout ?? "")),
          stderr: Stream.make(encoder.encode(result.stderr ?? "")),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );

const httpFor = (world: World) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const url = new URL(request.url);
      const respond = (status: number, body: string) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status })));
      const hub = `{"ok":true,"protocolVersion":1}`;

      if (url.hostname === "127.0.0.1") {
        return Number(url.port) === world.localHubPort ? respond(200, hub) : respond(503, "");
      }
      if (url.hostname === "desk.tail.ts.net") {
        const port = url.port.length > 0 ? Number(url.port) : 443;
        if (!world.mappings.some((mapping) => mapping.port === port)) return respond(503, "");
        world.publicProbes += 1;
        if (world.publicProbes <= world.publicAnswersAfter) return respond(503, "");
        return respond(200, world.publicBody === "hub" ? hub : `{"hello":"world"}`);
      }
      return world.reachableHosts.includes(url.hostname) ? respond(200, hub) : respond(503, "");
    }),
  );

const networkFor = (world: World) =>
  TeamHubNetwork.layer.pipe(Layer.provide(Layer.mergeAll(spawnerFor(world), httpFor(world))));

const input = (overrides: Partial<TeamHubNetworkInput> = {}): TeamHubNetworkInput => ({
  hubPort: 8080,
  servePort: 443,
  exposure: "public",
  ...overrides,
});

const run = <A, E>(
  world: World,
  use: (network: TeamHubNetwork.TeamHubNetwork["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    return yield* use(yield* TeamHubNetwork.TeamHubNetwork);
  }).pipe(Effect.provide(networkFor(world)));

describe("TeamHubNetwork.state", () => {
  it.effect("names the one thing blocking a share", () =>
    Effect.gen(function* () {
      const cases = [
        [{ ...readyStatus, BackendState: "NeedsLogin" }, "signed-out"],
        [{ ...readyStatus, BackendState: "Stopped" }, "stopped"],
        [{ ...readyStatus, BackendState: "NeedsMachineAuth" }, "awaiting-approval"],
        [
          {
            ...readyStatus,
            CertDomains: null,
            Self: { DNSName: "desk.tail.ts.net.", CapMap: { "is-admin": null } },
          },
          "https-disabled",
        ],
        [
          { ...readyStatus, Self: { DNSName: "desk.tail.ts.net.", CapMap: { https: null } } },
          "funnel-not-allowed",
        ],
      ] as const;
      for (const [status, reason] of cases) {
        const state = yield* run(makeWorld({ status }), (network) => network.state(input()));
        assert.deepEqual(state, { status: "blocked", reason });
      }
    }),
  );

  it.effect("does not demand Funnel for a private share", () =>
    run(
      makeWorld({
        status: { ...readyStatus, Self: { DNSName: "desk.tail.ts.net.", CapMap: { https: null } } },
      }),
      (network) => network.state(input({ exposure: "private" })),
    ).pipe(Effect.map((state) => assert.deepEqual(state, { status: "ready", hubPort: 8080 }))),
  );

  it.effect("says Tailscale is missing when the CLI cannot be launched", () => {
    const layer = TeamHubNetwork.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.fail(
                PlatformError.systemError({
                  _tag: "NotFound",
                  module: "ChildProcess",
                  method: "spawn",
                }),
              ),
            ),
          ),
          httpFor(makeWorld()),
        ),
      ),
    );
    return Effect.gen(function* () {
      const network = yield* TeamHubNetwork.TeamHubNetwork;
      assert.deepEqual(yield* network.state(input()), {
        status: "blocked",
        reason: "not-installed",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("asks for the hub to be started before sharing", () =>
    run(makeWorld({ localHubPort: null }), (network) => network.state(input())).pipe(
      Effect.map((state) => assert.deepEqual(state, { status: "no-hub", hubPort: 8080 })),
    ),
  );

  it.effect("offers to share a free port with a hub behind it", () =>
    run(makeWorld(), (network) => network.state(input())).pipe(
      Effect.map((state) => assert.deepEqual(state, { status: "ready", hubPort: 8080 })),
    ),
  );

  it.effect("reports the address and whether it is public", () =>
    Effect.gen(function* () {
      const publicState = yield* run(
        makeWorld({ mappings: [{ port: 443, proxy: "http://127.0.0.1:8080", funnel: true }] }),
        (network) => network.state(input()),
      );
      assert.deepEqual(publicState, {
        status: "exposed",
        servePort: 443,
        exposure: "public",
        url: "https://desk.tail.ts.net/",
        reachable: true,
      });
      const privateState = yield* run(
        makeWorld({ mappings: [{ port: 8443, proxy: "http://127.0.0.1:8080", funnel: false }] }),
        (network) => network.state(input({ servePort: 8443 })),
      );
      assert.equal(privateState.status === "exposed" && privateState.exposure, "private");
    }),
  );

  it.effect("keeps a mapping to the hub port as ours while HTTPS is not answering yet", () =>
    run(
      makeWorld({
        mappings: [{ port: 443, proxy: "http://127.0.0.1:8080", funnel: false }],
        publicAnswersAfter: 99,
      }),
      (network) => network.state(input({ exposure: "private" })),
    ).pipe(
      Effect.map((state) => assert.equal(state.status === "exposed" && state.reachable, false)),
    ),
  );

  it.effect("calls any other occupant of the port a conflict", () =>
    Effect.gen(function* () {
      const elsewhere = yield* run(
        makeWorld({
          mappings: [{ port: 443, proxy: "http://127.0.0.1:3000", funnel: false }],
          publicBody: "other",
        }),
        (network) => network.state(input()),
      );
      assert.deepEqual(elsewhere, { status: "conflict", servePort: 443 });

      const tcpForward = yield* run(makeWorld({ otherPorts: [443] }), (network) =>
        network.state(input()),
      );
      assert.deepEqual(tcpForward, { status: "conflict", servePort: 443 });
    }),
  );
});

describe("TeamHubNetwork.expose", () => {
  it.effect("shares privately through Serve and returns the reachable address", () => {
    const world = makeWorld();
    return run(world, (network) => network.expose(input({ exposure: "private" }))).pipe(
      Effect.map((state) => {
        assert.deepEqual(world.changes, [
          ["serve", "--bg", "--https=443", "http://127.0.0.1:8080"],
        ]);
        assert.deepEqual(state, {
          status: "exposed",
          servePort: 443,
          exposure: "private",
          url: "https://desk.tail.ts.net/",
          reachable: true,
        });
      }),
    );
  });

  it.effect("shares publicly through Funnel on the chosen port", () => {
    const world = makeWorld();
    return run(world, (network) => network.expose(input({ servePort: 8443 }))).pipe(
      Effect.map((state) => {
        assert.deepEqual(world.changes, [
          ["funnel", "--bg", "--https=8443", "http://127.0.0.1:8080"],
        ]);
        assert.equal(state.status === "exposed" && state.exposure, "public");
      }),
    );
  });

  it.effect("waits for the HTTPS certificate instead of reporting it unreachable", () => {
    const world = makeWorld({ publicAnswersAfter: 4 });
    return Effect.gen(function* () {
      const network = yield* TeamHubNetwork.TeamHubNetwork;
      const fiber = yield* Effect.forkChild(network.expose(input({ exposure: "private" })));
      for (let tick = 0; tick < 8; tick += 1) {
        yield* TestClock.adjust(Duration.seconds(1));
      }
      const state = yield* Fiber.join(fiber);
      assert.equal(state.status === "exposed" && state.reachable, true);
    }).pipe(Effect.provide(networkFor(world)));
  });

  it.effect("is idempotent once the share is up", () => {
    const world = makeWorld({
      mappings: [{ port: 443, proxy: "http://127.0.0.1:8080", funnel: true }],
    });
    return run(world, (network) => network.expose(input())).pipe(
      Effect.map((state) => {
        assert.deepEqual(world.changes, []);
        assert.equal(state.status, "exposed");
      }),
    );
  });

  it.effect("switches between Serve and Funnel by turning one off first", () => {
    const world = makeWorld({
      mappings: [{ port: 443, proxy: "http://127.0.0.1:8080", funnel: false }],
    });
    return run(world, (network) => network.expose(input())).pipe(
      Effect.map((state) => {
        assert.deepEqual(world.changes, [
          ["serve", "--https=443", "off"],
          ["funnel", "--bg", "--https=443", "http://127.0.0.1:8080"],
        ]);
        assert.equal(state.status === "exposed" && state.exposure, "public");
      }),
    );
  });

  it.effect("never touches a port someone else is using, or a missing hub", () =>
    Effect.gen(function* () {
      const occupied = makeWorld({ otherPorts: [443] });
      assert.equal((yield* run(occupied, (network) => network.expose(input()))).status, "conflict");
      assert.deepEqual(occupied.changes, []);

      const noHub = makeWorld({ localHubPort: null });
      assert.equal((yield* run(noHub, (network) => network.expose(input()))).status, "no-hub");
      assert.deepEqual(noHub.changes, []);

      const blocked = makeWorld({ status: { ...readyStatus, BackendState: "Stopped" } });
      assert.equal((yield* run(blocked, (network) => network.expose(input()))).status, "blocked");
      assert.deepEqual(blocked.changes, []);
    }),
  );

  it.effect("turns CLI refusals into the problem the admin can fix", () =>
    Effect.gen(function* () {
      const cases = [
        ["Access denied: serve config denied", { status: "failed", reason: "permission-denied" }],
        ["something unexpected", { status: "failed", reason: "command-failed" }],
        [
          'Funnel not available; "funnel" node attribute not set.',
          { status: "blocked", reason: "funnel-not-allowed" },
        ],
        [
          "Funnel not available; HTTPS must be enabled.",
          { status: "blocked", reason: "https-disabled" },
        ],
      ] as const;
      for (const [stderr, expected] of cases) {
        const world = makeWorld({ failChange: { code: 1, stderr: `${stderr} tskey-auth-secret` } });
        const state = yield* run(world, (network) => network.expose(input()));
        assert.deepEqual(state, expected);
      }
    }),
  );
});

describe("TeamHubNetwork.unexpose", () => {
  it.effect("stops a private share with Serve alone", () => {
    const world = makeWorld({
      mappings: [{ port: 443, proxy: "http://127.0.0.1:8080", funnel: false }],
    });
    return run(world, (network) => network.unexpose(input({ exposure: "private" }))).pipe(
      Effect.map((state) => {
        assert.deepEqual(world.changes, [["serve", "--https=443", "off"]]);
        assert.deepEqual(state, { status: "ready", hubPort: 8080 });
      }),
    );
  });

  it.effect("stops a public share and tolerates the mapping already being gone", () => {
    const world = makeWorld({
      mappings: [{ port: 443, proxy: "http://127.0.0.1:8080", funnel: true }],
    });
    return run(world, (network) => network.unexpose(input())).pipe(
      Effect.map((state) => {
        assert.deepEqual(world.changes, [
          ["funnel", "--https=443", "off"],
          ["serve", "--https=443", "off"],
        ]);
        assert.deepEqual(state, { status: "ready", hubPort: 8080 });
      }),
    );
  });

  it.effect("leaves a mapping that is not a hub alone", () => {
    const world = makeWorld({
      mappings: [{ port: 443, proxy: "http://127.0.0.1:3000", funnel: false }],
      publicBody: "other",
    });
    return run(world, (network) => network.unexpose(input())).pipe(
      Effect.map((state) => {
        assert.deepEqual(world.changes, []);
        assert.equal(state.status, "conflict");
      }),
    );
  });
});

describe("TeamHubNetwork.check", () => {
  it.effect("accepts an address that answers as a hub", () =>
    Effect.gen(function* () {
      const world = makeWorld({ reachableHosts: ["192.168.1.20"] });
      const reachability = yield* run(world, (network) =>
        network.check("http://192.168.1.20:8080/join#token=x"),
      );
      assert.deepEqual(reachability, { reachable: true, tailnetHost: false, blocked: null });
      assert.equal(world.statusReads, 0);
    }),
  );

  it.effect("explains Tailscale only when the address is a tailnet one", () =>
    Effect.gen(function* () {
      const stopped = makeWorld({ status: { ...readyStatus, BackendState: "Stopped" } });
      assert.deepEqual(
        yield* run(stopped, (network) => network.check("https://other.tail.ts.net/join#token=x")),
        { reachable: false, tailnetHost: true, blocked: "stopped" },
      );
      assert.deepEqual(
        yield* run(makeWorld(), (network) => network.check("http://100.101.102.103:8080")),
        { reachable: false, tailnetHost: true, blocked: null },
      );

      const lan = makeWorld({ status: { ...readyStatus, BackendState: "Stopped" } });
      assert.deepEqual(yield* run(lan, (network) => network.check("http://192.168.1.20:8080")), {
        reachable: false,
        tailnetHost: false,
        blocked: null,
      });
      // Nothing about Tailscale was read for an address Tailscale cannot affect.
      assert.equal(lan.statusReads, 0);
    }),
  );

  it.effect("does not blame a member for HTTPS or Funnel setup they do not need", () =>
    Effect.gen(function* () {
      const httpsOff = makeWorld({
        status: {
          ...readyStatus,
          CertDomains: null,
          Self: { DNSName: "desk.tail.ts.net.", CapMap: { "is-admin": null } },
        },
      });
      assert.deepEqual(
        yield* run(httpsOff, (network) => network.check("https://other.tail.ts.net")),
        { reachable: false, tailnetHost: true, blocked: null },
      );
    }),
  );

  it.effect("rejects an address that is not http or https", () =>
    Effect.gen(function* () {
      const error = yield* run(makeWorld(), (network) => network.check("file:///etc/passwd")).pipe(
        Effect.flip,
      );
      assert.instanceOf(error, TeamHubNetwork.TeamHubNetworkInvalidUrlError);
    }),
  );
});
