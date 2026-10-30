import { useId, useRef } from "react";
import { connectionTarget, findProtocol } from "../../domain/connection";
import { useI18n } from "../../i18n/context";
import { useModalFocus } from "../overlays/modalFocus";
import { ChevronRightIcon } from "../icons";
import type { LinkedRoute } from "./ConnectionCard";

export function ConnectionRoutePicker({ name, routes, onClose }: {
  name: string;
  routes: LinkedRoute[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);
  const connecting = useRef(false);
  const firstAvailable = routes.find((route) => route.onConnect)?.profile.id;
  useModalFocus({ dialogRef, getInitialFocus: () => firstRef.current, onEscape: onClose });

  return (
    <div className="scrim scrim--center" role="presentation" onMouseDown={onClose}>
      <div ref={dialogRef} className="dialog connection-route-picker" role="dialog"
        aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}>
        <h2 className="dialog__title" id={titleId}>{t("connections.routes.title", { name })}</h2>
        <p className="dialog__body">{t("connections.routes.hint")}</p>
        <div className="connection-route-picker__list">
          {routes.map((route) => (
            <button key={route.profile.id} type="button"
              ref={route.profile.id === firstAvailable ? firstRef : undefined}
              className="button button--secondary connection-card__route"
              disabled={!route.onConnect}
              onClick={() => {
                if (connecting.current || !route.onConnect) return;
                connecting.current = true;
                onClose();
                route.onConnect();
              }}>
              <span className="connection-card__route-info">
                <span className="connection-card__route-protocol">{route.profile.name}</span>
                <span className="connection-card__route-target mono">
                  {findProtocol(route.profile.protocol).acronym} · {connectionTarget(route.profile)}
                </span>
                {!route.onConnect && <span>{t("connections.routes.unavailable")}</span>}
              </span>
              <ChevronRightIcon size={16} />
            </button>
          ))}
        </div>
        <div className="dialog__actions">
          <button type="button" className="button button--ghost" onClick={onClose}>{t("common.cancel")}</button>
        </div>
      </div>
    </div>
  );
}
