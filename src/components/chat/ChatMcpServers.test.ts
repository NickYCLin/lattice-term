import { describe, expect, it } from "vitest";
import { mcpAddCommand, mcpCommands } from "./ChatMcpServers";

describe("MCP server commands", () => {
  it("uses each CLI's own remove and login commands", () => {
    expect(mcpCommands("claude", { name: "github", scope: "local", transport: "http" })).toEqual({
      remove: "claude mcp remove github -s local",
      login: "claude  →  /mcp",
    });
    expect(mcpCommands("codex", { name: "remote", scope: "user", transport: "http" }).login).toBe("codex mcp login remote");
    expect(mcpCommands("codex", { name: "repl", scope: "user", transport: "stdio" }).login).toBeNull();
    expect(mcpCommands("gemini", { name: "a", scope: "user", transport: "stdio" }).remove).toBe("gemini mcp remove a --scope user");
    expect(mcpAddCommand("codex")).toContain("codex mcp add");
  });

  it("quotes a server name that a shell would split", () => {
    expect(mcpCommands("codex", { name: "my server; rm -rf", scope: "user", transport: "stdio" }).remove).toBe(
      'codex mcp remove "my server; rm -rf"',
    );
  });
});
