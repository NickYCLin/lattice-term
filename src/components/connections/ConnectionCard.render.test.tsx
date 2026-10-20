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
    "onConnect" | "unavailableReason" | "linked" | "onAddRoute"
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
  it("distinguishes same-protocol address buttons without needing hover", () => {
    const markup = renderCard({ onConnect: vi.fn(), linked: [{
      profile: { ...profile, id: "wan", hostname: "wan.example.com", port: 3390 }, onConnect: vi.fn(),
    }] });
    expect(markup).toContain("RDP · desktop.example.com:3389");
    expect(markup).toContain("RDP · wan.example.com:3390");
  });
  it("separates the primary action from compact management controls", () => {
    const markup = renderCard({ onConnect: vi.fn() });
    expect(markup).toContain('class="connection-card__primary"');
    expect(markup).toContain('protocol-tile--sm');
    const footer = markup.slice(markup.indexOf('class="connection-card__foot"'));
    expect(footer).toContain("加入常用");
    expect(footer).not.toContain("connection-card__go");
    expect(markup).toContain('title="Office PC');
    expect(markup).toContain('title="operator@desktop.example.com:3389"');
  });

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
  it("offers a separate add-route action even when the current protocol is unavailable", () => {
    const markup = renderCard({ onAddRoute: vi.fn(), unavailableReason: "desktop-only" });
    expect(markup).toContain("connection-card__add-route");
    expect(markup).toContain("新增連線方式</button>");
    const footer = markup.slice(markup.indexOf('class="connection-card__foot"'));
    expect(footer).toContain("connection-card__add-route");
    expect(footer.indexOf("connection-card__add-route")).toBeLessThan(footer.indexOf("connection-card__actions"));
    expect(markup).toContain("桌面版限定");
    expect(renderCard({})).not.toContain("connection-card__add-route");
  });

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
    expect(markup).not.toContain("connection-card__name truncate");
    expect(markup).not.toContain("connection-card__target mono truncate");
    expect(markup).not.toContain("connection-card__target truncate");
    expect(markup).toContain("用 RDP 連到「Office PC」");
    expect(markup).toContain(`用 ${remoteAcronym()} 連到「蘋果筆電」`);
    expect(markup).not.toContain(">連線</button>");
  });
});

function remoteAcronym(): string {
  return findProtocol("lattice").acronym;
}
