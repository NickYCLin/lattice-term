import { expect, it } from "vitest";
import { emptyDatabase } from "./database";
import { createConnectionProfile, emptyDraft } from "./connection";
import { emptyFilter } from "./query";
import { databaseListEntries, databaseRemoteHost } from "./connectionSetup";
const host = {...createConnectionProfile({...emptyDraft(),name:"主機",hostname:"host.invalid"},"ssh"),machineId:"machine"};
const db = {...emptyDatabase("local"),id:"db",name:"訂單",database:"orders"};
it("lists database-only and orphaned records without inventing remote hosts", () => {
  const orphan = {...db,id:"orphan",hostKey:"deleted-host"};
  expect(databaseListEntries([db,orphan],[],[],"all")).toEqual([db,orphan]);
  expect(databaseRemoteHost(db,[])).toBeUndefined();
});
it("folds a database into its visible remote card and still exposes database-only searches", () => {
  const attached = {...db,hostKey:"machine"};
  expect(databaseListEntries([attached],[host],[host],"all")).toEqual([]);
  expect(databaseListEntries([attached],[host],[host],"database")).toEqual([attached]);
  expect(databaseListEntries([attached],[host],[],"all",{...emptyFilter,search:"orders"})).toEqual([attached]);
  expect(databaseRemoteHost(attached,[host])).toBe(host);
});
it("folds legacy route identities into another visible route of the same card", () => {
  const peer = {...host, id:"rdp", protocol:"rdp" as const};
  const attached = {...db,hostKey:peer.id};
  expect(databaseListEntries([attached],[host,peer],[host],"all")).toEqual([]);
  expect(databaseListEntries([attached],[host,peer],[host],"database",{...emptyFilter,protocols:["ssh"]})).toEqual([attached]);
  expect(databaseListEntries([attached],[host,peer],[],"all",{...emptyFilter,search:"orders"})).toEqual([attached]);
});
it("does not make standalone databases match remote protocol or environment filters", () => {
  expect(databaseListEntries([db],[],[],"all",{...emptyFilter,protocols:["ssh"]})).toEqual([]);
  expect(databaseListEntries([db],[],[],"remote")).toEqual([]);
});
