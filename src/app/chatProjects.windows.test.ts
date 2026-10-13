import { expect, it } from "vitest";
import { chatProjectKey, chatProjects } from "./chatProjects";
import { clearChatProjectDefaults, loadChatProjectDefaults, saveChatProjectDefaults } from "./chatProjectDefaults";

const settings = { definitionId: "codex" as const, model: "fixture-model", permission: "readOnly" as const, accountProfileId: null };
function storage() {
  const values = new Map<string, string>();
  return { values, get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
}
const legacyKey = (path: string) => "latticeterm.chatProjectDefaults.v1:" + encodeURIComponent(path);

it("groups equivalent Windows paths without changing the displayed path", () => {
  const projects = chatProjects([{ workingDirectory: "C:\\Work\\LatticeTerm", updatedAt: 1 },
    { workingDirectory: "c:/work/latticeterm", updatedAt: 2 }]);
  expect(projects).toEqual([{ directory: "C:\\Work\\LatticeTerm", name: "LatticeTerm", threads: 2, updatedAt: 2 }]);
  expect(chatProjectKey("\\\\?\\UNC\\Server\\Share\\app\\")).toBe(chatProjectKey("//server/share/app"));
});
it.each(["C:\\", "C:/"])("preserves the absolute drive root %s", path => {
  expect(chatProjects([{ workingDirectory: path, updatedAt: 1 }])[0].directory).toMatch(/^[a-z]:[\\/]$/i);
  expect(chatProjectKey(path)).not.toBe(chatProjectKey("C:"));
});
it("uses new and legacy defaults through equivalent Windows paths", () => {
  const saved = storage();
  saveChatProjectDefaults(saved, "C:\\Work\\LatticeTerm", settings);
  expect(loadChatProjectDefaults(saved, "c:/work/latticeterm")).toEqual(settings);
  const old = storage();
  old.setItem(legacyKey("C:\\Work\\LatticeTerm"), JSON.stringify(settings));
  expect(loadChatProjectDefaults(old, "c:/work/latticeterm")).toEqual(settings);
  expect(old.values.size).toBe(1);
});
it("keeps POSIX case-sensitive paths separate", () => {
  expect(chatProjects([{ workingDirectory: "/work/LatticeTerm", updatedAt: 1 },
    { workingDirectory: "/work/latticeterm", updatedAt: 2 }])).toHaveLength(2);
});
it.each(["C:/", "c:/"])("does not apply an ambiguous legacy permission to root %s", root => {
  const saved = storage();
  saved.setItem(legacyKey("C:"), JSON.stringify({ ...settings, permission: "full" }));
  expect(() => loadChatProjectDefaults(saved, root)).toThrow(/conflict/i);
  expect(saved.values.size).toBe(1);
  clearChatProjectDefaults(saved, root);
  expect(loadChatProjectDefaults(saved, root)).toBeNull();
});
it("accepts equal legacy defaults despite JSON field order", () => {
  const saved = storage();
  saved.setItem(legacyKey("C:\\Work\\LatticeTerm"), JSON.stringify(settings));
  saved.setItem(legacyKey("c:/work/latticeterm"), JSON.stringify({ accountProfileId: null,
    permission: "readOnly", model: "fixture-model", definitionId: "codex" }));
  expect(loadChatProjectDefaults(saved, "C:/WORK/LatticeTerm")).toEqual(settings);
});
it("rejects conflicting legacy permissions and preserves both records", () => {
  const saved = storage();
  saved.setItem(legacyKey("C:\\Work\\LatticeTerm"), JSON.stringify(settings));
  saved.setItem(legacyKey("c:/work/latticeterm"), JSON.stringify({ ...settings, permission: "full" }));
  expect(() => loadChatProjectDefaults(saved, "c:/work/latticeterm")).toThrow(/conflict/i);
  expect(saved.values.size).toBe(2);
});
it("does not resurrect old settings after clearing or saving again", () => {
  const saved = storage();
  const oldKey = legacyKey("C:\\Work\\LatticeTerm");
  saved.setItem(oldKey, JSON.stringify(settings));
  clearChatProjectDefaults(saved, "c:/work/latticeterm");
  expect(loadChatProjectDefaults(saved, "C:\\WORK\\LatticeTerm")).toBeNull();
  expect(saved.getItem(oldKey)).toBe(JSON.stringify(settings));
  saveChatProjectDefaults(saved, "C:\\Work\\LatticeTerm", { ...settings, model: "new" });
  expect(loadChatProjectDefaults(saved, "c:/work/latticeterm")?.model).toBe("new");
  clearChatProjectDefaults(saved, "C:\\Work\\LatticeTerm");
  expect(loadChatProjectDefaults(saved, "c:/work/latticeterm")).toBeNull();
});
