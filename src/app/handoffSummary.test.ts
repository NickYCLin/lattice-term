import { expect, it } from "vitest";
import { handoffSummary } from "./handoffSummary";

it("keeps visible progress and references but removes recognizable credential shapes", () => {
  expect(handoffSummary("Goal: fixture\ncommit: abc123\npassword=synthetic-secret\napi_key: sk-synthetic1234567890"))
    .toBe("Goal: fixture\ncommit: abc123\npassword=[redacted]\napi_key: [redacted]");
  expect(handoffSummary("x".repeat(20000))).toHaveLength(16000);
});
