/**
 * Promise-shaped confirm and prompt backed by the app's own dialogs, so a
 * flow written as `if (!(await confirm(...))) return;` keeps reading like
 * the browser version while the question is actually shown.  The desktop
 * WebView returns from `window.confirm` and `window.prompt` immediately,
 * which once made "delete" and "overwrite" skip their questions.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { TextPromptDialog } from "./TextPromptDialog";

interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  tone?: "danger" | "default";
}

interface PromptRequest {
  title: string;
  label: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel: string;
  cancelLabel: string;
}

export function useAppDialogs(): {
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  prompt: (request: PromptRequest) => Promise<string | null>;
  dialogs: ReactNode;
} {
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [promptRequest, setPromptRequest] = useState<PromptRequest | null>(null);
  const confirmResolver = useRef<((answer: boolean) => void) | null>(null);
  const promptResolver = useRef<((answer: string | null) => void) | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const resolveConfirm = confirmResolver.current;
      const resolvePrompt = promptResolver.current;
      confirmResolver.current = null;
      promptResolver.current = null;
      resolveConfirm?.(false);
      resolvePrompt?.(null);
    };
  }, []);

  const confirm = useCallback((request: ConfirmRequest) => {
    if (!mounted.current) return Promise.resolve(false);
    confirmResolver.current?.(false);
    return new Promise<boolean>((resolve) => {
      confirmResolver.current = resolve;
      setConfirmRequest(request);
    });
  }, []);

  const prompt = useCallback((request: PromptRequest) => {
    if (!mounted.current) return Promise.resolve(null);
    promptResolver.current?.(null);
    return new Promise<string | null>((resolve) => {
      promptResolver.current = resolve;
      setPromptRequest(request);
    });
  }, []);

  function settleConfirm(answer: boolean) {
    const resolve = confirmResolver.current;
    confirmResolver.current = null;
    setConfirmRequest(null);
    resolve?.(answer);
  }

  function settlePrompt(answer: string | null) {
    const resolve = promptResolver.current;
    promptResolver.current = null;
    setPromptRequest(null);
    resolve?.(answer);
  }

  const dialogs = (
    <>
      {confirmRequest && (
        <ConfirmDialog
          title={confirmRequest.title}
          body={confirmRequest.body}
          confirmLabel={confirmRequest.confirmLabel}
          cancelLabel={confirmRequest.cancelLabel}
          tone={confirmRequest.tone ?? "danger"}
          onConfirm={() => settleConfirm(true)}
          onCancel={() => settleConfirm(false)}
        />
      )}
      {promptRequest && (
        <TextPromptDialog
          title={promptRequest.title}
          label={promptRequest.label}
          initialValue={promptRequest.initialValue}
          placeholder={promptRequest.placeholder}
          confirmLabel={promptRequest.confirmLabel}
          cancelLabel={promptRequest.cancelLabel}
          onSubmit={(value) => settlePrompt(value)}
          onCancel={() => settlePrompt(null)}
        />
      )}
    </>
  );

  return { confirm, prompt, dialogs };
}
