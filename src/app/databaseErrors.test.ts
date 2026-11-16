import { expect, it } from "vitest";
import { databaseErrorMessage } from "./databaseErrors";
import { zhTW } from "../i18n/messages/zh-TW";
import { en } from "../i18n/messages/en";

it.each(["connection", "authentication", "databaseAccess", "tls", "other"] as const)(
  "translates safe driver category %s in Traditional Chinese and English", category => {
    const key = `database.error.${category}` as const;
    for (const messages of [zhTW, en]) {
      expect(databaseErrorMessage(key, key => messages[key])).toBe(messages[key]);
      expect(databaseErrorMessage(new Error(key), key => messages[key])).toBe(messages[key]);
      expect(databaseErrorMessage(`Error: ${key}`, key => messages[key])).toBe(messages[key]);
    }
  });
it("does not echo malformed driver diagnostics or lose transaction safety advice", () => {
  const t = (key: keyof typeof en) => en[key];
  for (const value of ["database.error.unknown REDACTION_SENTINEL", "Error: database.error.connection password=REDACTION_SENTINEL"]) {
    const message = databaseErrorMessage(value, t);
    expect(message).toBe(en["database.error.other"]);
    expect(message).not.toContain("REDACTION_SENTINEL");
  }
  const uncertain = "提交結果無法確認，請先查詢資料，不要直接重送 SQL。";
  expect(databaseErrorMessage(uncertain, t)).toBe(uncertain);
});
