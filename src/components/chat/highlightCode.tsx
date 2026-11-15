import { common, createLowlight } from "lowlight";
import type { ReactNode } from "react";

const highlighter = createLowlight(common);
type HighlightNode = ReturnType<typeof highlighter.highlight>["children"][number];
function render(nodes: readonly HighlightNode[]): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.type === "text") return node.value;
    if (node.type !== "element") return null;
    const classes = node.properties.className;
    return <span key={index} className={Array.isArray(classes) ? classes.join(" ") : undefined}>{render(node.children)}</span>;
  });
}

/** Render tokens as React nodes; code never passes through an HTML sink. */
export function highlightCode(text: string, language: string): ReactNode {
  if (!highlighter.registered(language)) return text;
  return render(highlighter.highlight(language, text).children);
}
