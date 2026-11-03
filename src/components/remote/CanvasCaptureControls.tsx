import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  captureFilename,
  formatRecordingDuration,
  preferredRecordingMimeType,
  recordingExtension,
} from "../../domain/capture";
import { useI18n } from "../../i18n/context";
import { AlertIcon, CameraIcon, RecordIcon, StopIcon } from "../icons";

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function CanvasCaptureControls({
  canvasRef,
  ready,
  label,
}: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  ready: boolean;
  label: string;
}) {
  const { t } = useI18n();
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const mountedRef = useRef(true);
  const [recording, setRecording] = useState(false);
  const [screenshotBusy, setScreenshotBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);

  const releaseStream = useCallback(() => {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      else releaseStream();
    };
  }, [releaseStream]);

  useEffect(() => {
    if (!recording) return;
    const update = () =>
      setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1_000));
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [recording]);

  useEffect(() => {
    if (ready) return;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }, [ready]);

  function screenshot() {
    const canvas = canvasRef.current;
    if (!canvas || !ready) return;
    setScreenshotBusy(true);
    setProblem(null);
    canvas.toBlob((blob) => {
      if (mountedRef.current) setScreenshotBusy(false);
      if (blob) download(blob, captureFilename(label, "png"));
      else if (mountedRef.current) setProblem(t("capture.screenshotFailed"));
    }, "image/png");
  }

  function startRecording() {
    const canvas = canvasRef.current;
    if (!canvas || !ready || recorderRef.current) return;
    setProblem(null);

    if (
      typeof MediaRecorder === "undefined" ||
      typeof canvas.captureStream !== "function"
    ) {
      setProblem(t("capture.unsupported"));
      return;
    }

    try {
      const mimeType = preferredRecordingMimeType(MediaRecorder.isTypeSupported);
      const stream = canvas.captureStream(30);
      // Own the stream before constructing the recorder, which may throw.
      streamRef.current = stream;
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000 })
        : new MediaRecorder(stream, { videoBitsPerSecond: 4_000_000 });

      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        if (mountedRef.current) setProblem(t("capture.recordingFailed"));
      };
      recorder.onstop = () => {
        const actualType = recorder.mimeType || mimeType || "video/webm";
        const chunks = chunksRef.current;
        if (chunks.length > 0) {
          const extension = recordingExtension(actualType);
          download(
            new Blob(chunks, { type: actualType }),
            captureFilename(label, extension),
          );
        } else if (mountedRef.current) {
          setProblem(t("capture.recordingFailed"));
        }
        releaseStream();
        if (mountedRef.current) {
          setRecording(false);
          setElapsed(0);
        }
      };

      startedAtRef.current = Date.now();
      recorder.start(1_000);
      setRecording(true);
    } catch {
      releaseStream();
      setProblem(t("capture.recordingFailed"));
    }
  }

  function stopRecording() {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }

  return (
    <div
      className="capture-controls"
      title={problem ?? t("capture.localOnly")}
      aria-label={t("capture.controlsLabel")}
    >
      <button
        type="button"
        className="capture-button"
        onClick={screenshot}
        disabled={!ready || screenshotBusy}
        aria-label={t("capture.screenshot")}
      >
        <CameraIcon size={13} />
        <span className="capture-button__label">{t("capture.screenshot")}</span>
      </button>
      {recording ? (
        <>
          <span className="capture-timer mono" aria-live="polite">
            <span className="capture-timer__dot" aria-hidden="true" />
            {formatRecordingDuration(elapsed)}
          </span>
          <button
            type="button"
            className="capture-button capture-button--stop"
            onClick={stopRecording}
            aria-label={t("capture.stop")}
          >
            <StopIcon size={12} />
            <span className="capture-button__label">{t("capture.stop")}</span>
          </button>
        </>
      ) : (
        <button
          type="button"
          className="capture-button"
          onClick={startRecording}
          disabled={!ready}
          aria-label={t("capture.start")}
        >
          <RecordIcon size={13} />
          <span className="capture-button__label">{t("capture.start")}</span>
        </button>
      )}
      {problem && (
        <span className="capture-problem" aria-live="assertive">
          <AlertIcon size={13} />
          <span className="visually-hidden">{problem}</span>
        </span>
      )}
    </div>
  );
}
