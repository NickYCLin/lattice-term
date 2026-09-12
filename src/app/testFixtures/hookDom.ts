/** Minimal DOM for hooks that render no elements. */
function fakeNode(): Record<string, unknown> {
  const node: Record<string, unknown> = {
    nodeType: 1,
    nodeName: "DIV",
    tagName: "DIV",
    childNodes: [] as unknown[],
    style: {},
    ownerDocument: null,
    firstChild: null,
    textContent: "",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    appendChild(child: Record<string, unknown>) {
      (node.childNodes as unknown[]).push(child);
      child.parentNode = node;
      return child;
    },
    removeChild(child: unknown) {
      node.childNodes = (node.childNodes as unknown[]).filter((entry) => entry !== child);
      return child;
    },
    insertBefore(child: unknown) {
      (node.childNodes as unknown[]).push(child);
      return child;
    },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    removeAttribute() {},
  };
  return node;
}

export function installFakeDom() {
  const globals = globalThis as Record<string, unknown>;
  if (globals.__latticeFakeDom) return globals.__latticeFakeDom as Record<string, unknown>;
  const document: Record<string, unknown> = {
    nodeType: 9,
    createElement: () => fakeNode(),
    createTextNode: (text: string) => ({ nodeType: 3, textContent: text }),
    createComment: () => ({ nodeType: 8 }),
    documentElement: fakeNode(),
    activeElement: null,
    addEventListener() {},
    removeEventListener() {},
  };
  const root = fakeNode();
  root.ownerDocument = document;
  document.body = root;
  (document.documentElement as Record<string, unknown>).ownerDocument = document;
  document.defaultView = globalThis;
  globals.document = document;
  globals.window = globalThis;
  class Stub {}
  for (const name of ["HTMLElement", "Element", "Node", "HTMLIFrameElement", "Event", "Text", "Comment"]) {
    globals[name] = Stub;
  }
  globals.__TAURI_INTERNALS__ = {};
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  globals.__latticeFakeDom = root;
  return root;
}
