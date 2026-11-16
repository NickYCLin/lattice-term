import { expect, it } from "vitest";
import { approvalShortcut } from "./approvalShortcut";
it("accepts only a deliberate card Enter and rejects with Escape", () => {
  expect(approvalShortcut({ key: "Enter" }, true)).toBe("allow");
  expect(approvalShortcut({ key: "Enter" }, false)).toBeNull();
  expect(approvalShortcut({ key: "Escape" }, false)).toBe("deny");
  for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) expect(approvalShortcut({ key: "Enter", target: { tagName } }, true)).toBeNull();
  expect(approvalShortcut({ key: "Enter", nativeEvent: { isComposing: true } }, true)).toBeNull();
  expect(approvalShortcut({ key: "Escape", ctrlKey: true }, true)).toBeNull();
});
it("uses Shift+Enter for session scope only on a capable focused card", () => {
  expect(approvalShortcut({ key: "Enter", shiftKey: true }, true, true)).toBe("session");
  expect(approvalShortcut({ key: "Enter", shiftKey: true }, true, false)).toBeNull();
  expect(approvalShortcut({ key: "Enter", shiftKey: true }, false, true)).toBeNull();
  expect(approvalShortcut({ key: "Escape", shiftKey: true }, true, true)).toBeNull();
  for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) expect(approvalShortcut({ key: "Enter", shiftKey: true, target: { tagName } }, true, true)).toBeNull();
  expect(approvalShortcut({ key: "Enter", shiftKey: true, nativeEvent: { isComposing: true } }, true, true)).toBeNull();
});
