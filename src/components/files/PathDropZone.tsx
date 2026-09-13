import { useRef, useState, type ReactNode } from "react";
import { useFileDrop } from "../../app/fileDrop";
import { inspectLocalPath, localFileError } from "../../app/localFiles";
import { useI18n } from "../../i18n/context";

/** A dropped path selects an input; it never uploads or submits a form. */
export function PathDropZone({ kind, disabled = false, compact = false, onSelect, children }: {
  kind: "file" | "directory";
  disabled?: boolean;
  compact?: boolean;
  onSelect: (path: string) => void | Promise<void>;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
  const [problem, setProblem] = useState<string | null>(null);
  const { dragging } = useFileDrop({
    ref, disabled,
    onPaths: async paths => {
      setProblem(null);
      if (paths.length !== 1) throw new Error("localFile.single");
      const info = await inspectLocalPath(paths[0]);
      if (info.kind !== kind) throw new Error(kind === "file" ? "localFile.expectedFile" : "localFile.expectedDirectory");
      await onSelect(paths[0]);
    },
    onError: error => setProblem(localFileError(error, t)),
  });
  return <div ref={ref} className={`path-drop-zone${dragging ? " is-file-dropping" : ""}`}>
    {children}
    <small className={compact ? "visually-hidden" : "field__hint"}>{t(kind === "file" ? "localFile.dropFile" : "localFile.dropDirectory")}</small>
    {problem && <p className="field__error" role="alert">{problem}</p>}
  </div>;
}
