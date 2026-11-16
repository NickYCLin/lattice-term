import { describe, expect, it } from "vitest";
import { nativeHistoryItems, type ChatItem } from "./agentChat";
import { chatToolRows, commandExploration, parseToolCommands, readableToolOutput, sessionToolRows, toolHasProtectedContent } from "./toolPresentation";
import type { SessionConversationMessage } from "./useSessionConversation";

function message(name: string | null, text: string, callId: string, kind: "call" | "result"): SessionConversationMessage {
  return { role: "assistant", text, tool: { name, callId, kind } };
}
const code = 'text(await tools.exec_command({cmd:"ls",workdir:"/synthetic/project",max_output_tokens:2000}));';
const fixture: SessionConversationMessage[] = [
  { role: "user", text: "inspect" },
  message("functions.exec", code, "exec-1", "call"),
  message(null, "Script running with cell ID 1\nfirst", "exec-1", "result"),
  message("functions.wait", '{"cell_id":"1","max_tokens":2000}', "wait-1", "call"),
  message("text", 'second\nProcess exited with code 0', "wait-1", "result"),
  { role: "assistant", text: "finished" },
];

describe("static command summaries", () => {
  it("extracts code-mode commands and cwd without executing code", () => {
    expect(parseToolCommands("functions.exec", code)).toEqual([{ command: "ls", directory: "/synthetic/project" }]);
    expect(parseToolCommands("exec", "await tools.exec_command({cmd:'printf \\'hello\\'\\n',workdir: `/synthetic/project`});")).toEqual([{ command: "printf 'hello'\n", directory: "/synthetic/project" }]);
    expect(parseToolCommands("exec", 'text("tools.exec_command({cmd:\\"fake\\"})");')).toEqual([]);
    expect(parseToolCommands("exec", '// tools.exec_command({cmd:"fake"})\nawait tools.exec_command({cmd:"real"})')).toEqual([{ command: "real" }]);
  });
  it.each(['if (false) await tools.exec_command({cmd:"ls"});', 'await tools.exec_command({cmd: dynamic});', 'await tools.exec_command({cmd:"ls", ...unknown});', 'await tools.exec_command({cmd:"ls", cmd:unknown});', 'await tools.exec_command({cmd:"ls", [unknown]:true});', 'await tools.exec_command({cmd: "ls" + dynamic});', 'await tools.exec_command({cmd: `ls ${dynamic}`});', 'await tools.exec_command({cmd:"unterminated});'])('falls back for dynamic or malformed source: %s', source => {
    expect(parseToolCommands("exec", source)).toEqual([]);
  });
  it("keeps multiple static commands and argument boundaries", () => {
    expect(parseToolCommands("exec", 'await tools.exec_command({cmd:"ls"}); await tools.exec_command({cmd:"cat readme"});')).toHaveLength(2);
    expect(parseToolCommands("Bash", "ls -la")).toEqual([{ command:"ls -la" }]);
    expect(parseToolCommands("run_shell_command", '{"command":"ls"}')).toEqual([{ command:"ls" }]);
    expect(parseToolCommands("shell", '{"command":["bash","-lc","echo hello"]}')[0].command).toBe("bash -lc 'echo hello'");
    expect(parseToolCommands("command", '{"command":"ls","cwd":"/synthetic/work"}')[0]).toMatchObject({ command: "ls", directory: "/synthetic/work" });
  });
});

describe("native and app-server tool pairing", () => {
  it("merges explicit exec + wait + result into one logical command in both paths", () => {
    const native = sessionToolRows(fixture);
    const general = chatToolRows(nativeHistoryItems(fixture as Parameters<typeof nativeHistoryItems>[0], 0));
    for (const rows of [native, general]) {
      const tools = rows.filter(row => row.tool);
      expect(tools).toHaveLength(1);
      const tool = tools[0].tool!;
      expect(tool.commands).toEqual([{ command: "ls", directory: "/synthetic/project" }]);
      expect(tool.raw).toHaveLength(2);
      expect(tool.raw[0].input).toBe(code);
      expect(tool.raw[1].input).toContain('"cell_id":"1"');
      expect(tool.output).toContain("first"); expect(tool.output).toContain("second");
      expect(tool.meta?.exitCode).toBe(0); expect(tool.done).toBe(true);
      expect(tool.isError).toBe(false);
    }
    expect(native[1].aliases).toEqual(["1", "2", "3", "4"]);
  });
  it("does not infer associations across user turns or for unknown cells", () => {
    const next = [...fixture.slice(0, 3), { role: "user" as const, text: "next" }, ...fixture.slice(3)];
    expect(sessionToolRows(next).filter(row => row.tool)).toHaveLength(2);
    expect(sessionToolRows(fixture.map(row => row.text.includes('"cell_id"') ? { ...row, text: '{"cell_id":"other"}' } : row)).filter(row => row.tool)).toHaveLength(2);
  });
  it("preserves unparseable calls, orphan outputs and all raw content", () => {
    const rows = sessionToolRows([message("exec", "dynamicCall()", "a", "call"), message(null, "orphan", "b", "result")]);
    expect(rows).toHaveLength(2); expect(rows[0].tool?.commands).toEqual([]);
    expect(rows[0].tool?.raw[0].input).toBe("dynamicCall()");
    expect(rows[1].tool?.output).toBe("orphan");
  });
  it("keeps running and failed cells protected", () => {
    expect(toolHasProtectedContent(sessionToolRows(fixture.slice(0, 3))[1].tool!)).toBe(true);
    const rows = sessionToolRows(fixture.map(row => row.text.startsWith("second") ? { ...row, text: "Process exited with code 2\nfailed" } : row));
    expect(rows[1].tool?.isError).toBe(true); expect(toolHasProtectedContent(rows[1].tool!)).toBe(true);
  });
  it("never hides images, diffs or input/approval-like tools", () => {
    const base: Extract<ChatItem, { type: "tool" }> = { type: "tool", id: "t", name: "command", summary: "ls", output: "ok", done: true, isError: false };
    for (const change of [{ output: JSON.stringify({ exit_code:0, output:"--- a/file\n+++ b/file\n@@ -1 +1 @@\n-new" }) }, { images: ["/synthetic/image.png"] }, { output: "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-new" }, { name: "request_approval" }, { name: "mcp_unknown" }]) {
      expect(toolHasProtectedContent(chatToolRows([{ ...base, ...change }])[0].tool!)).toBe(true);
    }
  });
});

