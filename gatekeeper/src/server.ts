import http from "node:http";
import { pathToFileURL } from "node:url";
import { ConfigError, loadConfig } from "./config.js";
import { Handler } from "./handler.js";
import { sign, SIGNATURE_HEADER } from "./hmac.js";
import { KurierClient } from "./kurier.js";
import { log } from "./log.js";
import { Prover } from "./prover.js";
import { Store } from "./store.js";

const MAX_BODY_BYTES = 256 * 1024;

export function createServer(handler: Handler, agentPath: string, hmacKey: Buffer): http.Server {
  const send = (res: http.ServerResponse, status: number, body: string) => {
    // Sign the exact bytes we send.
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      [SIGNATURE_HEADER]: sign(body, hmacKey),
    });
    res.end(body);
  };

  const server = http.createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && url === "/healthz") return send(res, 200, JSON.stringify({ ok: true }));
    if (url !== agentPath) return send(res, 404, JSON.stringify({ error: "not found" }));
    if (req.method !== "POST") return send(res, 405, JSON.stringify({ error: "method not allowed" }));

    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES && !aborted) {
        aborted = true;
        send(res, 413, JSON.stringify({ error: "body too large" }));
        req.destroy();
      } else if (!aborted) chunks.push(c);
    });
    req.on("end", () => {
      if (aborted) return;
      handler
        .handle(Buffer.concat(chunks), req.headers[SIGNATURE_HEADER])
        .then((r) => send(res, r.status, r.body))
        .catch(() => send(res, 500, JSON.stringify({ error: "internal error" })));
    });
  });
  server.requestTimeout = 65_000;
  server.headersTimeout = 15_000;
  return server;
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      log("error", `config error: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }

  const prover = await Prover.load(config.wasmPath, config.zkeyPath);
  const store = new Store(config.dataDir);
  const kurier = config.kurier.apiKey ? new KurierClient(config.kurier.baseUrl, config.kurier.apiKey) : undefined;
  const handler = new Handler({ config, prover, store, kurier, log, now: Date.now });

  const server = createServer(handler, config.agentPath, config.hmacKey);
  server.listen(config.port, config.host, () => {
    log("info", "proof-gatekeeper agent listening", {
      host: config.host,
      port: config.port,
      path: config.agentPath,
      reasonCodes: config.reasonCodes,
      zkverify: config.kurier.mode === "off" ? "off" : `${config.kurier.mode}/${config.kurier.network}`,
    });
  });

  const shutdown = (sig: string) => {
    log("info", `received ${sig}, shutting down`);
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e: unknown) => {
    log("error", "fatal startup error", { error: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  });
}
