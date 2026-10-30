import { describe, expect, it } from "vitest";
import { navigationItemsFor } from "./navigation";

describe("platform navigation", () => {
  it.each(["ios", "android"])("offers only remote Fleet on %s", (platform) => {
    const items = navigationItemsFor(platform);
    expect(items.find((item) => item.id === "agents")?.labelKey).toBe("agents.remoteFleet.title");
    expect(items.some((item) => item.id === "chat")).toBe(false);
  });

  it("keeps the local Agent Fleet and chat on desktop", () => {
    const items = navigationItemsFor("linux");
    expect(items.find((item) => item.id === "agents")?.labelKey).toBe("nav.agents");
    expect(items.some((item) => item.id === "chat")).toBe(true);
  });
});