it("classifies conservative read-only exploration without classifying mutations", () => {
  expect(commandExploration("cat a b c")).toEqual({ files: 3, searches: 0, directories: 0 });
  expect(commandExploration('rg "needle" src')).toMatchObject({ searches: 1 });
  expect(commandExploration("cat /synthetic/README.md")).toMatchObject({ files: 1 });
  expect(commandExploration("sed -n '1,20p' /synthetic/readme")).toMatchObject({ files: 1 });
  expect(commandExploration("ls -la")).toMatchObject({ directories: 1 });
  for (const command of ["cat a > b", "ls && rm file", "sed -i s/a/b/ file", "find . -delete", 'rg --pre=script pattern', 'ls $(script)']) expect(commandExploration(command)).toBeUndefined();
});

it("collapses commentary while preserving the entire final answer block and protected text", () => {
  const rows = chatToolRows([
    { type:"user", id:"u", text:"inspect", at:0 },
    { type:"text", id:"progress", text:"checking files" },
    { type:"text", id:"question", text:"continue?" },
    { type:"tool", id:"cmd", name:"command", summary:"ls", output:"ok", done:true, isError:false },
    { type:"text", id:"final1", text:"first final paragraph" },
    { type:"text", id:"final2", text:"second final paragraph" },
  ]);
  expect(rows.find(row=>row.id==="progress")?.commentary).toBe(true);
  expect(rows.find(row=>row.id==="question")?.commentary).toBe(false);
  expect(rows.find(row=>row.id==="final1")?.commentary).toBe(false);
  expect(rows.find(row=>row.id==="final2")?.commentary).toBe(false);
});

it("decodes known output envelopes and preserves unknown result text", () => {
  const envelope = JSON.stringify({ chunk_id:"synthetic", exit_code:0, output:"one\ntwo" });
  expect(readableToolOutput("Script completed\nWall time: 1 seconds\nOutput:\n" + envelope)).toBe("one\ntwo");
  expect(readableToolOutput("Script running with cell ID 1\nfirst")).toBe("first");
  expect(readableToolOutput("plain output\nunchanged")).toBe("plain output\nunchanged");
  expect(readableToolOutput('{"output":"user data"}')).toBe('{"output":"user data"}');
});

it("keeps pending terminal processes running and merges only empty stdin polls by explicit session id", () => {
  for (const poll of [
    message("write_stdin", '{"session_id":7,"chars":""}', "poll", "call"),
    message("exec", 'text(await tools.write_stdin({session_id:7,chars:"",yield_time_ms:1000}));', "poll", "call"),
  ]) {
    const rows = [
      message("exec", code, "start", "call"),
      message(null, 'Script completed\nOutput:\n' + JSON.stringify({session_id:7,exit_code:null,output:"first"}), "start", "result"),
      poll,
      message(null, JSON.stringify({exit_code:0,output:"last"}), "poll", "result"),
    ];
    expect(sessionToolRows(rows.slice(0,2))[0].tool?.done).toBe(false);
    const merged = sessionToolRows(rows);
    expect(merged).toHaveLength(1); expect(merged[0].tool?.done).toBe(true);
    expect(merged[0].tool?.meta?.exitCode).toBe(0);
    expect(merged[0].tool?.raw).toHaveLength(2);
    const typed = rows.map(row => row === poll ? {...row,text:row.text.replace('"chars":""','"chars":"input"').replace('chars:""','chars:"input"')} : row);
    expect(sessionToolRows(typed)).toHaveLength(2);
  }
});
