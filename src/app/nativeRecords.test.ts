import { describe, expect, it } from "vitest";
import {
  maskNativeText,
  maskNativeValue,
  type NativeRecord,
} from "./nativeRecords";
import { nativeHistoryItems } from "./agentChat";
import { sessionToolRows } from "./toolPresentation";
const record = (
  kind: NativeRecord["kind"],
  extra: Partial<NativeRecord> = {},
): NativeRecord => ({
  id: "fake",
  turnId: "fake-turn",
  kind,
  text: "",
  isError: false,
  unreadable: false,
  ...extra,
});
describe("native record safety and compatibility", () => {
  it.each([
    "sk-ant-FAKE_SYNTHETIC_12345678901234567890",
    "AIzaFAKE_SYNTHETIC_12345678901234567890",
    "ghp_FAKESYNTHETIC12345678901234567890",
    "AKIAFAKE123456789012",
    "xoxb-FAKE-SYNTHETIC-1234567890",
    "Authorization: Bearer FAKE_SYNTHETIC",
    "https://fake:FAKE_SYNTHETIC@example.invalid/",
    "password=FAKE_SYNTHETIC",
    "-----BEGIN PRIVATE KEY-----\nFAKE_SYNTHETIC\n-----END PRIVATE KEY-----",
  ])("masks fake secret %s", (raw) => {
    const safe = maskNativeText(raw);
    expect(safe).not.toBe(raw);
    expect(safe).not.toContain("FAKE_SYNTHETIC");
  });
  it("masks nested credentials and PEM split across cached messages without changing input", () => {
    const input = {
      items: [
        { text: "-----BEGIN PRIVATE KEY-----" },
        { text: "short fake secret fragment" },
        { text: "-----END PRIVATE KEY-----after" },
      ],
      args: { api_key: "FAKE_KEY" },
    };
    const safe = maskNativeValue(input);
    expect(JSON.stringify(safe)).not.toContain("short fake secret");
    expect(safe.items[2].text).toBe("[REDACTED]after");
    expect(safe.args.api_key).toBe("[REDACTED]");
    expect(input.args.api_key).toBe("FAKE_KEY");
  });
  it("projects rich records into general chat and keeps historical approvals passive", () => {
    const messages = [
      {
        role: "assistant" as const,
        text: "public",
        record: record("reasoning", { text: "public" }),
      },
      {
        role: "assistant" as const,
        text: "--- a/f\n+++ b/f\n+safe",
        record: record("fileChange", {
          id: "diff",
          text: "--- a/f\n+++ b/f\n+safe",
        }),
      },
    ];
    expect(nativeHistoryItems(messages, 1).map((item) => item.type)).toEqual([
      "native",
      "native",
    ]);
  });
  it("reuses readable paired tool cards for normalized and legacy projections", () => {
    const call = record("tool", {
      callId: "call",
      name: "exec_command",
      input: '{"cmd":"ls"}',
      output: "one line",
      isError: true,
    });
    const messages = [
      {
        role: "assistant" as const,
        text: call.input!,
        tool: { callId: "call", name: "exec_command", kind: "call" as const },
        record: call,
      },
    ];
    const rows = sessionToolRows(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toMatchObject({
      output: "one line",
      done: true,
      isError: true,
    });
    const general = nativeHistoryItems(
      [
        ...messages,
        {
          role: "assistant",
          text: "one line",
          tool: { callId: "call", name: null, kind: "result" },
          record: { ...call, input: undefined },
        },
      ],
      1,
    );
    expect(general).toHaveLength(1);
    expect(general[0]).toMatchObject({
      type: "tool",
      output: "one line",
      isError: true,
    });
  });
});
it("does not classify native images, diffs or errors as collapsible commentary", () => {
  const messages = [
    { role: "assistant" as const, text: "early" },
    {
      role: "assistant" as const,
      text: '{"cmd":"ls"}',
      tool: { callId: "c", kind: "call" as const, name: "exec_command" },
    },
    { role: "assistant" as const, text: "", record: record("image") },
    {
      role: "assistant" as const,
      text: "--- a/f\n+++ b/f\n+safe",
      record: record("fileChange"),
    },
    {
      role: "assistant" as const,
      text: "failure",
      record: record("system", { isError: true }),
    },
    { role: "assistant" as const, text: "final" },
  ];
  const rows = sessionToolRows(messages);
  expect(
    rows.filter((row) => row.value.record).every((row) => !row.commentary),
  ).toBe(true);
});
