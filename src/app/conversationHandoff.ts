import type { MessageKey } from "../i18n/messages/zh-TW";

const failureKeys: Record<string, MessageKey> = {
  "handoff.waitingForIdentity": "terminal.handoff.waitingForIdentity",
  "handoff.waitingForTranscript": "terminal.handoff.waitingForTranscript",
  "handoff.noReadableMessages": "terminal.handoff.noReadableMessages",
  "handoff.accountUnavailable": "terminal.handoff.accountUnavailable",
  "handoff.sessionUnavailable": "terminal.handoff.sessionUnavailable",
  "handoff.unsupported": "terminal.handoff.unsupported",
};

export function handoffExportFailureKey(reason: unknown): MessageKey {
  const code = reason instanceof Error ? reason.message : String(reason);
  return Object.prototype.hasOwnProperty.call(failureKeys, code) ? failureKeys[code] : "terminal.handoff.exportFailed";
}
