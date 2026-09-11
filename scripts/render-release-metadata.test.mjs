import { describe, expect, it } from "vitest";

import {
  buildReleaseMetadata,
  deduplicateChangelogEntries,
} from "./render-release-metadata.mjs";

describe("buildReleaseMetadata", () => {
  it("將指定版本更新日誌轉成既有 Release 的繁中格式", () => {
    const changelog = `# 更新日誌

## [0.9.2](https://example.test/compare) (2026-08-21)

### 🛠️ 問題修正

* **VNC:** 補發新版 Rust 像素分塊相容修正 ([73a3155](https://github.com/example/repo/commit/73a3155415c2109d315d9e1bab3ad554bb93607c))

## [0.9.1](https://example.test/compare) (2026-08-20)

### 🚀 新增功能

* **更新:** 舊版內容
`;

    expect(buildReleaseMetadata(changelog, "v0.9.2")).toEqual({
      name: "LatticeTerm v0.9.2 - VNC：補發新版 Rust 像素分塊相容修正",
      body: "## 🛠️ 問題修正與優化\n\n- **VNC**：補發新版 Rust 像素分塊相容修正",
    });
  });

  it("保留人工撰寫的多層功能說明", () => {
    const changelog = `## [1.0.0] (2026-08-21)

### 🚀 新增功能
* **遠端桌面**：
  - 支援完整主螢幕加密傳輸。
  - 支援使用者自行錄影與截圖。
`;

    const result = buildReleaseMetadata(changelog, "v1.0.0");

    expect(result.name).toBe("LatticeTerm v1.0.0 - 遠端桌面");
    expect(result.body).toContain("## 🚀 新增功能");
    expect(result.body).toContain("- **遠端桌面**：");
    expect(result.body).toContain("  - 支援使用者自行錄影與截圖。");
  });

  it("統一混用的頂層項目符號且保留縮排子項目", () => {
    const changelog = `## [1.1.0] (2026-08-21)

### 🚀 新增功能
* **SSH:** 新增安全連線。
- **遠端桌面**：
  - 保留既有的縮排子項目。
`;

    const result = buildReleaseMetadata(changelog, "v1.1.0");

    expect(result.body).toBe(
      "## 🚀 新增功能\n\n- **SSH**：新增安全連線。\n- **遠端桌面**：\n  - 保留既有的縮排子項目。",
    );
    expect(result.body).not.toMatch(/^\* /m);
  });

  it("版本標題不納入 PR 或 Issue 參照連結", () => {
    const changelog = `## [0.9.4] (2026-08-21)

### 🛠️ 問題修正

* **更新:** 安裝完成後自動重新啟動 ([#37](https://github.com/example/repo/issues/37)) ([33192e5](https://github.com/example/repo/commit/33192e53c8ab43833aabdc578c29047d9fa0c5c9))
`;

    const result = buildReleaseMetadata(changelog, "v0.9.4");

    expect(result.name).toBe(
      "LatticeTerm v0.9.4 - 更新：安裝完成後自動重新啟動",
    );
    expect(result.body).toContain(
      "([#37](https://github.com/example/repo/issues/37))",
    );
  });

  it("拒絕不存在的版本，避免發布空白說明", () => {
    expect(() => buildReleaseMetadata("# 更新日誌", "v9.9.9")).toThrow(
      "CHANGELOG.md 找不到 9.9.9 的版本段落",
    );
  });

  it("以前三個主要項目組成產品化版本標題", () => {
    const changelog = `## [2.0.0] (2026-08-21)

### 🚀 新增功能
* **SSH 通道**：安全轉送。
* **原創主題**：新增七套主題。
* **工作階段續接**：保留歷史上下文。
* **其他功能**：不應進入標題。
`;

    expect(buildReleaseMetadata(changelog, "v2.0.0").name).toBe(
      "LatticeTerm v2.0.0 - SSH 通道、原創主題與工作階段續接",
    );
  });

  it("產品化版本標題不重複相同分類", () => {
    const changelog = `## [2.0.1] (2026-08-22)

### 🛠️ 問題修正
* **RDP**：修正畫面色彩。
* **RDP**：區分憑證錯誤。
* **VNC**：修正畫面邊界。
* **發布**：統一版本說明。
`;

    expect(buildReleaseMetadata(changelog, "v2.0.1").name).toBe(
      "LatticeTerm v2.0.1 - RDP、VNC與發布",
    );
  });

  it("大小寫不同的同一分類只算一次", () => {
    const changelog = `## [2.1.0] (2026-09-11)

### 🚀 新增功能
* **files:** 支援遠端純文字線上編輯
* **MCP:** 加入唯讀 MCP Server
* **mcp:** 加入操作紀錄
* **MCP:** 外部 AI 可送指示

### 🛠️ 問題修正
* **agents:** 避免窄視窗的狀態蓋住權限選項
`;

    expect(buildReleaseMetadata(changelog, "v2.1.0").name).toBe(
      "LatticeTerm v2.1.0 - files、MCP與 agents",
    );
  });

  it("多個項目只有同一分類時標題只保留分類名稱", () => {
    const changelog = `## [2.0.2] (2026-08-22)

### 🛠️ 問題修正
* **RDP**：修正畫面色彩。
* **RDP**：區分憑證錯誤。
`;

    expect(buildReleaseMetadata(changelog, "v2.0.2").name).toBe(
      "LatticeTerm v2.0.2 - RDP",
    );
  });

  it("連接英文縮寫前保留可讀空格", () => {
    const changelog = `## [2.1.0] (2026-08-21)

### 🚀 新增功能
* **大檔串流**：解除大小限制。
* **VNC 遠端桌面**：新增連線模式。
`;

    expect(buildReleaseMetadata(changelog, "v2.1.0").name).toBe(
      "LatticeTerm v2.1.0 - 大檔串流與 VNC 遠端桌面",
    );
  });

  it("合併提交與原提交描述相同時只保留一個版本項目", () => {
    const changelog = `## [0.9.6] (2026-08-21)

### 🛠️ 問題修正

* **SFTP:** 保護串流覆寫的原始檔案 ([835a4c5](https://github.com/example/repo/commit/835a4c5bf73ae67790eb95ed34b9811e2190d69d))
* **SFTP:** 保護串流覆寫的原始檔案 ([1bf2fc0](https://github.com/example/repo/commit/1bf2fc03566c87314cdba92cc34dfa56dd1f89a0))
`;

    const result = buildReleaseMetadata(changelog, "v0.9.6");

    expect(result.name).toBe(
      "LatticeTerm v0.9.6 - SFTP：保護串流覆寫的原始檔案",
    );
    expect(result.body.match(/保護串流覆寫的原始檔案/g)).toHaveLength(1);
  });

  it("不同版本可保留相同描述的項目", () => {
    const changelog = `## [0.9.6] (2026-08-21)

* **SFTP:** 保護串流覆寫的原始檔案 ([835a4c5](https://github.com/example/repo/commit/835a4c5bf73ae67790eb95ed34b9811e2190d69d))

## [0.9.5] (2026-08-20)

* **SFTP:** 保護串流覆寫的原始檔案 ([1bf2fc0](https://github.com/example/repo/commit/1bf2fc03566c87314cdba92cc34dfa56dd1f89a0))
`;

    const deduplicated = deduplicateChangelogEntries(changelog);

    expect(deduplicated.match(/保護串流覆寫的原始檔案/g)).toHaveLength(2);
  });
});
