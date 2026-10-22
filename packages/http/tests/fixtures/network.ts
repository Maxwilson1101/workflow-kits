import { once } from "node:events";
import { readFileSync } from "node:fs";
import {
  createServer,
  request,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createSecureServer } from "node:https";
import { connect, type Socket } from "node:net";

export const tls = () => {
  const key = process.env.HTTP_TEST_KEY;
  const cert = process.env.HTTP_TEST_CERT;
  if (!key || !cert) {
    throw new Error(
      "Network tests need the certificate harness; run `bun run --filter @workflow-kits/http test:network`.",
    );
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
};

export async function listen(server: Server, secure = false) {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address.");
  return {
    server,
    port: address.port,
    url: `${secure ? "https://localhost" : "http://127.0.0.1"}:${address.port}`,
    async close() {
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}

export async function origin(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  secure = false,
) {
  return listen(secure ? createSecureServer(tls(), handler) : createServer(handler), secure);
}

export async function proxy(
  options: { targetPort?: number; auth?: string; status?: number; secure?: boolean } = {},
) {
  const records: { target: string; authorization: string | undefined }[] = [];
  const upstreams = new Set<Socket>();
  const server = options.secure ? createSecureServer(tls()) : createServer();
  server.on("request", (req, res) => {
    records.push({ target: req.url ?? "", authorization: req.headers["proxy-authorization"] });
    const status =
      options.status ??
      (options.auth && req.headers["proxy-authorization"] !== options.auth ? 407 : 200);
    if (status !== 200) {
      res.writeHead(status);
      res.end();
      return;
    }
    const target = new URL(req.url!);
    if (!options.targetPort && target.hostname !== "127.0.0.1") {
      res.writeHead(502);
      res.end();
      return;
    }
    const headers = { ...req.headers };
    delete headers["proxy-authorization"];
    const upstream = request(
      {
        host: "127.0.0.1",
        port: options.targetPort ?? target.port,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers,
      },
      (response) => {
        res.writeHead(response.statusCode!, response.headers);
        res.flushHeaders();
        response.on("error", () => res.destroy());
        response.pipe(res);
      },
    );
    upstream.on("socket", (socket) => {
      upstreams.add(socket);
      socket.on("close", () => upstreams.delete(socket));
    });
    upstream.on("error", () => {
      res.destroy();
    });
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on("connect", (req, socket, head) => {
    records.push({ target: req.url ?? "", authorization: req.headers["proxy-authorization"] });
    const status =
      options.status ??
      (options.auth && req.headers["proxy-authorization"] !== options.auth ? 407 : 200);
    if (status !== 200) {
      socket.end(`HTTP/1.1 ${status} Rejected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      return;
    }
    const target = new URL(`http://${req.url}`);
    if (!options.targetPort && !["127.0.0.1", "localhost"].includes(target.hostname)) {
      socket.end("HTTP/1.1 502 Rejected\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const upstream = connect(options.targetPort ?? Number(target.port), "127.0.0.1");
    upstreams.add(upstream);
    upstream.once("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => {
      upstreams.delete(upstream);
      socket.destroy();
    });
  });
  const bound = await listen(server, options.secure);
  return {
    ...bound,
    records,
    async close() {
      for (const socket of upstreams) socket.destroy();
      await bound.close();
    },
  };
}

export function environment(values: Record<string, string> = {}) {
  for (const key of Object.keys(process.env)) if (/_proxy$/i.test(key)) delete process.env[key];
  Object.assign(process.env, values);
}
