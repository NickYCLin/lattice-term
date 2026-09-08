import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { appLifecycleGuard, type AppLifecycleLease } from "../../app/appLifecycleGuard";
import { useI18n } from "../../i18n/context";
import { useModalFocus } from "../overlays/modalFocus";
import type { RemoteTextEditorProps } from "./RemoteTextEditor";

const Editor = lazy(() => import("./RemoteTextEditor").then((module) => ({ default: module.RemoteTextEditor })));
type Request = Omit<RemoteTextEditorProps, "onClose"> & { onClosed?: () => void };
const EditorContext = createContext({ open: (_request: Request) => {}, active: false });

/** Outside all session panes: a disconnect or tab change must not erase drafts. */
export function RemoteTextEditorProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [request, setRequest] = useState<Request | null>(null);
  const [blocked, setBlocked] = useState(false);
  const requestRef = useRef<Request | null>(null);
  const lease = useRef<AppLifecycleLease | null>(null);
  const mounted = useRef(true);
  const noticeRef = useRef<HTMLDivElement>(null);
  const noticeTitleId = useId();
  const open = useCallback((next: Request) => {
    if (!mounted.current || requestRef.current) return;
    const acquired = appLifecycleGuard.acquire("editor");
    if (!acquired) {
      setBlocked(true);
      return;
    }
    lease.current = acquired;
    requestRef.current = next;
    setBlocked(false);
    setRequest(next);
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestRef.current = null;
      lease.current?.release();
      lease.current = null;
    };
  }, []);
  useModalFocus({ dialogRef: noticeRef, onEscape: () => setBlocked(false), active: blocked });
  const notice = blocked ? (
    <div className="scrim scrim--center" role="presentation" onMouseDown={() => setBlocked(false)}>
      <div ref={noticeRef} className="dialog dialog--wide" role="alertdialog" aria-modal="true" aria-labelledby={noticeTitleId} tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
        <h2 className="dialog__title" id={noticeTitleId}>{t("fileEditor.updateBlockedTitle")}</h2>
        <p className="dialog__body">{t("fileEditor.updateBlockedBody")}</p>
        <div className="dialog__actions"><button type="button" className="button button--primary" onClick={() => setBlocked(false)}>{t("common.close")}</button></div>
      </div>
    </div>
  ) : null;
  return (
    <EditorContext.Provider value={{ open, active: request !== null || blocked }}>
      <div style={{ display: "contents" }} inert={request !== null || blocked}>
        {children}
      </div>
      {request && (
        <Suspense fallback={null}>
          <Editor {...request} onClose={() => {
            requestRef.current = null;
            lease.current?.release();
            lease.current = null;
            setRequest(null);
            request.onClosed?.();
          }} />
        </Suspense>
      )}
      {notice && (typeof window === "undefined" || !window.document?.body ? notice : createPortal(notice, window.document.body))}
    </EditorContext.Provider>
  );
}

export const useRemoteTextEditor = () => useContext(EditorContext);
