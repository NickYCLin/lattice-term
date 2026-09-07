import { describe, expect, it } from "vitest";
import { claudeCodeCommand, codexToml, mcpServersJson, shellWord } from "./agentMcpConfig";

const launch = {
  command: "/opt/Lattice Term/lattice-term",
  args: ["mcp", "--data-dir", "/home/me/.local/share/io.github.nickyclin.latticeterm"],
};

describe("agentMcpConfig", () => {
  it("quotes only the words a shell would split", () => {
    expect(shellWord("/usr/bin/lattice-term")).toBe("/usr/bin/lattice-term");
    expect(shellWord("/opt/Lattice Term/x")).toBe("'/opt/Lattice Term/x'");
    expect(shellWord("it's")).toBe(`'it'\\''s'`);
  });

  it("renders the same launch line for each client", () => {
    expect(claudeCodeCommand(launch)).toBe(
      "claude mcp add latticeterm -- '/opt/Lattice Term/lattice-term' mcp --data-dir /home/me/.local/share/io.github.nickyclin.latticeterm",
    );
    expect(codexToml(launch)).toBe(
      [
        "[mcp_servers.latticeterm]",
        'command = "/opt/Lattice Term/lattice-term"',
        'args = ["mcp", "--data-dir", "/home/me/.local/share/io.github.nickyclin.latticeterm"]',
      ].join("\n"),
    );
    expect(JSON.parse(mcpServersJson(launch))).toEqual({
      mcpServers: { latticeterm: { command: launch.command, args: launch.args } },
    });
  });
});
