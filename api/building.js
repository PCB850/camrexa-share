// GET /api/building?slug=<slug>
//   Anyone:                     { teaser, entitled: false }
//   Authorization: Bearer <Supabase user access token> with an entitlement:
//                               { teaser, entitled: true, profile: {...} }
// The full read is made AS THE USER, so Postgres row-level security is the
// gate; this function never uses the service role for reads.
import { rest, getUser, signedUrl, bearer, json, errorResponse, HttpError, SLUG_RE } from "./_lib/supabase.js";

const FULL_SELECT = [
  "*",
  "association:associations!buildings_association_id_fkey(*)",
  "county:counties!buildings_county_id_fkey(name,state)",
  "city:cities!buildings_city_id_fkey(name)",
  "fees(*)",
  "rules(*)",
  "sirs_filings(*)",
  "milestone_inspections(*)",
  "special_assessments(*)",
  "loans(*)",
  "litigation(*)",
  "insurance(*)",
  "sales_stats(*)",
  "documents(*)",
  "sources(field_path,url,as_of,as_of_text,record_table)"
].join(",");

const one = (x) => (Array.isArray(x) ? x[0] || null : x || null);
const many = (x) => (Array.isArray(x) ? x : x ? [x] : []);

export async function GET(request) {
  try {
    const slug = new URL(request.url).searchParams.get("slug") || "";
    if (!SLUG_RE.test(slug)) throw new HttpError(400, "Bad slug");

    const teasers = await rest(`building_teasers?slug=eq.${encodeURIComponent(slug)}&select=*`);
    const teaser = teasers && teasers[0];
    if (!teaser) throw new HttpError(404, "Building not found");

    const token = bearer(request);
    const user = token ? await getUser(token) : null;
    if (!user) return json(200, { teaser, signed_in: false, entitled: false });

    const rows = await rest(`buildings?slug=eq.${encodeURIComponent(slug)}&select=${FULL_SELECT}`, { as: token });
    const b = rows && rows[0];
    if (!b) return json(200, { teaser, signed_in: true, email: user.email, entitled: false });

    const documents = [];
    for (const d of many(b.documents).slice(0, 25)) {
      documents.push({
        doc_type: d.doc_type,
        title: d.title,
        as_of: d.as_of,
        source_url: d.source_url,
        download_url: await signedUrl(token, d.storage_bucket, d.storage_path)
      });
    }

    const profile = {
      slug: b.slug,
      name: b.name,
      state: b.state,
      county: b.county && b.county.name,
      city: b.city && b.city.name,
      address: b.address,
      lat: b.lat,
      lng: b.lng,
      risk_band: b.risk_band,
      health_summary: b.health_summary,
      conflicts: b.conflicts || [],
      association: one(b.association),
      building: {
        year_built: b.year_built,
        units: b.units,
        floors: b.floors,
        buildings_count: b.buildings_count,
        unit_mix: b.unit_mix,
        elevators: b.elevators,
        construction_notes: b.construction_notes,
        flood_zone: b.flood_zone
      },
      amenities: b.amenities,
      fees: one(b.fees),
      rules: one(b.rules),
      sirs_filings: many(b.sirs_filings),
      milestone_inspections: many(b.milestone_inspections),
      special_assessments: many(b.special_assessments),
      loans: many(b.loans),
      litigation: many(b.litigation),
      insurance: many(b.insurance),
      sales_stats: many(b.sales_stats).sort((x, y) => String(y.period_end || "").localeCompare(String(x.period_end || ""))),
      documents,
      sources: many(b.sources)
    };

    return json(200, { teaser, signed_in: true, email: user.email, entitled: true, profile });
  } catch (err) {
    return errorResponse(err);
  }
}
