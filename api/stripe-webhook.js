// POST /api/stripe-webhook   (Stripe -> CAMREXA)
// Verifies the Stripe-Signature header, then:
//   checkout.session.completed / checkout.session.async_payment_succeeded (paid)
//       -> records the purchase and grants the entitlement (idempotent on session id)
//   charge.refunded (fully refunded)
//       -> marks the purchase refunded and revokes its entitlement
// Env: STRIPE_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
import { rest, json, errorResponse, HttpError } from "./_lib/supabase.js";
import { verifyStripeSignature } from "./_lib/stripe.js";

async function grantFromSession(s) {
  if (s.payment_status !== "paid") return "not paid yet";
  const meta = s.metadata || {};
  const plan = meta.plan === "statewide" ? "statewide" : "building";
  const email = (s.customer_details && s.customer_details.email) || s.customer_email || null;
  const userId = meta.user_id || s.client_reference_id || null;

  let buildingId = null;
  if (plan === "building") {
    const rows = await rest(`buildings?slug=eq.${encodeURIComponent(meta.building_slug || "")}&select=id`, { as: "service" });
    if (!rows || !rows[0]) throw new HttpError(500, `Unknown building slug ${meta.building_slug}`);
    buildingId = rows[0].id;
  }

  // Idempotent: the unique stripe_session_id makes a retried event a no-op.
  const purchases = await rest("purchases?on_conflict=stripe_session_id", {
    as: "service",
    method: "POST",
    prefer: "resolution=merge-duplicates,return=representation",
    body: {
      user_id: userId,
      email,
      plan,
      building_id: buildingId,
      state: plan === "statewide" ? meta.state || "FL" : null,
      stripe_session_id: s.id,
      stripe_payment_intent: typeof s.payment_intent === "string" ? s.payment_intent : null,
      stripe_customer_id: typeof s.customer === "string" ? s.customer : null,
      amount_cents: s.amount_total,
      currency: s.currency,
      status: "paid"
    }
  });
  const purchase = purchases[0];

  await rest("entitlements?on_conflict=purchase_id", {
    as: "service",
    method: "POST",
    prefer: "resolution=ignore-duplicates,return=minimal",
    body: {
      purchase_id: purchase.id,
      user_id: userId,
      email,
      scope: plan === "statewide" ? "state" : "building",
      building_id: buildingId,
      state: plan === "statewide" ? meta.state || "FL" : null
    }
  });
  return "granted";
}

async function revokeFromCharge(charge) {
  if (!charge.refunded || !charge.payment_intent) return "partial refund ignored";
  const pi = encodeURIComponent(charge.payment_intent);
  const purchases = await rest(`purchases?stripe_payment_intent=eq.${pi}`, {
    as: "service",
    method: "PATCH",
    prefer: "return=representation",
    body: { status: "refunded" }
  });
  for (const p of purchases || []) {
    await rest(`entitlements?purchase_id=eq.${p.id}&revoked_at=is.null`, {
      as: "service",
      method: "PATCH",
      prefer: "return=minimal",
      body: { revoked_at: new Date().toISOString() }
    });
  }
  return "revoked";
}

export async function POST(request) {
  try {
    const raw = await request.text();
    if (!verifyStripeSignature(raw, request.headers.get("stripe-signature"))) {
      return json(400, { error: "Bad signature" });
    }
    const event = JSON.parse(raw);
    let result = "ignored";
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      result = await grantFromSession(event.data.object);
    } else if (event.type === "charge.refunded") {
      result = await revokeFromCharge(event.data.object);
    }
    return json(200, { received: true, result });
  } catch (err) {
    // Non-2xx makes Stripe retry, which is what we want for transient DB errors.
    return errorResponse(err);
  }
}
