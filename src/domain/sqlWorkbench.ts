import type { DatabaseResult } from "./database";

export interface SqlWorkbenchState {
  id: string;
  profileId: string;
  name: string;
  target?: string;
  sql: string;
  revision: number;
  busy: boolean;
  shareRead: boolean;
  shareEdit: boolean;
  detached: boolean;
  updatedBy: "user" | "mcp";
  lastSql: string;
  result: (DatabaseResult & { affectedRows: number | null }) | null;
  error: string | null;
}

export function draggedOutside(x: number, y: number, width: number, height: number): boolean {
  return x < 0 || y < 0 || x > width || y > height;
}

export function workbenchWindowId(search: string): string | null {
  const id = new URLSearchParams(search).get("database-workbench");
  return id && /^[a-f0-9]{32}$/.test(id) ? id : null;
}
