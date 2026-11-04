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
it("lists associated databases independently as well as through their remote card", () => {
  const attached = {...db,hostKey:"machine"};
  expect(databaseListEntries([attached],[host],[host],"all")).toEqual([attached]);
  expect(databaseListEntries([attached],[host],[host],"database")).toEqual([attached]);
  expect(databaseListEntries([attached],[host],[],"all",{...emptyFilter,search:"orders"})).toEqual([attached]);
  expect(databaseRemoteHost(attached,[host])).toBe(host);
});
it("does not make standalone databases match remote protocol or environment filters", () => {
  expect(databaseListEntries([db],[],[],"all",{...emptyFilter,protocols:["ssh"]})).toEqual([]);
  expect(databaseListEntries([db],[],[],"remote")).toEqual([]);
});
