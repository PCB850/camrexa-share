// Minimal Stripe REST helpers (no SDK). Env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
import { createHmac, timingSafeEqual } from "node:crypto";
import { env, HttpError } from "./supabase.js";

/** Flattens {a:{b:1}, c:[{d:2}]} into Stripe form fields a[b]=1&c[0][d]=2 */
function form(obj, prefix, out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export async function stripePost(path, params) {
  const res = await fetch("https://api.stripe.com/v1/" + path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env("STRIPE_SECRET_KEY")}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: form(params)
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("Stripe error", data && data.error);
    throw new HttpError(502, "Payment provider error");
  }
  return data;
}

/**
 * Verifies a Stripe-Signature header against the raw body.
 * https://docs.stripe.com/webhooks#verify-manually
 */
export function verifyStripeSignature(rawBody, header, secret = env("STRIPE_WEBHOOK_SECRET"), toleranceSec = 300) {
  if (!header) return false;
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = (parts.find(([k]) => k === "t") || [])[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || sigs.length === 0) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest("hex");
  const exp = Buffer.from(expected, "hex");
  return sigs.some((s) => {
    const got = Buffer.from(s, "hex");
    return got.length === exp.length && timingSafeEqual(got, exp);
  });
}
