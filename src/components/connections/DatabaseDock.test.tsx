import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { installFakeDom } from "../../app/testFixtures/hookDom";
import { DatabaseDock } from "./DatabaseDock";
const mounted = vi.hoisted(() => vi.fn());
vi.mock("./DatabaseManager", () => ({ DatabaseManager: () => {
  const [draft, setDraft] = useState("");
  useEffect(() => { mounted(); }, []);
  return <input aria-label="測試 SQL 草稿" value={draft} onChange={event => setDraft(event.target.value)} />;
} }));
type Host = Record<string, unknown> & { childNodes?: Host[] };
type Props = { "aria-label"?: string; value?: string; onChange?: (event: { target: { value: string } }) => void };
function props(node: Host): Props[] {
  const key = Object.keys(node).find(k => k.startsWith("__reactProps$"));
  return [...(key ? [node[key] as Props] : []), ...(node.childNodes ?? []).flatMap(props)];
}
it("preserves one mounted SQL workspace and its unsaved draft across views and collapse", async () => {
  const container = installFakeDom(); const root = createRoot(container as unknown as Element);
  const render = async (open: boolean, visible: boolean) => { await act(async () => root.render(<DatabaseDock profiles={[]} open={open} visible={visible} onClose={() => {}} />)); };
  try {
    await render(false, true); expect(mounted).not.toHaveBeenCalled();
    await render(true, true); expect(mounted).toHaveBeenCalledTimes(1);
    await act(async () => props(container).find(p => p["aria-label"] === "測試 SQL 草稿")!.onChange!({target:{value:"SELECT 'keep draft'"}}));
    await render(true, false); await render(false, true); await render(true, true);
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(props(container).find(p => p["aria-label"] === "測試 SQL 草稿")!.value).toBe("SELECT 'keep draft'");
  } finally { await act(async () => root.unmount()); }
});
