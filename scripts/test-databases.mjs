import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

const temporaryRoot = realpathSync(tmpdir());
const directory = mkdtempSync(join(temporaryRoot, "latticeterm-db-"));
const openssl = process.env.OPENSSL ?? (process.platform === "win32" ? "C:/Program Files/Git/usr/bin/openssl.exe" : "openssl");
const cargo = process.platform === "win32" ? join(homedir(), ".cargo/bin/cargo.exe") : "cargo";
const containers = new Set();
function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", timeout: 120000, ...options });
}
function checked(command, args, options) {
  const result = run(command, args, options);
  if (result.status !== 0) throw new Error(`${command} failed (exit ${result.status}); no credentials or server output are printed`);
  return (result.stdout ?? "").trim();
}
const selected = process.argv[2];
const matrix = [
  ["postgres", "postgres:17-alpine", 5432],
  ["mysql", "mysql:8.0", 3306],
  ["mariadb", "mariadb:11.4", 3306],
  ["sqlServer", "mcr.microsoft.com/mssql/server:2022-latest", 1433],
];
if (selected && !matrix.some(([engine]) => engine === selected)) throw new Error("Choose postgres, mysql, mariadb or sqlServer");
try {
  checked("docker", ["info", "--format", "{{.ServerVersion}}"]);
  checked(cargo, ["test", "--manifest-path", resolve("src-tauri/Cargo.toml"), "--lib", "isolated_network_databases_", "--no-run"], { stdio: "inherit", timeout: 600000 });
  checked(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=LatticeTerm isolated QA CA", "-keyout", join(directory, "ca.key"), "-out", join(directory, "ca.crt")]);
  checked(openssl, ["req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-keyout", join(directory, "server.key"), "-out", join(directory, "server.csr")]);
  writeFileSync(join(directory, "extensions"), "subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\n");
  checked(openssl, ["x509", "-req", "-days", "1", "-in", join(directory, "server.csr"), "-CA", join(directory, "ca.crt"), "-CAkey", join(directory, "ca.key"), "-CAcreateserial", "-extfile", join(directory, "extensions"), "-out", join(directory, "server.crt")]);
  writeFileSync(join(directory, "mssql.conf"), "[network]\ntlscert = /tmp/server.crt\ntlskey = /tmp/server.key\nforceencryption = 1\ntlsprotocols = 1.2\n");
  for (const [engine, image, internalPort] of matrix.filter(([engine]) => !selected || engine === selected)) {
    console.log(`Starting isolated ${engine} (${image}); waiting for the final TCP listener`);
    const name = `latticeterm-db-qa-${randomBytes(6).toString("hex")}`;
    const adminPassword = `Qa1!${randomBytes(24).toString("hex")}`;
    const password = `Read1!${randomBytes(24).toString("hex")}`;
    const postgres = engine === "postgres";
    const sqlServer = engine === "sqlServer";
    const copy = "cp /qa/server.crt /qa/server.key /qa/ca.crt /tmp/; chmod 600 /tmp/server.key; ";
    const command = postgres
      ? `${copy}chown postgres /tmp/server.*; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key`
      : sqlServer
        ? `${copy}cp /qa/mssql.conf /var/opt/mssql/mssql.conf; chown mssql /tmp/server.* /var/opt/mssql/mssql.conf; exec /opt/mssql/bin/sqlservr`
        : `${copy}chown mysql /tmp/server.*; exec docker-entrypoint.sh ${engine === "mariadb" ? "mariadbd" : "mysqld"} --ssl-ca=/tmp/ca.crt --ssl-cert=/tmp/server.crt --ssl-key=/tmp/server.key --require-secure-transport=ON --character-set-server=utf8mb4`;
    const environment = postgres ? ["-e", `POSTGRES_PASSWORD=${adminPassword}`, "-e", "POSTGRES_DB=sample"]
      : sqlServer ? ["-e", "ACCEPT_EULA=Y", "-e", `MSSQL_SA_PASSWORD=${adminPassword}`, "-e", "MSSQL_PID=Developer"]
        : ["-e", `MYSQL_ROOT_PASSWORD=${adminPassword}`, "-e", "MYSQL_DATABASE=sample"];
    const dataDirectory = postgres ? "/var/lib/postgresql/data" : sqlServer ? "/var/opt/mssql" : "/var/lib/mysql";
    const temporaryData = ["--tmpfs", `${dataDirectory}:rw,size=${sqlServer ? "2g" : "1g"}`];
    const containerId = checked("docker", ["run", "-d", "--name", name, "--user", "root", "-p", `127.0.0.1::${internalPort}`, "--mount", `type=bind,source=${directory},target=/qa,readonly`, ...temporaryData, ...environment, "--entrypoint", "sh", image, "-c", command]);
    containers.add(containerId);
    const port = Number(checked("docker", ["port", name, `${internalPort}/tcp`]).split(":").at(-1));
    const longText = "長".repeat(700);
    const seed = postgres
      ? `CREATE TABLE sample(id integer, value text); INSERT INTO sample VALUES (1,NULL),(2,'繁體中文🙂'),(3,'${longText}'); CREATE USER reader WITH PASSWORD '${password}'; GRANT CONNECT ON DATABASE sample TO reader; GRANT USAGE ON SCHEMA public TO reader; GRANT SELECT ON sample TO reader;`
      : sqlServer
        ? `CREATE DATABASE sample;\nGO\nUSE sample;\nCREATE TABLE sample(id int, value nvarchar(1000)); INSERT INTO sample VALUES (1,NULL),(2,N'繁體中文🙂'),(3,N'${longText}'); CREATE LOGIN reader WITH PASSWORD='${password}'; CREATE USER reader FOR LOGIN reader; ALTER ROLE db_datareader ADD MEMBER reader;\nGO\n`
        : `USE sample; CREATE TABLE sample(id int, value text CHARACTER SET utf8mb4); INSERT INTO sample VALUES (1,NULL),(2,'繁體中文🙂'),(3,'${longText}'); CREATE USER 'reader'@'%' IDENTIFIED BY '${password}'; GRANT SELECT ON sample.* TO 'reader'@'%';`;
    const executable = sqlServer ? checked("docker", ["exec", name, "sh", "-c", "if test -x /opt/mssql-tools18/bin/sqlcmd; then echo /opt/mssql-tools18/bin/sqlcmd; else echo /opt/mssql-tools/bin/sqlcmd; fi"]) : engine === "mariadb" ? "mariadb" : "mysql";
    const exec = postgres ? ["exec", "-i", "-e", `PGPASSWORD=${adminPassword}`, name, "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", "sample", "-v", "ON_ERROR_STOP=1"]
      : sqlServer ? ["exec", "-i", name, executable, "-S", "localhost", "-U", "sa", "-P", adminPassword, "-C", "-b"]
        : ["exec", "-i", name, executable, "--protocol=TCP", "-h", "localhost", "--ssl-ca=/tmp/ca.crt", "-u", "root", `-p${adminPassword}`, "--default-character-set=utf8mb4"];
    let ready = false;
    for (let attempt = 0; attempt < 180; attempt++) {
      const probe = run("docker", exec, { input: "SELECT 1;\n", timeout: 5000 });
      if (probe.status === 0) { ready = true; break; }
      await setTimeout(2000);
    }
    if (!ready) throw new Error(`${engine} did not become ready`);
    checked("docker", exec, { input: seed });
    const { readFileSync } = await import("node:fs");
    const fixture = join(directory, "fixture.json");
    writeFileSync(fixture, JSON.stringify({ profile: { id: "isolated", hostKey: "isolated", name: "隔離測試", engine, hostname: "localhost", port, username: "reader", database: "sample", sqlitePath: "", tlsCaPem: readFileSync(join(directory, "ca.crt"), "utf8"), allowMcpRead: false }, password }), { mode: 0o600 });
    console.log(`Testing ${engine} (${image}) with verified TLS and a read-only account`);
    const result = run(cargo, ["test", "--manifest-path", resolve("src-tauri/Cargo.toml"), "--lib", "isolated_network_databases_", "--", "--ignored", "--nocapture"], { env: { ...process.env, LATTICETERM_TEST_DATABASES_JSON: fixture }, stdio: "inherit", timeout: 600000 });
    if (result.status !== 0) throw new Error(`${engine} acceptance failed`);
    checked("docker", ["rm", "-f", "-v", containerId]);
    containers.delete(containerId);
  }
} finally {
  for (const containerId of containers) run("docker", ["rm", "-f", "-v", containerId]);
  if (existsSync(directory)) {
    const cleanupPath = realpathSync(directory);
    if (cleanupPath !== directory || dirname(cleanupPath) !== temporaryRoot) throw new Error("Refusing cleanup outside the isolated temporary directory");
    rmSync(cleanupPath, { recursive: true, force: true });
  }
}
