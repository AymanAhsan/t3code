import { describe, expect, it } from "vite-plus/test";

import { parseTeamHubLink, withTeamHubOrigin } from "./teamHub.ts";

describe("withTeamHubOrigin", () => {
  it("re-points a setup link at the shared address and keeps its token", () => {
    const link = parseTeamHubLink("http://localhost:8080/setup#token=abc%2Bdef");
    expect(link).toEqual({ url: "http://localhost:8080", token: "abc+def" });
    expect(withTeamHubOrigin(link!, "https://desk.tail.ts.net/")).toEqual({
      url: "https://desk.tail.ts.net",
      token: "abc+def",
    });
  });

  it("drops any path or port detail down to the origin", () => {
    expect(
      withTeamHubOrigin(
        { url: "http://localhost:8080", token: "t" },
        "https://desk.tail.ts.net:8443/x?y=1",
      ),
    ).toEqual({ url: "https://desk.tail.ts.net:8443", token: "t" });
  });

  it("rejects an address that is not http or https", () => {
    expect(
      withTeamHubOrigin({ url: "http://localhost:8080", token: "t" }, "ftp://example.test"),
    ).toBeNull();
    expect(withTeamHubOrigin({ url: "http://localhost:8080", token: "t" }, "not a url")).toBeNull();
  });
});
