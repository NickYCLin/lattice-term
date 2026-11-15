import { readStoredPreferences, type Preferences } from "./preferences";

interface InputKey {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  defaultPrevented?: boolean;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}
export function shouldSubmitChatInput(event: InputKey, shortcut = readStoredPreferences().chatSubmitShortcut): boolean {
  if (event.defaultPrevented || event.key !== "Enter" || event.shiftKey || event.altKey
    || event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229) return false;
  return shortcut === "enter" || Boolean(event.ctrlKey || event.metaKey);
}

export function preferChatSteer(thread: { definitionId: string; provider?: string; nativeSessionId?: string | null; runningTurnId?: string | null },
  preference: Preferences["chatWorkingSubmit"] = readStoredPreferences().chatWorkingSubmit): boolean {
  return preference === "steer" && thread.definitionId === "codex" && !(thread.provider === "cliproxyapi" && !thread.nativeSessionId) && !!thread.runningTurnId;
}
