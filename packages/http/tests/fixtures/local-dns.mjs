import dns from "node:dns";

const lookup = dns.lookup;
dns.lookup = (hostname, options, callback) => {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  if (["localhost", "127.0.0.1", "::1"].includes(hostname))
    return lookup(hostname, options, callback);
  const error = Object.assign(new Error("Network tests only resolve loopback hosts."), {
    code: "ENOTFOUND",
  });
  queueMicrotask(() => callback(error));
};
