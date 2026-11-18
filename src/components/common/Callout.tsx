import { DesktopDescription } from "./MobilePresentation";
/**
 * Callouts, keyboard hints and empty states.
 *
 * Failure and risk messages follow one shape: what happened, why it matters,
 * and the next step the user can take.
 */

import type { ReactNode } from "react";
import { AlertIcon, InfoIcon, RoadmapIcon, ShieldIcon } from "../icons";

export type CalloutTone = "info" | "security" | "warn" | "danger" | "planned";

const toneIcons = {
  info: InfoIcon,
  security: ShieldIcon,
  warn: AlertIcon,
  danger: AlertIcon,
  planned: RoadmapIcon,
};

export function Callout({
  tone = "info",
  title,
  children,
  actions,
}: {
  tone?: CalloutTone;
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const Glyph = toneIcons[tone];

  return (
    <div className={`callout callout--${tone}`} role="note">
      <span className="callout__icon">
        <Glyph />
      </span>
      <div className="callout__body">
        {title && <strong className="callout__title">{title}</strong>}
        <div className="callout__text">{children}</div>
        {actions && <div className="callout__actions">{actions}</div>}
      </div>
    </div>
  );
}

/** Renders a shortcut such as `Ctrl K` as separate key caps. */
export function Kbd({ keys }: { keys: string[] }) {
  return (
    <span className="kbd-group">
      {keys.map((key) => (
        <kbd className="kbd" key={key}>
          {key}
        </kbd>
      ))}
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  actions,
  footnote,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  actions?: ReactNode;
  footnote?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-state__icon" aria-hidden="true">
        {icon}
      </span>
      <h3 className="empty-state__title">{title}</h3>
      <DesktopDescription><p className="empty-state__text">{description}</p></DesktopDescription>
      {actions && <div className="empty-state__actions">{actions}</div>}
      {footnote && <DesktopDescription><p className="empty-state__footnote">{footnote}</p></DesktopDescription>}
    </div>
  );
}
