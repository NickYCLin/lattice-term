import { expect, it } from "vitest";
import { HostNode } from "./interactionDom";

it("moves existing children instead of duplicating them when React reorders a list", () => {
  const parent = new HostNode("DIV", {});
  const first = new HostNode("SPAN", {});
  const second = new HostNode("SPAN", {});
  parent.appendChild(first);
  parent.appendChild(second);
  parent.appendChild(first);
  expect(parent.childNodes).toEqual([second, first]);
  parent.insertBefore(first, second);
  expect(parent.childNodes).toEqual([first, second]);
  parent.insertBefore(first, first);
  expect(parent.childNodes).toEqual([first, second]);
  const other = new HostNode("DIV", {});
  other.appendChild(second);
  expect(parent.childNodes).toEqual([first]);
  expect(other.childNodes).toEqual([second]);
  expect(second.parentNode).toBe(other);
});
