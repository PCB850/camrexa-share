# CAMREXA — Check My Condo

Static Vercel site (HTML/JS, no build step) plus a few Vercel serverless functions in `api/`.

## Gated building data (Supabase + Stripe)

Public visitors see only a teaser per building: name, city, county, year built, units, and risk band.
Everything else (dues and what they cover, pets, parking, rentals, SIRS and milestone status,
special assessments, loans, litigation, insurance, sales, documents, and a dated source for every fact)
lives in Supabase and is returned only to a signed-in buyer who holds an entitlement.
Postgres row-level security is the gate: `/api/building` reads the full row *as the buyer*, never with the service key.

| Piece | Path |
|---|---|
| Database schema, RLS, teaser view, private `building-docs` bucket | `supabase/migrations/0001_init.sql` |
| Profile loader (group-*.json -> Supabase) | `scripts/load_profiles.mjs` |
| Teaser / full profile API | `api/building.js` — `GET /api/building?slug=` |
| Stripe Checkout ($149, metadata `building_slug`) | `api/checkout.js` — `POST /api/checkout` |
| Stripe webhook (verifies signature, grants / revokes entitlement) | `api/stripe-webhook.js` — `POST /api/stripe-webhook` |
| Public Supabase URL + anon key for browser sign-in | `api/public-config.js` |
| Building page, `/b/<slug>` | `building.html`, `building-page.js`, `auth.js` |
| Public catalog (teaser fields only) | `buildings.js` |

Buying flow: `/b/<slug>` → "Unlock full report $149" → Stripe Checkout (sign-in optional) → webhook grants the
entitlement to the user id, or to the email paid with → buyer signs in by email magic link → full file renders.
A full refund in Stripe revokes the entitlement.

### Setup Chad must do (one time)

1. **Create the Supabase project** at supabase.com (region US East is closest to Florida). From
   *Project Settings → API* copy the **Project URL**, the **anon public** key, and the **service_role** key.
   The service_role key bypasses all security: it goes only into Vercel env vars and your local shell, never into the site or git.
2. **Run the migration.** In the Supabase dashboard open *SQL Editor*, paste all of
   `supabase/migrations/0001_init.sql`, and run it once. (Or with the Supabase CLI: `supabase link` then `supabase db push`.)
   It creates the tables, row-level security, the public `building_teasers` view, and the private `building-docs` storage bucket.
3. **Auth settings** (*Authentication → Providers / URL Configuration*):
   - Email provider ON, "Confirm email" ON (entitlements bought as a guest are claimed by verified email).
   - Site URL: your production URL (e.g. `https://camrexa.com`).
   - Redirect URLs: add `https://<your-domain>/b/**` and your Vercel preview domain `https://*.vercel.app/b/**`.
   - Optional: set up custom SMTP so sign-in emails come from your domain.
4. **Make yourself admin** (sees every building): sign in once on any `/b/<slug>` page, then in SQL Editor run
   `update public.profiles set role = 'admin' where email = '<the email you signed in with>';`
5. **Load the building profiles** from your machine (Node 20+):
   ```bash
   SUPABASE_URL=https://<project>.supabase.co \
   SUPABASE_SERVICE_ROLE_KEY=<service_role key> \
   node scripts/load_profiles.mjs /path/to/camrexa/profiles          # add --dry-run to preview without writing
   ```
   It reads every `group-*.json`, upserts geography/association/building/fees/rules, replaces that building's
   SIRS, milestone, assessment, loan, litigation, insurance and sales rows, and writes one `sources` row
   (url + as_of) per fact. Re-running is safe. Files that are not valid JSON yet are skipped.
   Risk band falls back to `buildings.js` when the profile says unknown.
   SIRS / budget PDFs: upload to the `building-docs` bucket as `<building-slug>/<file>.pdf` and add a row to `public.documents`.
6. **Stripe** (dashboard.stripe.com, test mode first):
   - Optional: create a product "CAMREXA Condo Intelligence Report" with a one-time $149 price and copy its `price_...` id
     (without it, checkout uses an inline $149 price).
   - *Developers → Webhooks → Add endpoint*: `https://<your-domain>/api/stripe-webhook`, events
     `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`. Copy the signing secret (`whsec_...`).
7. **Vercel env vars** (*Project → Settings → Environment Variables*, Production and Preview), then redeploy:

   | Name | Value |
   |---|---|
   | `SUPABASE_URL` | Supabase Project URL |
   | `SUPABASE_ANON_KEY` | Supabase anon public key |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role key (webhook writes) |
   | `STRIPE_SECRET_KEY` | `sk_test_...` then `sk_live_...` |
   | `STRIPE_WEBHOOK_SECRET` | `whsec_...` from step 6 |
   | `STRIPE_PRICE_ID` | optional, `price_...` for the $149 product |
   | `STRIPE_STATEWIDE_PRICE_ID` | optional, enables `POST /api/checkout {"plan":"statewide"}` |
   | `PUBLIC_SITE_URL` | optional, e.g. `https://camrexa.com` for Stripe return links |

8. **Test end to end** with Stripe test card `4242 4242 4242 4242` on a preview deploy: open `/b/pinnacle-port`,
   unlock, sign in with the email you paid with, and confirm the full file renders. In a private window,
   confirm `/b/pinnacle-port` shows only the teaser and that
   `https://<project>.supabase.co/rest/v1/buildings?select=*` with only the anon key returns nothing.

### Notes

- `.vercelignore` keeps `supabase/`, `scripts/` and this README off the public site.
- The loader treats the profile JSON as the source of truth for the per-building child tables; manual edits to those rows are overwritten on the next load.
- Statewide expansion: add profiles with their own `county` / `city`; counties and cities are created on load. A statewide or county pass is an entitlement with `scope = 'state'` or `'county'`.
