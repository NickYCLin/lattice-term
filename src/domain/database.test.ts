import { describe, expect, it } from "vitest";
import { changeDatabaseEngine, databaseEngines, emptyDatabase } from "./database";

describe("database profiles", () => {
  it("creates independent identities on the same host with MCP off until explicitly enabled", () => {
    const first = emptyDatabase("host", "database.invalid");
    const second = emptyDatabase("host", "database.invalid");
    expect(first.id).not.toBe(second.id);
    expect(first.hostKey).toBe(second.hostKey);
    expect(first.allowMcpRead).toBe(false);
    expect(first).not.toHaveProperty("password");
    expect(databaseEngines.map((entry) => entry.value)).toEqual(["postgres", "mysql", "mariadb", "sqlServer", "sqlite"]);
  });
  it("resets the port and permission when switching engines and removes incompatible fields", () => {
    const original = { ...emptyDatabase("host", "database.invalid"), username: "reader", database: "sample", allowMcpRead: true };
    const sqlite = changeDatabaseEngine(original, "sqlite");
    expect(sqlite).toMatchObject({ id: original.id, hostKey: "host", hostname: "", username: "", database: "", port: 0, allowMcpRead: false });
    expect(changeDatabaseEngine({ ...sqlite, sqlitePath: "C:/sample.sqlite" }, "sqlServer")).toMatchObject({ port: 1433, sqlitePath: "", allowMcpRead: false });
  });
});
