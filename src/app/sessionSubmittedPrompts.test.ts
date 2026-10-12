import { describe, expect, it } from "vitest";
import { recordSessionSubmission, reconcileSessionSubmissions, replaceSessionSubmission, sessionSubmittedPrompts, sessionSubmissionsNotQueued } from "./sessionSubmittedPrompts";

const user = (text: string) => ({ role: "user" as const, text });

describe("session submission receipts", () => {
  it("keeps complete text and attachment notes until the selected transcript records them", () => {
    const text = '第一行\n第二行 [LatticeTerm attachments: screenshot.png]';
    recordSessionSubmission("receipt-full", text, []);
    expect(sessionSubmittedPrompts("receipt-full")[0].text).toBe(text);
    reconcileSessionSubmissions("other-session", [user(text)]);
    expect(sessionSubmittedPrompts("receipt-full")).toHaveLength(1);
    reconcileSessionSubmissions("receipt-full", [user(text)]);
    expect(sessionSubmittedPrompts("receipt-full")).toEqual([]);
  });

  it("does not mistake an older identical message for the new submission", () => {
    recordSessionSubmission("receipt-repeat", "same", [user("same")]);
    recordSessionSubmission("receipt-repeat", "same", [user("same")]);
    reconcileSessionSubmissions("receipt-repeat", [user("same"), user("same")]);
    expect(sessionSubmittedPrompts("receipt-repeat")).toHaveLength(1);
    reconcileSessionSubmissions("receipt-repeat", [user("same"), user("same"), user("same")]);
    expect(sessionSubmittedPrompts("receipt-repeat")).toEqual([]);
  });

  it("only hides the queued copies, not an identical message already dispatched", () => {
    recordSessionSubmission("receipt-dispatch", "same", []);
    recordSessionSubmission("receipt-dispatch", "same", []);
    const pending = sessionSubmittedPrompts("receipt-dispatch");
    expect(sessionSubmissionsNotQueued(pending, [{ text: "same" }])).toEqual([pending[0]]);
    reconcileSessionSubmissions("receipt-dispatch", [user("same"), user("same")]);
  });

  it("reconciles an edit against the new text without matching its older history", () => {
    recordSessionSubmission("receipt-edit", "old", [user("new")]);
    replaceSessionSubmission("receipt-edit", "old", "new");
    reconcileSessionSubmissions("receipt-edit", [user("new")]);
    expect(sessionSubmittedPrompts("receipt-edit")).toHaveLength(1);
    replaceSessionSubmission("receipt-edit", "new", null);
    expect(sessionSubmittedPrompts("receipt-edit")).toEqual([]);
  });
});
