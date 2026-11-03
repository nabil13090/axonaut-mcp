// Test de fumée : faux serveur Axonaut + serveur MCP + client MCP officiel.
import http from "node:http";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MOCK_PORT = 4010;
const SECRET = "s".repeat(64);
const seen = [];

const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x");
    seen.push({ method: req.method, path: u.pathname, key: req.headers["userapikey"], page: req.headers["page"], q: u.search });
    const send = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.headers["userapikey"] !== "test-key") return send(401, { message: "Invalid API key" });
    if (u.pathname === "/me") return send(200, { user: { id: 1, name: "Nabil", user_api_key: "SECRET-LEAK" }, company: { name: "RESOLVO" } });
    if (u.pathname === "/invoices") {
      if (!req.headers["page"]) return send(403, { message: "Too many results. Use the page header (3 pages)" });
      return send(200, Array.from({ length: 30 }, (_, i) => ({
        id: i + 1, number: `F-${i + 1}`, company_name: "ACME", total_amount: 100 + i,
        invoice_lines: [{ title: "ligne" }], comments: "<p>Bonjour&nbsp;<b>monde</b></p>",
      })));
    }
    if (u.pathname === "/invoices/1") return send(200, { id: 1, invoice_lines: [{ title: "ligne" }] });
    if (u.pathname === "/companies/5/addresses") return send(200, [{ id: 9, city: "Marseille" }]);
    if (u.pathname === "/companies/search") {
      return u.searchParams.get("name") === "acme" ? send(200, [{ id: 5, name: "ACME SARL" }]) : send(404, { message: "nope" });
    }
    if (u.pathname === "/companies" && req.method === "POST") return send(201, { id: 77, echo: JSON.parse(body || "{}") });
    if (u.pathname === "/companies") return send(200, [{ id: 5, name: "ACME SARL" }, { id: 6, name: "Zeta" }]);
    return send(404, { message: "Not found" });
  });
});
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

async function startServer(port, readOnly) {
  const child = spawn("node", ["dist/index.js"], {
    env: {
      ...process.env, PORT: String(port), MCP_SECRET: SECRET, AXONAUT_API_KEY: "test-key",
      READ_ONLY: String(readOnly), AXONAUT_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`, RATE_LIMIT_PER_MIN: "40",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  for (let i = 0; i < 50 && !logs.includes("à l'écoute"); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(logs.includes("à l'écoute"), "le serveur ne démarre pas : " + logs);
  return { child, logs: () => logs };
}

const call = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { isError: !!r.isError, json, text };
};

async function connect(port) {
  const client = new Client({ name: "smoke", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${SECRET}`)));
  return client;
}

let ok = 0;
const pass = (m) => { ok++; console.log("  ✔", m); };

// ---------- READ_ONLY=true ----------
console.log("READ_ONLY=true");
const s1 = await startServer(3401, true);
const c1 = await connect(3401);

const tools = (await c1.listTools()).tools.map((t) => t.name).sort();
assert.deepEqual(tools, ["axonaut_api_doc", "axonaut_get", "axonaut_list", "axonaut_me", "axonaut_request", "axonaut_search_company"]);
pass("6 outils exposés : " + tools.join(", "));

let r = await call(c1, "axonaut_me");
assert.ok(!r.isError && r.json.company.name === "RESOLVO");
assert.ok(!r.text.includes("SECRET-LEAK") && !r.text.includes("user_api_key"));
pass("axonaut_me : OK, user_api_key supprimé");

r = await call(c1, "axonaut_list", { resource: "invoices" });
assert.ok(!r.isError);
assert.equal(r.json.renvoyes, 20); // limite par défaut
assert.equal(r.json.pages_totales, 3);
assert.ok(r.json.note.includes("page=1"));
assert.ok(!("invoice_lines" in r.json.donnees[0]));
assert.equal(r.json.donnees[0].comments, "Bonjour monde");
assert.equal(seen.filter((s) => s.path === "/invoices").length, 2);
assert.equal(seen.at(-1).page, "1");
pass("axonaut_list : 403 → relance page=1, 3 pages, limit=20, lignes retirées, HTML nettoyé");

