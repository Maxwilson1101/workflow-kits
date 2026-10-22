import { afterEach, describe, expect, test } from "bun:test";
import { resolveRoute } from "../../src/proxy.ts";

const keys = [
  "http_proxy",
  "HTTP_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
  "all_proxy",
  "ALL_PROXY",
  "no_proxy",
  "NO_PROXY",
];
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

function environment(values: Record<string, string>) {
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, values);
}

afterEach(() => {
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

describe("proxy routing", () => {
  test("uses lowercase protocol settings before uppercase and ALL_PROXY", () => {
    environment({
      http_proxy: "http://localhost:8000",
      HTTP_PROXY: "http://localhost:8001",
      https_proxy: "http://localhost:8002",
      HTTPS_PROXY: "http://localhost:8003",
      ALL_PROXY: "http://localhost:8004",
    });
    expect(resolveRoute("http://example.test").proxy).toBe("http://localhost:8000");
    expect(resolveRoute("https://example.test").proxy).toBe("http://localhost:8002");
    delete process.env.https_proxy;
    expect(resolveRoute("https://example.test").proxy).toBe("http://localhost:8003");
    delete process.env.HTTPS_PROXY;
    expect(resolveRoute("https://example.test").proxy).toBe("http://localhost:8004");
    process.env.all_proxy = "http://localhost:8005";
    expect(resolveRoute("https://example.test").proxy).toBe("http://localhost:8005");
  });

  test.each([
    ["example.test", "https://example.test", true],
    ["example.test", "https://sub.example.test", false],
    [".example.test", "https://sub.example.test", true],
    [".example.test", "https://example.test", false],
    ["*.example.test", "https://sub.example.test", true],
    ["example.test:443", "https://example.test", true],
    ["example.test:443", "https://example.test:8443", false],
    ["[::1]:8080", "http://[::1]:8080", true],
    ["other.test, example.test", "https://example.test", true],
    ["*", "https://example.test", true],
  ])("NO_PROXY %s routes %s (direct=%s)", (bypass, url, direct) => {
    environment({ ALL_PROXY: "http://localhost:8000", NO_PROXY: bypass });
    expect(resolveRoute(url).proxy === undefined).toBe(direct);
  });

  test("lowercase NO_PROXY takes precedence and no configuration means direct", () => {
    environment({ ALL_PROXY: "http://localhost:8000", NO_PROXY: "*", no_proxy: "other.test" });
    expect(resolveRoute("https://example.test").proxy).toBeDefined();
    environment({});
    expect(resolveRoute("https://example.test").description).toContain("Route: direct");
  });

  test("empty lowercase settings fall back to uppercase and empty protocol settings to ALL_PROXY", () => {
    environment({
      https_proxy: "",
      HTTPS_PROXY: "http://localhost:8000",
      ALL_PROXY: "http://localhost:8001",
    });
    expect(resolveRoute("https://example.test").proxy).toBe("http://localhost:8000");
    process.env.HTTPS_PROXY = "";
    expect(resolveRoute("https://example.test").proxy).toBe("http://localhost:8001");
    process.env.no_proxy = "";
    process.env.NO_PROXY = "*";
    expect(resolveRoute("https://example.test").proxy).toBeUndefined();
  });

  test.each([
    "socks5://user:secret@localhost:8000",
    "http://user:secret@[",
    "http://user:secret@localhost:8000/path",
    "http://user:secret@localhost:8000?token=x",
  ])("rejects unsupported configuration without disclosing it: %s", (proxy) => {
    environment({ HTTPS_PROXY: proxy });
    let failure: unknown;
    try {
      resolveRoute("https://example.test");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("proxy");
    expect(String(failure)).not.toContain("secret");
  });

  test("diagnostics contain the proxy origin but not credentials", () => {
    environment({ HTTPS_PROXY: "http://alice:p%40ssword@localhost:8000" });
    const route = resolveRoute("https://example.test");
    expect(route.description).toContain("http://localhost:8000");
    expect(route.description).not.toMatch(/alice|p%40ssword|p@ssword/);
  });
});
