export const databaseEngines = [
  { value: "postgres", label: "PostgreSQL", port: 5432 },
  { value: "mysql", label: "MySQL", port: 3306 },
  { value: "mariadb", label: "MariaDB", port: 3306 },
  { value: "sqlServer", label: "SQL Server", port: 1433 },
  { value: "sqlite", label: "SQLite（本機檔案）", port: 0 },
] as const;

export type DatabaseEngine = (typeof databaseEngines)[number]["value"];

export interface DatabaseProfile {
  id: string;
  hostKey: string;
  name: string;
  engine: DatabaseEngine;
  hostname: string;
  port: number;
  username: string;
  database: string;
  sqlitePath: string;
  tlsCaPem?: string;
  allowMcpRead: boolean;
}

export interface DatabaseSnapshot {
  profiles: DatabaseProfile[];
  revision: string;
  credentialCleanupPending: number;
}

export interface DatabaseResult {
  columns: string[];
  rows: (string | null)[][];
  truncated: boolean;
  cellCharacterLimit: number;
  stableOrder: boolean;
}

export type DatabaseAction =
  | { kind: "version" | "tables"; profileId: string }
  | { kind: "columns"; profileId: string; schema: string; table: string }
  | { kind: "rows"; profileId: string; schema: string; table: string; limit: number; offset: number };

export function emptyDatabase(hostKey: string, hostname = ""): DatabaseProfile {
  return {
    id: crypto.randomUUID(), hostKey, name: "", engine: "postgres", hostname,
    port: 5432, username: "", database: "", sqlitePath: "", allowMcpRead: false,
  };
}

export function changeDatabaseEngine(profile: DatabaseProfile, engine: DatabaseEngine): DatabaseProfile {
  return {
    ...profile, engine, port: databaseEngines.find((entry) => entry.value === engine)!.port,
    hostname: engine === "sqlite" ? "" : profile.hostname,
    username: engine === "sqlite" ? "" : profile.username,
    database: engine === "sqlite" ? "" : profile.database,
    sqlitePath: "", tlsCaPem: "", allowMcpRead: false,
  };
}
