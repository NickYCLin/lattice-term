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
