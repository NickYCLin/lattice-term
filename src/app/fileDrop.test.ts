import { describe, expect, it } from "vitest";
import { pickDropTarget } from "./fileDrop";

function element(parent?: HTMLElement): HTMLElement {
  const node = { parent, contains(other: unknown): boolean { return other === node || !!other && node.contains((other as { parent?: HTMLElement }).parent); } };
  return node as unknown as HTMLElement;
}
function target(node: HTMLElement, enabled = true) { return { element: () => node, enabled: () => enabled }; }

describe("native drop routing", () => {
  it("uses the innermost hit target independently of registration order", () => {
    const outer = element(), inner = element(outer), hit = element(inner);
    const parent = target(outer), child = target(inner);
    expect(pickDropTarget([parent, child], hit)).toBe(child);
    expect(pickDropTarget([child, parent], hit)).toBe(child);
  });
  it("does not route a disabled field to an enclosing upload pane", () => {
    const outer = element(), inner = element(outer);
    expect(pickDropTarget([target(outer), target(inner, false)], inner)).toBeUndefined();
  });
  it("ignores an unrelated pane, modal scrim and missing hit", () => {
    const entries = [target(element())];
    expect(pickDropTarget(entries, element())).toBeUndefined();
    expect(pickDropTarget(entries, null)).toBeUndefined();
  });
});
