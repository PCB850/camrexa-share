// POST /api/checkout   body: {"slug": "<building-slug>"}  or  {"plan": "statewide"}
// Creates a Stripe Checkout session and returns { url }.
// Signing in first is optional: with a Supabase bearer token the purchase is tied
// to that user; without one, Stripe collects the email and the buyer unlocks by
// signing in with that same email.
// Env: STRIPE_SECRET_KEY, optional STRIPE_PRICE_ID (a $149 one-time price),
//      optional STRIPE_STATEWIDE_PRICE_ID, optional PUBLIC_SITE_URL.
import { rest, getUser, bearer, json, errorResponse, HttpError, SLUG_RE } from "./_lib/supabase.js";
import { stripePost } from "./_lib/stripe.js";

const REPORT_PRICE_CENTS = 14900;

function siteOrigin(request) {
  if (process.env.PUBLIC_SITE_URL) return process.env.PUBLIC_SITE_URL.replace(/\/$/, "");
  return new URL(request.url).origin;
}

export async function POST(request) {
  try {
    let body = {};
    try {
      body = await request.json();
    } catch {
      throw new HttpError(400, "Expected JSON body");
    }
    const plan = body.plan === "statewide" ? "statewide" : "building";
    const origin = siteOrigin(request);

    const token = bearer(request);
    const user = token ? await getUser(token) : null;

    let lineItem;
    let metadata;
    let successPath;
    let cancelPath;

    if (plan === "statewide") {
      const price = process.env.STRIPE_STATEWIDE_PRICE_ID;
      if (!price) throw new HttpError(400, "Statewide plan is not on sale yet");
      lineItem = { price, quantity: 1 };
      metadata = { plan: "statewide", state: "FL" };
      successPath = "/?paid={CHECKOUT_SESSION_ID}";
      cancelPath = "/";
    } else {
      const slug = String(body.slug || "");
      if (!SLUG_RE.test(slug)) throw new HttpError(400, "Bad slug");
      const rows = await rest(`building_teasers?slug=eq.${encodeURIComponent(slug)}&select=slug,name`);
      const b = rows && rows[0];
      if (!b) throw new HttpError(404, "Building not found");
      lineItem = process.env.STRIPE_PRICE_ID
        ? { price: process.env.STRIPE_PRICE_ID, quantity: 1 }
        : {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: REPORT_PRICE_CENTS,
              product_data: { name: `CAMREXA Condo Intelligence Report — ${b.name}` }
            }
          };
      metadata = { plan: "building", building_slug: b.slug };
      successPath = `/b/${b.slug}?paid={CHECKOUT_SESSION_ID}`;
      cancelPath = `/b/${b.slug}`;
    }

    if (user) metadata.user_id = user.id;

    const session = await stripePost("checkout/sessions", {
      mode: "payment",
      line_items: [lineItem],
      metadata,
      payment_intent_data: { metadata },
      client_reference_id: user ? user.id : undefined,
      customer_email: user && user.email ? user.email : undefined,
      customer_creation: "if_required",
      allow_promotion_codes: "true",
      success_url: origin + successPath,
      cancel_url: origin + cancelPath
    });

    return json(200, { url: session.url, id: session.id });
  } catch (err) {
    return errorResponse(err);
  }
}
