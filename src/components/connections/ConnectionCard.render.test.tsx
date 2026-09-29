import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createConnectionProfile,
  emptyDraft,
  findProtocol,
} from "../../domain/connection";
import { I18nProvider } from "../../i18n";
import { ConnectionCard } from "./ConnectionCard";

const profile = createConnectionProfile(
  {
    ...emptyDraft("rdp"),
    name: "Office PC",
    hostname: "desktop.example.com",
    username: "operator",
  },
  "rdp-card",
);

function renderCard(
  options: Pick<
    Parameters<typeof ConnectionCard>[0],
    "onConnect" | "unavailableReason" | "linked"
  >,
) {
  return renderToStaticMarkup(
    <I18nProvider locale="zh-TW">
      <ConnectionCard
        profile={profile}
        selected={false}
        onSelect={vi.fn()}
        onEdit={vi.fn()}
        onDuplicate={vi.fn()}
        onDelete={vi.fn()}
        onToggleFavorite={vi.fn()}
        {...options}
      />
    </I18nProvider>,
  );
}

describe("connection card runtime capability", () => {
  it("offers the live action when the package supports the protocol", () => {
    const markup = renderCard({ onConnect: vi.fn() });

    expect(markup).toContain(">連線</button>");
    expect(markup).not.toContain("桌面版限定");
  });

  it("states the mobile boundary without calling it coming soon", () => {
    const markup = renderCard({ unavailableReason: "desktop-only" });

    expect(markup).toContain("連線 · 桌面版限定");
    expect(markup).toContain("只能由 LatticeTerm 桌面版開啟");
    expect(markup).not.toContain("即將推出");
    expect(markup).not.toContain("連線功能開發中");
  });
});

describe("same-computer card", () => {
  it("offers one connect button per route and names the folded entry", () => {
    const remote = createConnectionProfile(
      { ...emptyDraft("lattice"), name: "蘋果筆電", deviceId: "008806370" },
      "remote-card",
    );
    const markup = renderCard({
      onConnect: vi.fn(),
      linked: [{ profile: remote, onConnect: vi.fn() }],
    });

    expect(markup).toContain("同一台電腦：蘋果筆電");
    expect(markup).toContain("用 RDP 連到「Office PC」");
    expect(markup).toContain(`用 ${remoteAcronym()} 連到「蘋果筆電」`);
    expect(markup).not.toContain(">連線</button>");
  });
});

function remoteAcronym(): string {
  return findProtocol("lattice").acronym;
}
