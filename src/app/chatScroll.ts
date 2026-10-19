export function isChatAtBottom(node: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">): boolean {
  return node.scrollHeight - node.scrollTop - node.clientHeight <= 1;
}
