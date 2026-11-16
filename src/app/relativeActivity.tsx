import { memo, useSyncExternalStore } from "react";
import { useI18n } from "../i18n/context";
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
export function subscribeActivityClock(listener: () => void) {
  listeners.add(listener);
  timer ??= setInterval(() => { for (const update of listeners) update(); }, 60_000);
  return () => { listeners.delete(listener); if (!listeners.size) { clearInterval(timer); timer = undefined; } };
}
const minuteNow = () => Math.floor(Date.now() / 60_000) * 60_000;
export function relativeActivity(at: number, now: number, locale: string): string | null {
  if (!Number.isFinite(at) || at <= 0 || !Number.isFinite(new Date(at).getTime())) return null;
  const seconds = Math.max(0, (now-at)/1000), format = new Intl.RelativeTimeFormat(locale, { numeric:"auto", style:"short" });
  for (const [size, unit] of [[31_536_000,"year"],[2_592_000,"month"],[86_400,"day"],[3_600,"hour"],[60,"minute"]] as const) {
    if (seconds >= size) return format.format(-Math.floor(seconds/size), unit);
  }
  return format.format(0,"second");
}
/** Only the time node subscribes; the conversation row and tree do not tick. */
export const RelativeActivity = memo(function RelativeActivity({ at }: { at: number }) {
  const { tag } = useI18n();
  const now = useSyncExternalStore(subscribeActivityClock, minuteNow, minuteNow);
  const text = relativeActivity(at, now, tag);
  return text ? <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString(tag)}>{text}</time> : null;
});
