import { beforeEach } from "bun:test";

function clearProxyEnvironment() {
  for (const name of Object.keys(process.env)) {
    if (/_proxy$/i.test(name)) delete process.env[name];
  }
}

clearProxyEnvironment();
beforeEach(clearProxyEnvironment);
