import { expect, it } from "vitest";
import { handoffExportFailureKey } from "./conversationHandoff";

it.each(["waitingForIdentity", "waitingForTranscript", "noReadableMessages", "accountUnavailable", "sessionUnavailable", "unsupported"])
  ("keeps the handoff refusal reason: %s", reason => {
    expect(handoffExportFailureKey("handoff." + reason)).toBe("terminal.handoff." + reason);
    expect(handoffExportFailureKey(new Error("handoff." + reason))).toBe("terminal.handoff." + reason);
  });

it.each([null, undefined, "unknown", "__proto__", "constructor"])
  ("does not expose an unknown backend error: %s", reason => {
    expect(handoffExportFailureKey(reason)).toBe("terminal.handoff.exportFailed");
  });
