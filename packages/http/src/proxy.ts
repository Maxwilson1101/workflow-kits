import { getProxyForUrl } from "proxy-from-env";

export interface Route {
  proxy?: string;
  description: string;
}

export function resolveRoute(url: string): Route {
  const proxy = getProxyForUrl(url);
  if (!proxy) {
    return {
      description:
        "Route: direct (no matching environment proxy, or bypassed by NO_PROXY). Check HTTPS_PROXY, HTTP_PROXY, ALL_PROXY and NO_PROXY if a proxy is required.",
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(proxy);
    decodeURIComponent(parsed.username);
    decodeURIComponent(parsed.password);
  } catch {
    throw new Error("Invalid environment proxy URL. Check HTTP_PROXY, HTTPS_PROXY and ALL_PROXY.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(
      "Unsupported environment proxy protocol. Use HTTP or HTTPS; SOCKS and PAC are not supported.",
    );
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(
      "Invalid environment proxy URL. Paths, queries and fragments are not supported.",
    );
  }
  return {
    proxy,
    description: `Route: environment proxy ${parsed.protocol}//${parsed.host}. Check that the proxy is running and can reach the destination; the error alone does not identify whether the proxy, destination or intervening network failed.`,
  };
}
