import { describe, expect, it } from "vitest";
import { scopesForLevel } from "./mcpRemoteLevels";

const on = (sets: ReturnType<typeof scopesForLevel>) =>
  sets.map((scopes) => Object.entries(scopes).filter(([, value]) => value).map(([key]) => key));

describe("remote MCP levels", () => {
  it("gives a screen view or view plus input", () => {
    expect(on(scopesForLevel({ backend: "vnc" }, "view"))).toEqual([["screen"]]);
    expect(on(scopesForLevel({ backend: "rdp" }, "full"))).toEqual([["screen", "input"]]);
  });

  it("splits a Lattice Remote screen and its Fleet workspace into two grants", () => {
    expect(on(scopesForLevel({ backend: "remote", screen: true, fleet: true }, "full"))).toEqual([
      ["screen", "input"],
      ["fleetObserve", "fleetRead", "fleetControl", "fleetLaunch"],
    ]);
    expect(on(scopesForLevel({ backend: "remote", screen: false, fleet: true }, "view"))).toEqual([
      ["fleetObserve", "fleetRead"],
    ]);
    expect(scopesForLevel({ backend: "remote", screen: false }, "full")).toEqual([]);
  });

  it("keeps SSH and SFTP within what each backend can do", () => {
    expect(on(scopesForLevel({ backend: "ssh" }, "full"))).toEqual([["metrics", "command"]]);
    expect(on(scopesForLevel({ backend: "sftp" }, "view"))).toEqual([["list", "download"]]);
    expect(on(scopesForLevel({ backend: "sftp" }, "full"))).toEqual([["list", "upload", "download"]]);
  });
});
