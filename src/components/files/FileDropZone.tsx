import { useRef, useState, type ReactNode } from "react";
import { useFileDrop } from "../../app/fileDrop";
import { droppedUpload, localFileError, type UploadFile } from "../../app/localFiles";
import { useI18n } from "../../i18n/context";

export function FileDropZone({ disabled = false, compact = false, onSelect, children }: {
  disabled?: boolean;
  compact?: boolean;
  onSelect: (file: UploadFile) => void | Promise<void>;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
  const [problem, setProblem] = useState<string | null>(null);
  const single = (items: readonly unknown[]) => { setProblem(null); if (items.length !== 1) throw new Error("localFile.single"); };
  const { dragging, ...handlers } = useFileDrop({
    ref, disabled,
    onPaths: async paths => { single(paths); await onSelect(await droppedUpload(paths[0])); },
    onFiles: async files => { single(files); await onSelect(files[0]); },
    onError: error => setProblem(localFileError(error, t)),
  });
  return <div ref={ref} {...handlers} className={`path-drop-zone${dragging ? " is-file-dropping" : ""}`}>
    {children}
    <small className={compact ? "visually-hidden" : "field__hint"}>{t("localFile.dropFile")}</small>
    {problem && <p className="field__error" role="alert">{problem}</p>}
  </div>;
}
