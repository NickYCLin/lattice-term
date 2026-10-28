import { expect, it } from "vitest";
import { fileSortOrders, sortFileEntries, type FileSortOrder } from "./fileSorting";

const entries = [
  { name: "Folder10", kind: "directory", size: 999, modifiedAt: 99 },
  { name: "file10", kind: "file", size: 10, modifiedAt: 10 },
  { name: "file2", kind: "file", size: 20, modifiedAt: 20 },
  { name: "Folder2", kind: "directory", size: 0, modifiedAt: 0 },
];

it.each<[FileSortOrder, string[]]>([
  ["nameAsc", ["Folder2", "Folder10", "file2", "file10"]],
  ["nameDesc", ["Folder10", "Folder2", "file10", "file2"]],
  ["newest", ["Folder2", "Folder10", "file2", "file10"]],
  ["oldest", ["Folder2", "Folder10", "file10", "file2"]],
  ["largest", ["Folder2", "Folder10", "file2", "file10"]],
  ["smallest", ["Folder2", "Folder10", "file10", "file2"]],
])("sorts %s with folders first and leaves source entries untouched", (order, names) => {
  const original = [...entries];
  const result = sortFileEntries(Object.freeze([...entries]), order, "en");
  expect(result.map(entry => entry.name)).toEqual(names);
  expect(entries).toEqual(original);
  for (const entry of result) expect(entries).toContain(entry);
});

it.each(["newest", "oldest"] as const)("keeps unavailable dates last for %s without treating the epoch as unknown", order => {
  const dated = [
    { name: "unknown", kind: "file", size: 0, modifiedAt: null },
    { name: "epoch", kind: "file", size: 0, modifiedAt: 0 },
    { name: "invalid", kind: "file", size: 0, modifiedAt: NaN },
    { name: "recent", kind: "file", size: 0, modifiedAt: 100 },
  ];
  expect(sortFileEntries(dated, order, "en").map(entry => entry.name)).toEqual(
    order === "newest" ? ["recent", "epoch", "invalid", "unknown"] : ["epoch", "recent", "invalid", "unknown"],
  );
});

it.each(["largest", "smallest"] as const)("places unknown sizes and links after regular files for %s", order => {
  const sized = [
    { name: "link", kind: "symlink", size: 999, modifiedAt: null },
    { name: "invalid", kind: "file", size: -1, modifiedAt: null },
    { name: "infinite", kind: "file", size: Infinity, modifiedAt: null },
    { name: "empty", kind: "file", size: 0, modifiedAt: null },
    { name: "large", kind: "file", size: 20, modifiedAt: null },
  ];
  expect(sortFileEntries(sized, order, "en").map(entry => entry.name)).toEqual(
    order === "largest" ? ["large", "empty", "infinite", "invalid", "link"] : ["empty", "large", "infinite", "invalid", "link"],
  );
});

it.each(fileSortOrders)("breaks equal metadata ties by name and accepts empty listings for %s", order => {
  const tied = ["報表10", "報表2"].map(name => ({ name, kind: "file", size: 1, modifiedAt: 1 }));
  expect(sortFileEntries(tied, order, "zh-TW").map(entry => entry.name)).toEqual(
    order === "nameDesc" ? ["報表10", "報表2"] : ["報表2", "報表10"],
  );
  expect(sortFileEntries([], order, "zh-TW")).toEqual([]);
});
