import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { axRequest, axList, AxonautError, READ_ONLY, sanitize } from "./axonaut.js";
import { API_DOC } from "./doc.js";

export const RESOURCES = [
  "companies", "invoices", "quotations", "payments", "expenses", "expense-payments",
  "suppliers", "supplier-contracts", "supplier-deliveries", "contracts", "products",
  "employees", "opportunities", "tasks", "projects", "tickets", "events",
  "bank-transactions", "bank-accounts", "delivery-forms", "diverse-operations",
  "tax-rates", "accounting-codes", "users", "themes", "pipes", "payslips",
  "company-categories", "customfields", "timetrackings", "workforces", "languages",
] as const;

const HEAVY_KEYS = new Set([
  "quotation_lines", "invoice_lines", "lines", "details", "contract_lines",
  "expense_lines", "products_lines", "delivery_form_lines",
]);

function stripHtml(s: string): string {
  if (!/<[a-z!/][^>]*>/i.test(s)) return s;
  return s
    .replace(/<(br|\/p|\/div|\/li)\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanValue(v: unknown): unknown {
  if (typeof v === "string") return stripHtml(v);
  if (Array.isArray(v)) return v.map(cleanValue);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = cleanValue(x);
    return out;
  }
  return v;
}

function slimItem(item: unknown, fields?: string[]): unknown {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  const o = item as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (fields && fields.length) {
    for (const f of fields) if (f in o) out[f] = o[f];
    return cleanValue(out);
  }
  for (const [k, v] of Object.entries(o)) {
    if (HEAVY_KEYS.has(k)) continue;
    out[k] = v;
  }
  return cleanValue(out);
}

const ok = (payload: unknown) => ({
  content: [{ type: "text" as const, text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }],
});

const fail = (e: unknown) => {
  const err =
    e instanceof AxonautError
      ? { erreur: true, code_http: e.status, message: e.message, ...(e.body ? { details: sanitize(e.body) } : {}) }
      : { erreur: true, code_http: 500, message: (e as Error).message ?? String(e) };
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(err, null, 2) }] };
};

const queryShape = z
  .record(z.union([z.string(), z.number(), z.boolean()]))
  .optional();

