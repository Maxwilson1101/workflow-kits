import { getProxyForUrl } from "proxy-from-env";
import { ProxyAgent } from "undici";

export function createTransport() {
  const agents = new Map<string, ProxyAgent>();

  return (url: string) => {
    const proxy = getProxyForUrl(url);
    if (!proxy) {
      return {
        options: {},
        description:
          "Route: direct (no matching environment proxy, or bypassed by NO_PROXY). Check HTTPS_PROXY, HTTP_PROXY, ALL_PROXY and NO_PROXY if a proxy is required.",
      };
    }

    let parsed: URL;
    try {
      parsed = new URL(proxy);
    } catch {
      throw new Error(
        "Invalid environment proxy URL. Check HTTPS_PROXY, HTTP_PROXY and ALL_PROXY; use an HTTP or HTTPS proxy URL.",
      );
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(
        "Unsupported environment proxy protocol. Use an HTTP or HTTPS proxy URL; SOCKS and PAC proxies are not supported.",
      );
    }
    let dispatcher = agents.get(proxy);
    if (!dispatcher) {
      dispatcher = new ProxyAgent(proxy);
      agents.set(proxy, dispatcher);
    }
    return {
      options: { dispatcher },
      description: `Route: environment proxy ${parsed.protocol}//${parsed.host}. Check that the proxy is running and can reach the destination; the error alone does not identify whether the proxy, destination or intervening network failed.`,
    };
  };
}
