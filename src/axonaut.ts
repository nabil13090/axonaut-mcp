const BASE = (process.env.AXONAUT_BASE_URL ?? "https://axonaut.com/api/v2").replace(/\/+$/, "");

export const READ_ONLY = (process.env.READ_ONLY ?? "true").toLowerCase() !== "false";

export class AxonautError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

export type QueryValue = string | number | boolean;

export interface AxRequestOptions {
  method?: string;
  path: string;
  query?: Record<string, QueryValue | QueryValue[] | null | undefined>;
  page?: number;
  body?: unknown;
}

const SECRET_KEYS = new Set(["user_api_key", "userapikey", "api_key", "apikey"]);

/** Supprime récursivement toute clé API d'une réponse. */
export function sanitize<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sanitize) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.has(k.toLowerCase())) continue;
      out[k] = sanitize(v);
    }
    return out as T;
  }
  return value;
}

function extractMessage(body: unknown, fallback: string): string {
  if (typeof body === "string" && body.trim()) return body.slice(0, 500);
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    for (const k of ["message", "error", "detail", "errors"]) {
      if (o[k] != null) return typeof o[k] === "string" ? (o[k] as string) : JSON.stringify(o[k]).slice(0, 500);
    }
    return JSON.stringify(body).slice(0, 500);
  }
  return fallback;
}

export async function axRequest(opts: AxRequestOptions): Promise<unknown> {
  const method = (opts.method ?? "GET").toUpperCase();
  if (READ_ONLY && method !== "GET") {
    throw new AxonautError(403, "Mode lecture seule activé (READ_ONLY=true) : seules les requêtes GET sont autorisées.");
  }
  if (!process.env.AXONAUT_API_KEY) {
    throw new AxonautError(500, "AXONAUT_API_KEY n'est pas configurée sur le serveur.");
  }
  const rel = opts.path.replace(/^\/+/, "");
  if (/^[a-z]+:\/\//i.test(rel) || rel.includes("..")) {
    throw new AxonautError(400, "Chemin invalide : un chemin relatif à /api/v2 est attendu (ex. 'invoices/12').");
  }
  const url = new URL(`${BASE}/${rel}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
    else url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = {
    userApiKey: process.env.AXONAUT_API_KEY ?? "",
    Accept: "application/json",
  };
  if (opts.page != null) headers["page"] = String(opts.page);
  let body: string | undefined;
  if (opts.body !== undefined && method !== "GET") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new AxonautError(502, `Impossible de joindre Axonaut : ${(e as Error).message}`);
  }
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* garde le texte brut */
  }
  if (!res.ok) {
    throw new AxonautError(res.status, extractMessage(data, res.statusText), typeof data === "string" ? undefined : data);
  }
  return sanitize(data);
}

export interface ListResult {
  data: unknown;
  note?: string;
  totalPages?: number | null;
}

/** GET de liste avec gestion du 403 « Too many results » (relance en page 1). */
export async function axList(
  path: string,
  query: Record<string, QueryValue | QueryValue[]> | undefined,
  page: number | undefined,
): Promise<ListResult> {
  try {
    return { data: await axRequest({ path, query, page }) };
  } catch (e) {
    if (e instanceof AxonautError && e.status === 403 && page == null && /too many/i.test(e.message)) {
      const m = e.message.match(/(\d+)\s*pages?/i);
      const totalPages = m ? Number(m[1]) : null;
      const data = await axRequest({ path, query, page: 1 });
      return {
        data,
        totalPages,
        note:
          "Trop de résultats sans pagination : relance automatique avec page=1 (les plus récents d'abord)." +
          (totalPages ? ` Nombre total de pages : ${totalPages} (500 résultats/page).` : " Nombre total de pages non communiqué par l'API : incrémentez 'page' jusqu'à obtenir une liste vide."),
      };
    }
    throw e;
  }
}