r = await call(c1, "axonaut_list", { resource: "invoices", page: 2, limit: 3, fields: ["id", "number"], query: { date_after: "01/01/2026" } });
assert.deepEqual(r.json.donnees, [{ id: 1, number: "F-1" }, { id: 2, number: "F-2" }, { id: 3, number: "F-3" }]);
assert.ok(seen.at(-1).q.includes("date_after=01%2F01%2F2026") && seen.at(-1).page === "2");
pass("axonaut_list : fields, limit, page, query");

r = await call(c1, "axonaut_list", { resource: "addresses".replace("addresses", "invoices"), page: 1, fields: ["id", "invoice_lines"], limit: 1 });
assert.ok("invoice_lines" in r.json.donnees[0]);
pass("axonaut_list : champs lourds récupérables via fields");

r = await call(c1, "axonaut_get", { resource: "invoices", id: 1 });
assert.ok(r.json.invoice_lines);
r = await call(c1, "axonaut_get", { resource: "companies", id: 5, sub: "addresses" });
assert.equal(r.json[0].city, "Marseille");
pass("axonaut_get : objet et sous-ressource");

r = await call(c1, "axonaut_search_company", { name: "acme" });
assert.equal(r.json.donnees[0].id, 5);
r = await call(c1, "axonaut_search_company", { name: "zeta" });
assert.equal(r.json.donnees[0].id, 6);
assert.ok(r.json.note.includes("filtrage local"));
pass("axonaut_search_company : recherche native + repli local");

r = await call(c1, "axonaut_request", { method: "GET", path: "companies/5/addresses" });
assert.ok(!r.isError);
r = await call(c1, "axonaut_request", { method: "POST", path: "companies", body: { name: "X" } });
assert.ok(r.isError && r.json.code_http === 403);
assert.ok(!seen.some((s) => s.method === "POST"));
pass("axonaut_request : GET OK, POST refusé en lecture seule (aucun appel émis)");

r = await call(c1, "axonaut_request", { path: "https://evil.example/x" });
assert.ok(r.isError && r.json.code_http === 400);
r = await call(c1, "axonaut_get", { resource: "invoices", id: 99999 });
assert.ok(r.isError && r.json.code_http === 404);
pass("Erreurs : chemin absolu refusé (400), 404 Axonaut renvoyée proprement");

r = await call(c1, "axonaut_api_doc");
assert.ok(r.text.includes("userApiKey"));
pass("axonaut_api_doc");
await c1.close();

// Sécurité HTTP
const base = "http://127.0.0.1:3401";
assert.equal((await fetch(`${base}/mcp/mauvais`, { method: "POST" })).status, 404);
assert.equal((await fetch(`${base}/mcp`, { method: "POST" })).status, 404);
assert.equal((await fetch(`${base}/`)).status, 404);
assert.equal((await fetch(`${base}/mcp/${SECRET}`)).status, 405);
pass("Sécurité : mauvais secret / autres routes → 404, GET sur /mcp/<secret> → 405");

let got429 = false;
for (let i = 0; i < 60; i++) if ((await fetch(`${base}/x`)).status === 429) { got429 = true; break; }
assert.ok(got429);
pass("Rate limit : 429 après dépassement");

const logs = s1.logs();
assert.ok(!logs.includes(SECRET) && !logs.includes("test-key"));
pass("Logs : ni secret ni clé API");
s1.child.kill();

// ---------- READ_ONLY=false ----------
console.log("READ_ONLY=false");
const s2 = await startServer(3402, false);
const c2 = await connect(3402);
r = await call(c2, "axonaut_request", { method: "POST", path: "companies", body: { name: "X" } });
assert.ok(!r.isError && r.json.id === 77 && r.json.echo.name === "X");
pass("axonaut_request : POST autorisé quand READ_ONLY=false");
await c2.close();
s2.child.kill();

mock.close();
console.log(`\n${ok} groupes de vérifications OK`);
process.exit(0);
