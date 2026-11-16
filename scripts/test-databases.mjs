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
let network;
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
if (run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 15000 }).status !== 0) {
  console.log("SKIP: Docker is unavailable; isolated database and SSH acceptance did not run.");
  rmSync(directory, { recursive: true, force: true });
  process.exit(0);
}
try {
  const build = checked(cargo, ["test", "--manifest-path", resolve("src-tauri/Cargo.toml"), "--lib", "isolated_network_databases_", "--no-run", "--message-format=json"], { timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
  const artifacts = build.split("\n").filter(Boolean).map(line => JSON.parse(line));
  const testBinary = artifacts.find(item => item.reason === "compiler-artifact" && item.target.name === "latticeterm_lib" && item.profile.test && item.executable)?.executable;
  if (!testBinary) throw new Error("Database test executable was not emitted");
  network = `latticeterm-db-qa-${randomBytes(6).toString("hex")}`;
  checked("docker", ["network", "create", network]);
  writeFileSync(join(directory, "sshd_config"), "Port 2222\nListenAddress 0.0.0.0\nHostKey /tmp/host\nAuthorizedKeysFile /tmp/client.pub\nStrictModes no\nPermitRootLogin yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nAllowTcpForwarding yes\nUsePAM no\nPidFile /tmp/sshd.pid\nLogLevel ERROR\n");
  const sshName = `${network}-ssh`;
  const sshId = checked("docker", ["run", "-d", "--name", sshName, "--network", network, "--user", "root", "-e", `LATTICETERM_TEST_SSH_PASSWORD=${randomBytes(32).toString("hex")}`, "--tmpfs", "/tmp", "-p", "127.0.0.1::2222", "--mount", `type=bind,source=${directory},target=/qa,readonly`, "--entrypoint", "sh", "linuxserver/openssh-server:latest", "-c", "mkdir -p /run/sshd; ssh-keygen -q -t ed25519 -N '' -f /tmp/host; ssh-keygen -q -t ed25519 -N '' -f /tmp/client; echo root:$LATTICETERM_TEST_SSH_PASSWORD | chpasswd; unset LATTICETERM_TEST_SSH_PASSWORD; exec /usr/sbin/sshd.pam -D -e -f /qa/sshd_config"]);
  containers.add(sshId);
  let sshReady = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    if (run("docker", ["exec", sshId, "sh", "-c", "test -s /tmp/sshd.pid"]).status === 0) { sshReady = true; break; }
    await setTimeout(500);
  }
  if (!sshReady) throw new Error("Isolated sshd did not become ready");
  writeFileSync(join(directory, "ssh-client"), checked("docker", ["exec", sshId, "cat", "/tmp/client"]), { mode: 0o600 });
  writeFileSync(join(directory, "ssh-host.pub"), checked("docker", ["exec", sshId, "cat", "/tmp/host.pub"]), { mode: 0o600 });
  const sshPort = Number(checked("docker", ["port", sshId, "2222/tcp"]).split(":").at(-1));
  checked(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=LatticeTerm isolated QA CA", "-keyout", join(directory, "ca.key"), "-out", join(directory, "ca.crt")]);
  checked(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Unrelated isolated QA CA", "-keyout", join(directory, "wrong-ca.key"), "-out", join(directory, "wrong-ca.crt")]);
  checked(openssl, ["req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-keyout", join(directory, "server.key"), "-out", join(directory, "server.csr")]);
  writeFileSync(join(directory, "extensions"), "subjectAltName=DNS:localhost,DNS:database\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\n");
  checked(openssl, ["x509", "-req", "-days", "1", "-in", join(directory, "server.csr"), "-CA", join(directory, "ca.crt"), "-CAkey", join(directory, "ca.key"), "-CAcreateserial", "-extfile", join(directory, "extensions"), "-out", join(directory, "server.crt")]);
  writeFileSync(join(directory, "mssql.conf"), "[network]\ntlscert = /tmp/server.crt\ntlskey = /tmp/server.key\nforceencryption = 1\ntlsprotocols = 1.2\n");
  for (const [engine, image, internalPort] of matrix.filter(([engine]) => !selected || engine === selected)) {
    console.log(`Starting isolated ${engine} (${image}); waiting for the final TCP listener`);
    const name = `latticeterm-db-qa-${randomBytes(6).toString("hex")}`;
    const adminPassword = `Qa1!${randomBytes(24).toString("hex")}`;
    const password = `Read1!${randomBytes(24).toString("hex")}`;
    const writerPassword = `Write1!${randomBytes(24).toString("hex")}`;
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
    const containerId = checked("docker", ["run", "-d", "--name", name, "--network", network, "--network-alias", "database", "--user", "root", "-p", `127.0.0.1::${internalPort}`, "--mount", `type=bind,source=${directory},target=/qa,readonly`, ...temporaryData, ...environment, "--entrypoint", "sh", image, "-c", command]);
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
    const workbenchSeed = postgres
      ? `CREATE TABLE sql_workbench_qa(id integer PRIMARY KEY, value text); INSERT INTO sql_workbench_qa VALUES(1,'原始'); CREATE USER writer WITH PASSWORD '${writerPassword}'; GRANT CONNECT ON DATABASE sample TO writer; GRANT USAGE ON SCHEMA public TO writer; GRANT SELECT ON sql_workbench_qa TO reader; GRANT SELECT,INSERT,UPDATE,DELETE ON sql_workbench_qa TO writer;`
      : sqlServer
        ? `USE sample; CREATE TABLE sql_workbench_qa(id int PRIMARY KEY, value nvarchar(1000)); INSERT INTO sql_workbench_qa VALUES(1,N'原始'); CREATE LOGIN writer WITH PASSWORD='${writerPassword}'; CREATE USER writer FOR LOGIN writer; GRANT SELECT,INSERT,UPDATE,DELETE ON sql_workbench_qa TO writer;\nGO\n`
        : `USE sample; CREATE TABLE sql_workbench_qa(id int PRIMARY KEY, value text CHARACTER SET utf8mb4); INSERT INTO sql_workbench_qa VALUES(1,'原始'); CREATE USER 'writer'@'%' IDENTIFIED BY '${writerPassword}'; GRANT SELECT,INSERT,UPDATE,DELETE ON sample.sql_workbench_qa TO 'writer'@'%';`;
    checked("docker", exec, { input: workbenchSeed });
    const { readFileSync } = await import("node:fs");
    const fixture = join(directory, "fixture.json");
    writeFileSync(fixture, JSON.stringify({ profile: { id: "isolated", hostKey: "isolated", name: "隔離測試", engine, hostname: "localhost", port, username: "reader", database: "sample", sqlitePath: "", tlsCaPem: readFileSync(join(directory, "ca.crt"), "utf8"), allowMcpRead: false }, password, writerPassword, ssh: { port: sshPort, privateKey: join(directory, "ssh-client"), hostPublicKey: join(directory, "ssh-host.pub"), databasePort: internalPort }, wrongCaPem: readFileSync(join(directory, "wrong-ca.crt"), "utf8") }), { mode: 0o600 });
    console.log(`Testing ${engine} (${image}) with verified TLS, read-only access and isolated SQL CRUD`);
    const env = { ...process.env, LATTICETERM_TEST_DATABASES_JSON: fixture };
    const result = run(testBinary, ["database::network_tests::isolated_network_databases_", "--ignored", "--nocapture"], { env, stdio: "inherit", timeout: 600000 });
    if (result.status !== 0) throw new Error(`${engine} TLS acceptance failed`);
    console.log(`Testing ${engine} direct and DatabaseRoute::Ssh with no external tools in PATH`);
    const isolated = run(testBinary, ["database::tool_free_tests::isolated_network_databases_without_external_tools_direct_and_ssh", "--exact", "--ignored", "--nocapture"], {
      env: { ...env, PATH: join(directory, "unavailable-path") }, stdio: "inherit", timeout: 120000,
    });
    if (isolated.status !== 0) throw new Error(`${engine} tool-free direct/SSH acceptance failed`);
    console.log(`Testing native jump SSH shell and ${engine} forwarding lifecycle`);
    const jump = run(testBinary, ["jump::tests::isolated_jump_ssh_and_sql", "--exact", "--ignored", "--nocapture"], {
      env: { ...env, PATH: join(directory, "unavailable-path") }, stdio: "inherit", timeout: 120000,
    });
    if (jump.status !== 0) throw new Error(`${engine} jump SSH/SQL acceptance failed`);
    checked("docker", ["rm", "-f", "-v", containerId]);
    containers.delete(containerId);
  }
} finally {
  for (const containerId of containers) run("docker", ["rm", "-f", "-v", containerId]);
  if (network) run("docker", ["network", "rm", network]);
  if (existsSync(directory)) {
    const cleanupPath = realpathSync(directory);
    if (cleanupPath !== directory || dirname(cleanupPath) !== temporaryRoot) throw new Error("Refusing cleanup outside the isolated temporary directory");
    rmSync(cleanupPath, { recursive: true, force: true });
  }
}
