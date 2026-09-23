import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { installFakeDom } from "./testFixtures/hookDom";
import { LOCAL_PROJECTS_KEY, useLocalProjects } from "./localProjects";

it("retains projects after the last CLI closes and after a new UI mount", async () => {
  const node = installFakeDom() as unknown as Element;
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  });
  vi.stubGlobal("addEventListener", vi.fn());
  vi.stubGlobal("removeEventListener", vi.fn());
  let root = createRoot(node);
  let api!: ReturnType<typeof useLocalProjects>;
  function Probe({ paths }: { paths: string[] }) { api = useLocalProjects(paths); return null; }
  try {
    await act(async () => { root.render(<Probe paths={["D:\\saved"]} />); });
    await act(async () => { root.render(<Probe paths={[]} />); });
    expect(api.directories).toEqual(["D:\\saved"]);
    await act(async () => { root.unmount(); });
    root = createRoot(node);
    await act(async () => { root.render(<Probe paths={[]} />); });
    expect(api.directories).toEqual(["D:\\saved"]);
    await act(async () => { api.remove("d:/saved"); });
    expect(api.directories).toEqual([]);
    expect(JSON.parse(values.get(LOCAL_PROJECTS_KEY)!).directories).toEqual([]);
  } finally {
    await act(async () => { root.unmount(); });
    vi.unstubAllGlobals();
  }
});
