import { useRef, useState } from "react";
import type { Preferences } from "../../app/preferences";
import {
  notificationSoundGroups,
  playNotificationSound,
  prepareNotificationAudio,
  type NotificationSoundChoice,
} from "../../app/notificationSounds";
import { useI18n } from "../../i18n/context";
import { PlayIcon } from "../icons";

export function NotificationSoundPanel({ preferences, onChange }: {
  preferences: Preferences;
  onChange: (patch: Partial<Preferences>) => void;
}) {
  const { t } = useI18n();
  const [playing, setPlaying] = useState<NotificationSoundChoice | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const busy = useRef(false);
  async function preview(sound: NotificationSoundChoice) {
    if (busy.current || sound === "off" || preferences.notificationVolume === 0) return;
    busy.current = true;
    setPlaying(sound);
    setUnavailable(false);
    // Resume immediately inside this user gesture, before the playback queue.
    void prepareNotificationAudio();
    try {
      setUnavailable(await playNotificationSound(sound, preferences.notificationVolume) === "unavailable");
    } finally {
      busy.current = false;
      setPlaying(null);
    }
  }
  return (
    <div className="notification-sounds">
      <div className="sound-events">
        {(["agentCompletionSound", "chatCompletionSound"] as const).map((event) => (
          <div className="sound-event" key={event}>
            <label htmlFor={`sound-${event}`}>
              {t(event === "agentCompletionSound" ? "settings.notifications.session" : "settings.notifications.chat")}
            </label>
            <select id={`sound-${event}`} value={preferences[event]}
              onChange={(e) => onChange({ [event]: e.target.value as NotificationSoundChoice })}>
              <option value="off">{t("settings.notifications.sound.off")}</option>
              {notificationSoundGroups.map((group) => (
                <optgroup key={group.id} label={t(`settings.notifications.group.${group.id}`)}>
                  {group.sounds.map((sound) => <option value={sound} key={sound}>{t(`settings.notifications.sound.${sound}`)}</option>)}
                </optgroup>
              ))}
            </select>
            <button type="button" className="button button--secondary button--sm"
              disabled={playing !== null || preferences[event] === "off" || preferences.notificationVolume === 0}
              onClick={() => void preview(preferences[event])}>
              <PlayIcon size={13} />{t("settings.notifications.preview")}
            </button>
          </div>
        ))}
      </div>
      <div className="sound-volume">
        <label htmlFor="notification-volume">{t("settings.notifications.volume")}</label>
        <input id="notification-volume" type="range" min="0" max="100" step="1"
          value={preferences.notificationVolume}
          onChange={(e) => onChange({ notificationVolume: Number(e.target.value) })} />
        <output htmlFor="notification-volume">{preferences.notificationVolume}%</output>
      </div>
      <p className="setting__description">{t(preferences.notificationVolume === 0 ? "settings.notifications.muted" : "settings.notifications.libraryHint")}</p>
      <div className="sound-library">
        {notificationSoundGroups.map((group) => (
          <section className="sound-group" key={group.id} aria-label={t(`settings.notifications.group.${group.id}`)}>
            <h3>{t(`settings.notifications.group.${group.id}`)}</h3>
            {group.sounds.map((sound) => (
              <button key={sound} type="button" className={`sound-cue${playing === sound ? " is-playing" : ""}`}
                disabled={playing !== null || preferences.notificationVolume === 0}
                aria-label={`${t("settings.notifications.preview")}：${t(`settings.notifications.sound.${sound}`)}`}
                onClick={() => void preview(sound)}>
                <span><strong>{t(`settings.notifications.sound.${sound}`)}</strong><small>{t(`settings.notifications.hint.${sound}`)}</small></span>
                <PlayIcon size={15} />
              </button>
            ))}
          </section>
        ))}
      </div>
      <p className={`sound-status${unavailable ? " is-danger" : ""}`} role="status">
        {unavailable ? t("settings.notifications.previewUnavailable") : playing ? `${t("settings.notifications.previewing")} ${t(`settings.notifications.sound.${playing}`)}` : ""}
      </p>
    </div>
  );
}
