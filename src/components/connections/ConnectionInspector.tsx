/**
 * Details for the selected connection, in two tabs.
 *
 * "Details" is what the entry contains. "Host status" is what the machine is
 * doing — processor, memory and disk — which only exists once a session does,
 * so it renders the honest unavailable state until then.
 */

import { useId, useState } from "react";
import type { ReactNode } from "react";
import {
  UNGROUPED,
  connectionTarget,
  environmentLabelKey,
  findProtocol,
  protocolCatalog,
  protocolLabelKey,
  protocolSummaryKey,
  type ConnectionProfile,
} from "../../domain/connection";
import type { MetricsState } from "../../domain/metrics";
import { useI18n } from "../../i18n/context";
import { Chip, EnvironmentBadge, ProtocolTile, TagChip } from "../common/Badge";
import { Callout } from "../common/Callout";
import { CloseIcon, DuplicateIcon, EditIcon, TrashIcon } from "../icons";
import { HostMetricsPanel } from "./HostMetricsPanel";
import { moveTabGroupFocus } from "../overlays/tabNavigation";

const inspectorTabs = ["info", "metrics"] as const;

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="field-row">
      <dt className="field-row__label">{label}</dt>
      <dd className="field-row__value">{value}</dd>
    </div>
  );
}

export function ConnectionInspector({
  profile,
  metrics,
  onClose,
  onEdit,
  onDuplicate,
  onDelete,
  machine,
}: {
  profile: ConnectionProfile;
  metrics: MetricsState;
  onClose: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  /** Linking entries that reach the same computer by different routes. */
  machine?: {
    peers: ConnectionProfile[];
    candidates: ConnectionProfile[];
    onShow: (id: string) => void;
    onLink: (id: string) => Promise<string | null>;
    onUnlink: () => Promise<string | null>;
  };
}) {
  const { t } = useI18n();
  const [linkTarget, setLinkTarget] = useState("");
  const [machineBusy, setMachineBusy] = useState(false);
  const [machineError, setMachineError] = useState<string | null>(null);

  async function runMachineAction(action: () => Promise<string | null>) {
    setMachineBusy(true);
    setMachineError(null);
    try {
      const failure = await action();
      if (failure) setMachineError(failure);
      else setLinkTarget("");
    } finally {
      setMachineBusy(false);
    }
  }
  const [tab, setTab] = useState<(typeof inspectorTabs)[number]>("info");
  const tabsId = useId();
  const protocol = findProtocol(profile.protocol);

  return (
    <aside className="inspector glass glass--sheen" aria-label={profile.name}>
      <div className="inspector__head">
        <ProtocolTile protocol={profile.protocol} size="lg" />
        <div className="inspector__identity">
          <h2 className="inspector__name truncate">{profile.name}</h2>
          <p className="inspector__target mono truncate">
            {connectionTarget(profile)}
          </p>
        </div>
        <button
          type="button"
          className="icon-button icon-button--sm"
          onClick={onClose}
          aria-label={t("inspector.close")}
        >
          <CloseIcon size={14} />
        </button>
      </div>

      <div
        className="inspector__tabs"
        role="tablist"
        aria-label={profile.name}
      >
        <button
          type="button"
          id={tabsId + "-info-tab"}
          role="tab"
          aria-selected={tab === "info"}
          tabIndex={tab === "info" ? 0 : -1}
          className={`inspector__tab${tab === "info" ? " is-active" : ""}`}
          onClick={() => setTab("info")}
          onKeyDown={(event) =>
            moveTabGroupFocus(event, 0, (nextIndex) =>
              setTab(inspectorTabs[nextIndex]),
            )
          }
        >
          {t("inspector.tab.info")}
        </button>
        <button
          type="button"
          id={tabsId + "-metrics-tab"}
          role="tab"
          aria-selected={tab === "metrics"}
          tabIndex={tab === "metrics" ? 0 : -1}
          className={`inspector__tab${tab === "metrics" ? " is-active" : ""}`}
          onClick={() => setTab("metrics")}
          onKeyDown={(event) =>
            moveTabGroupFocus(event, 1, (nextIndex) =>
              setTab(inspectorTabs[nextIndex]),
            )
          }
        >
          {t("inspector.tab.metrics")}
        </button>
      </div>

      <div
        className="inspector__scroll"
        role="tabpanel"
        aria-labelledby={tabsId + `-${tab}-tab`}
      >
        {tab === "info" ? (
          <>
            <div className="inspector__badges">
              <EnvironmentBadge environment={profile.environment} />
              <Chip tone="neutral">{protocol.acronym}</Chip>
              {profile.favorite && (
                <Chip tone="accent">{t("connections.favorites")}</Chip>
              )}
            </div>

            <section className="inspector__section">
              <h3 className="eyebrow">{t("inspector.section.target")}</h3>
              <dl className="field-list">
                <Field
                  label={t(
                    profile.protocol === "lattice"
                      ? "inspector.remoteAddress"
                      : "inspector.host",
                  )}
                  value={<span className="mono">{profile.hostname}</span>}
                />
                <Field
                  label={t("inspector.port")}
                  value={<span className="mono">{profile.port}</span>}
                />
                {profile.protocol !== "lattice" && (
                  <Field
                    label={t("inspector.username")}
                    value={
                      profile.username ? (
                        <span className="mono">{profile.username}</span>
                      ) : (
                        <span className="text-faint">{t("common.notSet")}</span>
                      )
                    }
                  />
                )}
                <Field
                  label={t("inspector.environment")}
                  value={t(environmentLabelKey(profile.environment))}
                />
                <Field
                  label={t("inspector.group")}
                  value={
                    profile.group === UNGROUPED ? (
                      <span className="text-faint">
                        {t("connections.ungrouped")}
                      </span>
                    ) : (
                      profile.group
                    )
                  }
                />
                <Field
                  label={t("inspector.tags")}
                  value={
                    profile.tags.length > 0 ? (
                      <span className="inspector__tags">
                        {profile.tags.map((tag) => (
                          <TagChip key={tag} label={tag} />
                        ))}
                      </span>
                    ) : (
                      <span className="text-faint">{t("common.none")}</span>
                    )
                  }
                />
              </dl>
            </section>

            {machine && (machine.peers.length > 0 || machine.candidates.length > 0) && (
              <section className="inspector__section">
                <h3 className="eyebrow">{t("inspector.machine.title")}</h3>
                {machine.peers.length > 0 ? (
                  <ul className="inspector__machine-list">
                    {machine.peers.map((peer) => (
                      <li className="inspector__machine-item" key={peer.id}>
                        <ProtocolTile protocol={peer.protocol} size="sm" />
                        <span className="inspector__machine-name truncate">
                          {peer.name}
                          <small className="mono text-faint">
                            {" "}
                            {connectionTarget(peer)}
                          </small>
                        </span>
                        <button
                          type="button"
                          className="button button--ghost button--sm"
                          onClick={() => machine.onShow(peer.id)}
                        >
                          {t("inspector.machine.show")}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-faint">{t("inspector.machine.hint")}</p>
                )}
                {machine.candidates.length > 0 && (
                  <div className="inspector__machine-link">
                    <select
                      className="select"
                      aria-label={t("inspector.machine.pick")}
                      value={linkTarget}
                      disabled={machineBusy}
                      onChange={(event) => setLinkTarget(event.target.value)}
                    >
                      <option value="">{t("inspector.machine.pick")}</option>
                      {machine.candidates.map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.name} · {findProtocol(candidate.protocol).acronym}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="button button--secondary button--sm"
                      disabled={!linkTarget || machineBusy}
                      onClick={() =>
                        void runMachineAction(() => machine.onLink(linkTarget))
                      }
                    >
                      {t("inspector.machine.link")}
                    </button>
                  </div>
                )}
                {machine.peers.length > 0 && (
                  <button
                    type="button"
                    className="button button--ghost button--sm"
                    disabled={machineBusy}
                    onClick={() => void runMachineAction(machine.onUnlink)}
                  >
                    {t("inspector.machine.unlink")}
                  </button>
                )}
                {machineError && (
                  <p className="text-faint" role="alert">
                    {t("inspector.machine.failed", { error: machineError })}
                  </p>
                )}
              </section>
            )}

            <section className="inspector__section">
              <h3 className="eyebrow">{t("inspector.services")}</h3>
              <ul className="service-list">
                {protocolCatalog.map((entry) => (
                  <li className="service-list__item" key={entry.id}>
                    <ProtocolTile protocol={entry.id} size="sm" />
                    <span className="service-list__text">
                      <strong>{t(protocolLabelKey(entry.id))}</strong>
                      <small>{t(protocolSummaryKey(entry.id))}</small>
                    </span>
                    <Chip tone={entry.available ? "ok" : "planned"}>
                      {t(
                        entry.available
                          ? "common.available"
                          : "common.comingSoon",
                      )}
                    </Chip>
                  </li>
                ))}
              </ul>
            </section>

            <Callout tone="security" title={t("inspector.security.title")}>
              {t("inspector.security.body")}
            </Callout>
          </>
        ) : (
          <HostMetricsPanel state={metrics} />
        )}
      </div>

      <div className="inspector__footer">
        <button
          type="button"
          className="button button--secondary button--sm"
          onClick={onEdit}
        >
          <EditIcon size={14} />
          {t("common.edit")}
        </button>
        <button
          type="button"
          className="button button--ghost button--sm"
          onClick={onDuplicate}
        >
          <DuplicateIcon size={14} />
          {t("common.duplicate")}
        </button>
        <button
          type="button"
          className="button button--ghost button--danger button--sm"
          onClick={onDelete}
        >
          <TrashIcon size={14} />
          {t("common.delete")}
        </button>
      </div>
    </aside>
  );
}
