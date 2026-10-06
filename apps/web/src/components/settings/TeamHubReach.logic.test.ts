import type { TeamHubNetworkBlockedReason } from "@t3tools/contracts/teamHub";
import { describe, expect, it } from "vite-plus/test";

import {
  hubStartCommand,
  isTailscaleShareUrl,
  nextSharePort,
  normalizeHubAddress,
  presentNetworkState,
  presentReachability,
  servePortOfUrl,
  shareCommand,
  type ReachContext,
} from "./TeamHubReach.logic";

const context: ReachContext = { exposure: "public", hubPort: 8080, servePort: 443 };

const BLOCKED_REASONS: ReadonlyArray<TeamHubNetworkBlockedReason> = [
  "not-installed",
  "daemon-not-running",
  "signed-out",
  "stopped",
  "awaiting-approval",
  "https-disabled",
  "funnel-not-allowed",
];

describe("presentNetworkState", () => {
  it("gives every blocked reason a fix and a way to check again", () => {
    for (const reason of BLOCKED_REASONS) {
      const presentation = presentNetworkState({ status: "blocked", reason }, context);
      expect(presentation.title.length).toBeGreaterThan(0);
      expect(presentation.actions.some((action) => action.kind === "retry")).toBe(true);
    }
  });

  it("links the two problems that can only be fixed in a browser", () => {
    const hrefOf = (reason: TeamHubNetworkBlockedReason) =>
      presentNetworkState({ status: "blocked", reason }, context).actions.flatMap((action) =>
        action.kind === "link" ? [action.href] : [],
      );
    expect(hrefOf("https-disabled")).toEqual(["https://login.tailscale.com/admin/dns"]);
    expect(hrefOf("not-installed")).toEqual(["https://tailscale.com/download"]);
    expect(hrefOf("funnel-not-allowed")).toEqual(["https://tailscale.com/kb/1223/funnel"]);
  });

  it("warns before a public share and offers the matching button", () => {
    const publicReady = presentNetworkState({ status: "ready", hubPort: 8080 }, context);
    expect(publicReady.tone).toBe("warning");
    expect(publicReady.actions).toEqual([{ kind: "share", label: "Share publicly" }]);

    const privateReady = presentNetworkState(
      { status: "ready", hubPort: 8080 },
      { ...context, exposure: "private" },
    );
    expect(privateReady.tone).toBe("info");
    expect(privateReady.actions).toEqual([{ kind: "share", label: "Share on my tailnet" }]);
  });

  it("tells the admin how to start the hub on the port they chose", () => {
    const presentation = presentNetworkState({ status: "no-hub", hubPort: 9000 }, context);
    expect(presentation.actions[0]).toEqual({
      kind: "copy",
      label: "Copy start command",
      value: "docker run -d -p 9000:8080 -v hub-data:/data t3-team-hub",
    });
  });

  it("waits on the certificate rather than reporting a failure", () => {
    const waiting = presentNetworkState(
      {
        status: "exposed",
        servePort: 443,
        exposure: "public",
        url: "https://a/",
        reachable: false,
      },
      context,
    );
    expect(waiting.tone).toBe("info");
    expect(waiting.title).toContain("certificate");
  });

  it("offers another port when this one is taken", () => {
    const conflict = presentNetworkState({ status: "conflict", servePort: 443 }, context);
    expect(conflict.actions).toEqual([
      { kind: "use-port", label: "Use port 8443", servePort: 8443 },
    ]);
  });

  it("hands over the exact command when Tailscale refuses", () => {
    const failed = presentNetworkState(
      { status: "failed", reason: "permission-denied" },
      { exposure: "private", hubPort: 8080, servePort: 8443 },
    );
    expect(failed.tone).toBe("error");
    expect(failed.actions[0]).toEqual({
      kind: "copy",
      label: "Copy command",
      value: "tailscale serve --bg --https=8443 http://127.0.0.1:8080",
    });
  });
});

describe("presentReachability", () => {
  it("confirms a reachable hub", () => {
    expect(presentReachability({ reachable: true, tailnetHost: true, blocked: null }).tone).toBe(
      "success",
    );
  });

  it("names the Tailscale problem when that is why a tailnet hub is unreachable", () => {
    const presentation = presentReachability({
      reachable: false,
      tailnetHost: true,
      blocked: "stopped",
    });
    expect(presentation.title).toContain("Tailscale is turned off");
    expect(presentation.actions.some((action) => action.kind === "retry")).toBe(true);
  });

  it("points at the admin when Tailscale is fine but the hub is not reachable", () => {
    const presentation = presentReachability({
      reachable: false,
      tailnetHost: true,
      blocked: null,
    });
    expect(presentation.detail).toContain("ask the admin");
  });

  it("stays generic for an address Tailscale has nothing to do with", () => {
    const presentation = presentReachability({
      reachable: false,
      tailnetHost: false,
      blocked: null,
    });
    expect(presentation.title).not.toContain("Tailscale");
  });
});

describe("share helpers", () => {
  it("builds the Funnel and Serve commands", () => {
    expect(shareCommand(context)).toBe("tailscale funnel --bg --https=443 http://127.0.0.1:8080");
    expect(shareCommand({ ...context, exposure: "private" })).toBe(
      "tailscale serve --bg --https=443 http://127.0.0.1:8080",
    );
  });

  it("cycles through the ports both Serve and Funnel accept", () => {
    expect(nextSharePort(443)).toBe(8443);
    expect(nextSharePort(8443)).toBe(10000);
    expect(nextSharePort(10000)).toBe(443);
    expect(nextSharePort(9999)).toBe(443);
  });

  it("reads the port out of a hub address", () => {
    expect(servePortOfUrl("https://desk.tail.ts.net")).toBe(443);
    expect(servePortOfUrl("https://desk.tail.ts.net:8443/")).toBe(8443);
    expect(servePortOfUrl("not a url")).toBe(443);
  });

  it("only treats *.ts.net addresses as Tailscale shares", () => {
    expect(isTailscaleShareUrl("https://Desk.Tail.ts.net/")).toBe(true);
    expect(isTailscaleShareUrl("http://192.168.1.20:8080")).toBe(false);
    expect(isTailscaleShareUrl("http://100.101.102.103:8080")).toBe(false);
  });

  it("keeps only the origin of a hub address a person typed", () => {
    expect(normalizeHubAddress(" https://desk.tail.ts.net/setup#token=x ")).toBe(
      "https://desk.tail.ts.net",
    );
    expect(normalizeHubAddress("desk.tail.ts.net:8443")).toBe("https://desk.tail.ts.net:8443");
    expect(normalizeHubAddress("http://100.101.102.103:8080/")).toBe("http://100.101.102.103:8080");
  });

  it("rejects what cannot be a hub address", () => {
    expect(normalizeHubAddress("")).toBeNull();
    expect(normalizeHubAddress("ftp://desk.tail.ts.net")).toBeNull();
    expect(normalizeHubAddress("not a url")).toBeNull();
  });

  it("maps the start command to the container's fixed port", () => {
    expect(hubStartCommand(8080)).toBe("docker run -d -p 8080:8080 -v hub-data:/data t3-team-hub");
  });
});
