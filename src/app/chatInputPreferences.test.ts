import { expect, it } from "vitest";
import { preferChatSteer, shouldSubmitChatInput } from "./chatInputPreferences";
import { sanitizePreferences } from "./preferences";
it("keeps legacy send behavior and bounds stored choices", () => {
  expect(sanitizePreferences({})).toMatchObject({ chatSubmitShortcut: "enter", chatWorkingSubmit: "queue" });
  expect(sanitizePreferences({ chatSubmitShortcut: "invalid", chatWorkingSubmit: "invalid" } as never)).toMatchObject({ chatSubmitShortcut: "enter", chatWorkingSubmit: "queue" });
  expect(sanitizePreferences({ chatSubmitShortcut: "modifier-enter", chatWorkingSubmit: "steer" })).toMatchObject({ chatSubmitShortcut: "modifier-enter", chatWorkingSubmit: "steer" });
});
it("distinguishes plain Enter and modifier Enter without sending IME candidates", () => {
  expect(shouldSubmitChatInput({ key: "Enter" }, "enter")).toBe(true);
  expect(shouldSubmitChatInput({ key: "Enter" }, "modifier-enter")).toBe(false);
  for (const key of ["ctrlKey", "metaKey"] as const) {
    expect(shouldSubmitChatInput({ key: "Enter", [key]: true }, "modifier-enter")).toBe(true);
  }
  for (const event of [{ shiftKey: true }, { altKey: true }, { defaultPrevented: true }, { nativeEvent: { isComposing: true } }, { nativeEvent: { keyCode: 229 } }]) {
    expect(shouldSubmitChatInput({ key: "Enter", ...event }, "enter")).toBe(false);
    expect(shouldSubmitChatInput({ key: "Enter", ctrlKey: true, ...event }, "modifier-enter")).toBe(false);
  }
});
it("steers only a running native Codex chat, retaining queue semantics elsewhere", () => {
  expect(preferChatSteer({ definitionId: "codex", runningTurnId: "turn" }, "steer")).toBe(true);
  expect(preferChatSteer({ definitionId: "codex", runningTurnId: "turn" }, "queue")).toBe(false);
  expect(preferChatSteer({ definitionId: "codex" }, "steer")).toBe(false);
  expect(preferChatSteer({ definitionId: "codex", provider: "cliproxyapi", nativeSessionId: "source", runningTurnId: "turn" }, "steer")).toBe(true);
  expect(preferChatSteer({ definitionId: "claude", runningTurnId: "turn" }, "steer")).toBe(false);
  expect(preferChatSteer({ definitionId: "codex", provider: "cliproxyapi", runningTurnId: "turn" }, "steer")).toBe(false);
});
