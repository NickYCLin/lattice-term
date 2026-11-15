interface ApprovalKey {
  key: string; shiftKey?: boolean; defaultPrevented?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
  target?: unknown;
}
/** Approval shortcuts act only inside a deliberately focused card. */
export function approvalShortcut(event: ApprovalKey, cardFocused: boolean): "allow" | "deny" | null {
  const target = event.target as { tagName?: string; isContentEditable?: boolean } | null;
  if (event.defaultPrevented || event.shiftKey || target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName?.toUpperCase() ?? "")
    || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229) return null;
  if (event.key === "Escape") return "deny";
  return event.key === "Enter" && cardFocused ? "allow" : null;
}
