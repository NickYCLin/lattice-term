/**
 * Global navigation rail.
 *
 * Icon-only to leave the width for real work; every button carries an
 * accessible name and a tooltip, and the current area is named again in the
 * view header, so the rail is never the only place a label appears.
 */

import { navigationItems, type NavigationItem, type ViewId } from "../../app/navigation";
import { useI18n } from "../../i18n/context";

export function NavRail({
  current,
  onSelect,
  items = navigationItems,
  activityUnreadCount = 0,
}: {
  current: ViewId;
  onSelect: (view: ViewId) => void;
  items?: NavigationItem[];
  activityUnreadCount?: number;
}) {
  const { t } = useI18n();

  return (
    <nav className="rail glass glass--sheen" aria-label={t("a11y.primaryNav")}>
      <div className="rail__brand" title={t("common.appName")}>
        <img
          src="/app-icon.png"
          alt={t("common.appName")}
          width={28}
          height={28}
          className="rail__brand-img"
        />
        <span className="visually-hidden">{t("common.appName")}</span>
      </div>

      <ul className="rail__items">
        {items.map((item) => {
          const Glyph = item.icon;
          const active = item.id === current;
          const planned = item.status === "planned";
          const label = t(item.labelKey);
          const unread = item.id === "activity" ? activityUnreadCount : 0;
          const accessibleLabel = unread
            ? t("activity.navUnread", { count: unread })
            : label;

          return (
            <li key={item.id}>
              <button
                type="button"
                className={`rail__item${active ? " is-active" : ""}`}
                aria-current={active ? "page" : undefined}
                aria-label={accessibleLabel}
                onClick={() => onSelect(item.id)}
                data-tooltip={
                  planned
                    ? `${label} · ${t("planned.badge")}`
                    : unread
                      ? accessibleLabel
                      : label
                }
              >
                <Glyph size={19} />
                <span className="rail__label" aria-hidden="true">{label}</span>
                <span className="visually-hidden">
                  {planned ? `${label}（${t("planned.badge")}）` : label}
                </span>
                {planned && <span className="rail__flag" aria-hidden="true" />}
                {unread > 0 && (
                  <span className="rail__badge" aria-hidden="true">
                    {unread > 99 ? "99+" : unread}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
