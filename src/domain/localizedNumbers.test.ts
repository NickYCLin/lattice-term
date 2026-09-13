import { expect, it } from "vitest";
import { formatBytes } from "./metrics";
import { formatBytes as tunnelBytes } from "./tunnel";
it("formats transfer sizes with the selected locale's decimal separator", () => {
  expect(formatBytes(1536, "en")).toBe("1.5 KB");
  expect(formatBytes(1536, "fr-FR")).toBe("1,5 KB");
  expect(formatBytes(1536, "de-DE")).toBe("1,5 KB");
  expect(formatBytes(1536, "pt-BR")).toBe("1,5 KB");
  expect(tunnelBytes(1536, "es")).toBe("1,5 KB");
  expect(tunnelBytes(Number.NaN, "en")).toBe("—");
});
