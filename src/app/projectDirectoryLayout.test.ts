import { expect, it } from "vitest";
import { mergeDirectoryProjectLayout } from "./projectDirectoryLayout";
import { emptySessionSidebarLayout } from "./sessionSidebarLayout";
it("merges alias project placements while preserving folders, custom filing and collapsed state", () => {
  const layout = { ...emptySessionSidebarLayout, folders: [{ id: "folder:work", name: "我的工作" }], placements: {
    "project:local:/alias/rust/": { parentId: "folder:work", order: 1, manual: true },
    "project:local:/real/rust": { parentId: null, order: 0 },
    "thread:a": { parentId: "project:local:/alias/rust/", order: 0 },
    "thread:b": { parentId: "project:local:/real/rust", order: 1 },
    "thread:filed": { parentId: "folder:work", order: 2, manual: true },
  }, collapsedFolderIds: ["project:local:/alias/rust/"] };
  const result = mergeDirectoryProjectLayout(layout, [], p => p.replace("/alias/", "/real/").replace(/\/$/, ""));
  expect(result.folders).toEqual(layout.folders);
  expect(result.placements["project:local:/real/rust"].parentId).toBe("folder:work");
  expect(Object.keys(result.placements).filter(id => id.startsWith("project:"))).toEqual(["project:local:/real/rust"]);
  expect(result.placements["thread:a"].parentId).toBe("project:local:/real/rust");
  expect(result.placements["thread:filed"]).toEqual(layout.placements["thread:filed"]);
  expect(result.collapsedFolderIds).toEqual(["project:local:/real/rust"]);
  expect(layout.placements["thread:a"].parentId).toBe("project:local:/alias/rust/");
});
it("splits the old case-folded POSIX parent using live automatic membership without guessing manual filing", () => {
  const layout = { ...emptySessionSidebarLayout, placements: {
    "thread:upper": { parentId: "project:local:/work/rust", order: 0 },
    "thread:lower": { parentId: "project:local:/work/rust", order: 1 },
  } };
  const result = mergeDirectoryProjectLayout(layout, [
    { id: "thread:upper", defaultParentId: "project:local:/work/Rust" },
    { id: "thread:lower", defaultParentId: "project:local:/work/rust" },
  ], undefined, ["/work/Rust", "/work/rust"]);
  expect(result.placements["thread:upper"].parentId).toBe("project:local:/work/Rust");
  expect(result.placements["thread:lower"].parentId).toBe("project:local:/work/rust");
});
