import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "workflow-http-tls-"));
try {
  const key = join(root, "key.pem");
  const cert = join(root, "cert.pem");
  const generated = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:example.test,DNS:en.wikipedia.org,DNS:export.arxiv.org,DNS:arxiv.org",
    ],
    { encoding: "utf8" },
  );
  if (generated.error || generated.status !== 0) {
    throw new Error(
      `OpenSSL is required to generate isolated test certificates: ${generated.error?.message ?? generated.stderr}`,
    );
  }
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (
      /_proxy$/i.test(name) ||
      name.startsWith("npm_config_proxy") ||
      name === "NODE_OPTIONS" ||
      name === "NODE_TLS_REJECT_UNAUTHORIZED" ||
      name === "NODE_USE_ENV_PROXY"
    )
      delete env[name];
  }
  const files = process.argv.slice(2);
  const defaultPattern = fileURLToPath(new URL("./network/*.network.ts", import.meta.url));
  const run = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--import",
      new URL("./fixtures/local-dns.mjs", import.meta.url).href,
      "--test",
      ...(files.length ? files : [defaultPattern]),
    ],
    {
      stdio: "inherit",
      env: { ...env, NODE_EXTRA_CA_CERTS: cert, HTTP_TEST_CERT: cert, HTTP_TEST_KEY: key },
    },
  );
  if (run.error) throw run.error;
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
