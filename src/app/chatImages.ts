/**
 * Image files a reply mentions: Markdown images and bare paths ending in a
 * common image extension. The desktop decides which of them it may show.
 */
const IMAGE_PATH =
  /(?:!\[[^\]]*\]\(([^)\s]+\.(?:png|jpe?g|gif|webp))\))|(?:^|[\s`'"(\[])((?:[A-Za-z]:[\\/]|~?\/|\.{1,2}\/)?[^\s`'"()[\]<>|*?]+\.(?:png|jpe?g|gif|webp))(?=$|[\s`'")\].,;:!?])/gim;

export const MAX_IMAGE_PREVIEWS = 6;

export function mentionedImagePaths(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(IMAGE_PATH)) {
    const path = (match[1] ?? match[2] ?? "").trim();
    if (!path || /^[a-z][a-z0-9+.-]*:\/\//i.test(path) || path.startsWith("~")) continue;
    if (!found.includes(path)) found.push(path);
    if (found.length >= MAX_IMAGE_PREVIEWS) break;
  }
  return found;
}
