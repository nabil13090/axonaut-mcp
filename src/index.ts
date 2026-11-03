import "dotenv/config";
import { createHash, timingSafeEqual } from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.js";
import { READ_ONLY } from "./axonaut.js";

const PORT = Number(process.env.PORT ?? 3333);
const SECRET = process.env.MCP_SECRET ?? "";
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MIN ?? 60);

if (SECRET.length < 32) {
  console.error("MCP_SECRET manquant ou trop court (48+ caractères recommandés). Arrêt.");
  process.exit(1);
}
if (!process.env.AXONAUT_API_KEY) {
  console.warn("AXONAUT_API_KEY manquant : les outils renverront une erreur tant qu'elle n'est pas définie.");
}
const HOST = process.env.HOST ?? "127.0.0.1";
const TRUST_PROXY = process.env.TRUST_PROXY ?? "loopback";

const secretHash = createHash("sha256").update(SECRET).digest();
function secretMatches(candidate: string): boolean {
  const h = createHash("sha256").update(candidate).digest();
  return timingSafeEqual(h, secretHash);
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "axonaut-mcp", version: "1.0.0" });
  registerTools(server);
  return server;
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", TRUST_PROXY === "true" ? true : TRUST_PROXY);

// Rate limit simple en mémoire : RATE_LIMIT requêtes / minute / IP
const hits = new Map<string, { count: number; reset: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [ip, h] of hits) if (h.reset < now) hits.delete(ip);
}, 60_000).unref();
app.use((req: Request, res: Response, next: NextFunction) => {
  const ip = req.ip ?? "unknown";
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || h.reset < now) {
    h = { count: 0, reset: now + 60_000 };
    hits.set(ip, h);
  }
  h.count++;
  if (h.count > RATE_LIMIT) {
    res.setHeader("Retry-After", Math.ceil((h.reset - now) / 1000));
    res.status(429).json({ error: "Trop de requêtes" });
    return;
  }
  next();
});

// Logs sans secret ni clé API (le chemin n'est jamais journalisé)
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on("finish", () => {
    console.log(`${new Date().toISOString()} ip=${req.ip} ${req.method} status=${res.statusCode} ${Date.now() - t0}ms`);
  });
  next();
});

app.use(express.json({ limit: "1mb" }));

app.all("/mcp/:secret", async (req: Request, res: Response) => {
  if (!secretMatches(req.params.secret)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (req.method !== "POST") {
    res
      .status(405)
      .set("Allow", "POST")
      .json({ jsonrpc: "2.0", error: { code: -32000, message: "Méthode non autorisée (mode sans session : POST uniquement)." }, id: null });
    return;
  }
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("Erreur MCP :", (e as Error).message);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Erreur interne" }, id: null });
    }
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Erreurs (JSON invalide, etc.) sans fuite d'information
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  res.status(400).json({ error: "Requête invalide" });
});

app.listen(PORT, HOST, () => {
  console.log(`axonaut-mcp à l'écoute sur ${HOST}:${PORT} (READ_ONLY=${READ_ONLY})`);
});
