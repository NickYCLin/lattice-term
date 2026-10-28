export const fileSortOrders = ["nameAsc", "nameDesc", "newest", "oldest", "largest", "smallest"] as const;

export type FileSortOrder = typeof fileSortOrders[number];

interface SortableEntry {
  name: string;
  kind: string;
  size: number;
  modifiedAt: number | null;
}

function compareNumbers(left: number | null, right: number | null, descending: boolean): number {
  const leftKnown = left !== null && Number.isFinite(left);
  const rightKnown = right !== null && Number.isFinite(right);
  if (!leftKnown) return rightKnown ? 1 : 0;
  if (!rightKnown) return -1;
  return descending ? right! - left! : left! - right!;
}

export function sortFileEntries<Entry extends SortableEntry>(entries: readonly Entry[], order: FileSortOrder, locale: string): Entry[] {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  return [...entries].sort((left, right) => {
    const foldersFirst = Number(right.kind === "directory") - Number(left.kind === "directory");
    if (foldersFirst) return foldersFirst;
    const byName = () => collator.compare(left.name, right.name);
    if (left.kind === "directory") return order === "nameDesc" ? -byName() : byName();
    if (order === "nameAsc") return byName();
    if (order === "nameDesc") return -byName();
    if (order === "newest" || order === "oldest") {
      return compareNumbers(left.modifiedAt, right.modifiedAt, order === "newest") || byName();
    }
    const leftSize = left.kind === "file" && left.size >= 0 ? left.size : null;
    const rightSize = right.kind === "file" && right.size >= 0 ? right.size : null;
    return compareNumbers(leftSize, rightSize, order === "largest") || byName();
  });
}
