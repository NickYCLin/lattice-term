import { allNodes, HostNode, props } from "../../agents/testFixtures/interactionDom";

/** Layout APIs used by a body-portalled menu in the lightweight React host. */
export function installMenuDom() {
  const saved = Object.getOwnPropertyDescriptors(HostNode.prototype);
  const properties = {
    getBoundingClientRect: { configurable: true, value: () => ({ top: 100, bottom: 130, right: 300 }) },
    scrollHeight: { configurable: true, get: () => 250 },
    contains: { configurable: true, value: function(this: HostNode, node: HostNode) { return allNodes(this).includes(node); } },
    querySelectorAll: { configurable: true, value: function(this: HostNode) { return allNodes(this).filter(node => props(node)?.role === "menuitem"); } },
  };
  Object.defineProperties(HostNode.prototype, properties);
  Object.assign(window, { innerWidth: 800, innerHeight: 600 });
  return () => {
    for (const key of Object.keys(properties)) {
      if (saved[key]) Object.defineProperty(HostNode.prototype, key, saved[key]);
      else Reflect.deleteProperty(HostNode.prototype, key);
    }
  };
}
