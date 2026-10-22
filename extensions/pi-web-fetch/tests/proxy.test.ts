import { afterEach, describe, expect, test } from "bun:test";
import { createClient } from "../src/client.ts";
import { createTransport } from "../src/proxy.ts";

const keys = [
  "http_proxy",
  "HTTP_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
  "all_proxy",
  "ALL_PROXY",
  "no_proxy",
  "NO_PROXY",
  "npm_config_http_proxy",
  "npm_config_https_proxy",
  "npm_config_proxy",
  "npm_config_no_proxy",
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

describe("environment proxy", () => {
  test("selects protocol-specific proxies and reuses dispatchers", () => {
    environment({ HTTP_PROXY: "http://localhost:8080", HTTPS_PROXY: "http://localhost:8081" });
    const route = createTransport();
    expect(route("http://example.com").description).toContain("localhost:8080");
    expect(route("https://example.com").description).toContain("localhost:8081");
    expect(route("https://example.com").options).toEqual(route("https://other.com").options);
  });

  test("honors lowercase precedence, ALL_PROXY and NO_PROXY per target", () => {
    environment({
      https_proxy: "http://localhost:8081",
      HTTPS_PROXY: "http://localhost:8082",
      ALL_PROXY: "http://localhost:8083",
      NO_PROXY: ".example.com,localhost:8080",
    });
    const route = createTransport();
    expect(route("https://other.com").description).toContain("localhost:8081");
    expect(route("http://other.com").description).toContain("localhost:8083");
    expect(route("https://sub.example.com").description).toContain("Route: direct");
    expect(route("http://localhost:8080").description).toContain("Route: direct");
    expect(route("http://localhost:8081").description).toContain("environment proxy");
    process.env.NO_PROXY = "*";
    expect(route("https://other.com").options).toEqual({});
  });

  test("rejects unsupported or invalid proxies without revealing credentials", () => {
    for (const proxy of ["socks5://user:secret@localhost:1080", "http://user:secret@["]) {
      environment({ HTTPS_PROXY: proxy });
      try {
        createTransport()("https://example.com");
        throw new Error("Expected proxy configuration error");
      } catch (error) {
        expect(String(error)).toContain("proxy");
        expect(String(error)).not.toContain("secret");
      }
    }
  });

  test("reports the selected route and network code without credentials", async () => {
    environment({ HTTPS_PROXY: "http://user:secret@localhost:8080" });
    const request = createClient({
      fetch: async (_url, init) => {
        expect(init).toHaveProperty("dispatcher");
        throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
      },
    });
    try {
      await request("https://example.com");
      throw new Error("Expected network error");
    } catch (error) {
      expect(String(error)).toContain("Route: environment proxy http://localhost:8080");
      expect(String(error)).toContain("ECONNRESET");
      expect(String(error)).not.toContain("secret");
    }
  });

  test("explains direct connections when no proxy matches", async () => {
    environment({});
    await expect(
      createClient({
        fetch: async () => {
          throw new Error("offline");
        },
      })("https://example.com"),
    ).rejects.toThrow("Route: direct");
  });
});