export function registerTools(server: McpServer): void {
  server.registerTool(
    "axonaut_me",
    {
      description:
        "Vérifie la connexion à Axonaut (GET /me) et renvoie la société et l'utilisateur associés à la clé API. La clé API n'est jamais renvoyée.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await axRequest({ path: "me" }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "axonaut_list",
    {
      description:
        "Liste une ressource Axonaut (factures, devis, sociétés, produits, etc.), du plus récent au plus ancien. " +
        "Supporte la pagination (page, 500 résultats/page côté API), des filtres en query string (ex. {\"date_after\":\"01/01/2026\"}), " +
        "company_id pour limiter à une société, limit (défaut 20, max 100) et fields pour ne garder que certains champs. " +
        "Les champs lourds (lignes de devis/factures, détails HTML) sont retirés par défaut ; demandez-les via 'fields'.",
      inputSchema: {
        resource: z.enum(RESOURCES).describe("Ressource à lister"),
        page: z.number().int().min(1).optional().describe("Numéro de page (1 = les plus récents)"),
        query: queryShape.describe("Filtres en query string"),
        company_id: z.number().int().optional().describe("Si fourni : /companies/{id}/<resource>"),
        limit: z.number().int().min(1).max(100).default(20).describe("Nombre max d'éléments renvoyés (défaut 20, max 100)"),
        fields: z.array(z.string()).optional().describe("Champs à conserver, ex. [\"id\",\"number\",\"date\"]"),
      },
    },
    async ({ resource, page, query, company_id, limit, fields }) => {
      try {
        const path = company_id != null ? `companies/${company_id}/${resource}` : resource;
        const r = await axList(path, query, page);
        const raw = r.data;
        if (Array.isArray(raw)) {
          const items = raw.slice(0, limit).map((i) => slimItem(i, fields));
          return ok({
            total_page_courante: raw.length,
            renvoyes: items.length,
            page: page ?? (r.note ? 1 : null),
            ...(r.totalPages ? { pages_totales: r.totalPages } : {}),
            ...(r.note ? { note: r.note } : {}),
            donnees: items,
          });
        }
        return ok({ ...(r.note ? { note: r.note } : {}), donnees: slimItem(raw, fields) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "axonaut_get",
    {
      description:
        "Récupère un objet Axonaut par identifiant (GET /<resource>/<id>). 'sub' permet d'atteindre une sous-ressource (ex. \"stock\", \"addresses\" → /<resource>/<id>/<sub>).",
      inputSchema: {
        resource: z.enum(RESOURCES).describe("Ressource"),
        id: z.union([z.number().int(), z.string().regex(/^[\w-]+$/)]).describe("Identifiant"),
        sub: z.string().regex(/^[\w/-]+$/).optional().describe("Sous-ressource optionnelle"),
      },
    },
    async ({ resource, id, sub }) => {
      try {
        const path = `${resource}/${id}${sub ? `/${sub}` : ""}`;
        return ok(await axRequest({ path }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "axonaut_search_company",
    {
      description:
        "Recherche une société (client, prospect ou fournisseur) par nom dans Axonaut. Renvoie les sociétés correspondantes (id, nom, etc.).",
      inputSchema: {
        name: z.string().min(1).describe("Nom (ou partie du nom) de la société"),
        limit: z.number().int().min(1).max(100).default(20).describe("Nombre max de résultats"),
      },
    },
    async ({ name, limit }) => {
      try {
        let found: unknown[] | null = null;
        try {
          const r = await axRequest({ path: "companies/search", query: { name } });
          if (Array.isArray(r)) found = r;
        } catch (e) {
          if (!(e instanceof AxonautError) || ![400, 404, 405].includes(e.status)) throw e;
        }
        let note: string | undefined;
        if (found == null) {
          // Repli : filtrage local sur la page 1 (les 500 plus récentes)
          const r = await axList("companies", undefined, undefined);
          const all = Array.isArray(r.data) ? r.data : [];
          const needle = name.toLowerCase();
          found = all.filter((c) => String((c as Record<string, unknown>)?.name ?? "").toLowerCase().includes(needle));
          note = "Recherche native indisponible : filtrage local sur les 500 sociétés les plus récentes uniquement.";
        }
        const items = found.slice(0, limit).map((c) => slimItem(c));
        return ok({ trouves: found.length, renvoyes: items.length, ...(note ? { note } : {}), donnees: items });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "axonaut_request",
    {
      description:
        "Requête libre vers l'API Axonaut v2 (method, path relatif à /api/v2, query, body). " +
        (READ_ONLY
          ? "ATTENTION : le serveur est en lecture seule (READ_ONLY=true), seules les requêtes GET sont acceptées."
          : "Les écritures (POST/PUT/PATCH/DELETE) sont autorisées : à utiliser avec précaution."),
      inputSchema: {
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
        path: z.string().min(1).describe("Chemin relatif, ex. 'invoices/123' ou 'companies/5/addresses'"),
        query: queryShape.describe("Paramètres de query string"),
        body: z.any().optional().describe("Corps JSON (écritures)"),
        page: z.number().int().min(1).optional().describe("Numéro de page (en-tête 'page')"),
      },
    },
    async ({ method, path, query, body, page }) => {
      try {
        if (READ_ONLY && method !== "GET") {
          throw new AxonautError(403, "Mode lecture seule activé (READ_ONLY=true) : seules les requêtes GET sont autorisées.");
        }
        return ok(await axRequest({ method, path, query, body, page }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "axonaut_api_doc",
    {
      description: "Renvoie un résumé des ressources et filtres connus de l'API Axonaut v2 (pagination, authentification, filtres courants).",
      inputSchema: {},
    },
    async () => ok(API_DOC),
  );
}
