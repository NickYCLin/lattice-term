import { useEffect, useMemo, useState } from "react";
import { mentionedImagePaths } from "../../app/chatImages";
import { hasDesktopBackend } from "../../app/nativeRuntime";
import { useI18n } from "../../i18n/context";

/**
 * Thumbnails of images on disk. The backend only reads them from the
 * conversation's working folder or, given the thread, its own chat folder.
 */
export function ChatImageStrip({
  paths,
  workingDirectory,
  threadId,
  captions = true,
}: {
  paths: readonly string[];
  workingDirectory: string;
  threadId?: string;
  /** File names under the pictures; a sent message already lists them. */
  captions?: boolean;
}) {
  const { t } = useI18n();
  const [images, setImages] = useState<{ path: string; url: string }[]>([]);
  const [enlarged, setEnlarged] = useState<string | null>(null);
  const key = paths.join("\n");

  useEffect(() => {
    const wanted = key ? key.split("\n") : [];
    if ((!workingDirectory && !threadId) || wanted.length === 0 || !hasDesktopBackend()) {
      setImages([]);
      return;
    }
    let cancelled = false;
    void import("@tauri-apps/api/core").then(async ({ invoke }) => {
      const found: { path: string; url: string }[] = [];
      for (const path of wanted) {
        const url = await invoke<string | null>("chat_image_preview", {
          workingDirectory,
          path,
          threadId: threadId ?? null,
        }).catch(() => null);
        if (url) found.push({ path, url });
      }
      if (!cancelled) setImages(found);
    });
    return () => {
      cancelled = true;
    };
  }, [key, workingDirectory, threadId]);

  if (images.length === 0) return null;
  return (
    <div className="chat-images" aria-label={t("chat.images")}>
      {images.map((image) => (
        <figure key={image.path} className={enlarged === image.path ? "is-enlarged" : undefined}>
          <button
            type="button"
            onClick={() => setEnlarged((current) => (current === image.path ? null : image.path))}
            title={t(enlarged === image.path ? "chat.images.shrink" : "chat.images.enlarge")}
          >
            <img src={image.url} alt={image.path} loading="lazy" />
          </button>
          {captions && <figcaption title={image.path}>{image.path}</figcaption>}
        </figure>
      ))}
    </div>
  );
}

/** Thumbnails of the images a finished reply mentions, from its folder. */
export function ChatImagePreviews({ text, workingDirectory }: { text: string; workingDirectory: string }) {
  const paths = useMemo(() => mentionedImagePaths(text), [text]);
  return <ChatImageStrip paths={paths} workingDirectory={workingDirectory} />;
}
