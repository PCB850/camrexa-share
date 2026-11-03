// Minimal Supabase REST helpers (no SDK, no build step).
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

export function env(name) {
  const v = process.env[name];
  if (!v) throw new HttpError(500, `Server is missing ${name}`);
  return v;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}

export function errorResponse(err) {
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) console.error(err);
  return json(status, { error: status >= 500 && !(err instanceof HttpError) ? "Server error" : err.message });
}

export function bearer(request) {
  const h = request.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/**
 * PostgREST call.
 *  as: "anon" | "service" | <user JWT string>
 */
export async function rest(path, { as = "anon", method = "GET", body, prefer } = {}) {
  const url = env("SUPABASE_URL").replace(/\/$/, "") + "/rest/v1/" + path;
  const anon = env("SUPABASE_ANON_KEY");
  let apikey = anon;
  let auth = anon;
  if (as === "service") {
    apikey = auth = env("SUPABASE_SERVICE_ROLE_KEY");
  } else if (as !== "anon") {
    auth = as; // user JWT: RLS evaluates as that user
  }
  const headers = { apikey, authorization: `Bearer ${auth}`, accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (prefer) headers.prefer = prefer;
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || res.statusText;
    throw new HttpError(res.status === 401 ? 401 : 502, `Database: ${msg}`);
  }
  return data;
}

/** Validates a Supabase access token with Supabase Auth. Returns the user or null. */
export async function getUser(token) {
  if (!token) return null;
  const res = await fetch(env("SUPABASE_URL").replace(/\/$/, "") + "/auth/v1/user", {
    headers: { apikey: env("SUPABASE_ANON_KEY"), authorization: `Bearer ${token}` }
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user && user.id ? user : null;
}

/** Signed download URL for a private Storage object, minted as the user so storage RLS applies. */
export async function signedUrl(token, bucket, path, expiresIn = 600) {
  const base = env("SUPABASE_URL").replace(/\/$/, "");
  const res = await fetch(`${base}/storage/v1/object/sign/${bucket}/${path.split("/").map(encodeURIComponent).join("/")}`, {
    method: "POST",
    headers: {
      apikey: env("SUPABASE_ANON_KEY"),
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ expiresIn })
  });
  if (!res.ok) return null;
  const data = await res.json();
  const signed = data.signedURL || data.signedUrl;
  return signed ? `${base}/storage/v1${signed}` : null;
}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
