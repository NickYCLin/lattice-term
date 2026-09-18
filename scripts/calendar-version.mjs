/** Date versions use the same Asia/Taipei day as the release schedule. */
export function calendarVersion(date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error("無效的發布日期。");
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei", year: "numeric", month: "numeric", day: "numeric",
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  return `${parts.year}.${Number(parts.month)}.${Number(parts.day)}`;
}

export function availableCalendarVersion(date, tags) {
  const version = calendarVersion(date);
  const parts = version.split(".").map(BigInt);
  for (const tag of tags) {
    if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) continue;
    const tagged = tag.slice(1).split(".").map(BigInt);
    const different = parts.findIndex((part, index) => part !== tagged[index]);
    if (different >= 0 && parts[different] < tagged[different]) throw new Error(`已有較新的 tag ${tag}，不能倒退日期版號。`);
  }
  // Even a deleted or abandoned Release must never reuse an existing tag.
  return tags.includes(`v${version}`) ? null : version;
}
