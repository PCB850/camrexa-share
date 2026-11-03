#!/usr/bin/env node
// Load CAMREXA building profiles (group-*.json) into Supabase.
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/load_profiles.mjs [profilesDir] [--dry-run]
//
// profilesDir defaults to $PROFILES_DIR, else ../camrexa/profiles next to this repo.
// Profile format: camrexa/profiles/SCHEMA.md. Every leaf is
//   {"value": ..., "source_url": "...", "as_of": "YYYY-MM-DD"}   (value "unknown" when not found)
// Each file may hold one profile object, an array of them, or {"profiles": [...]}.
//
// What it writes (service role, bypasses RLS):
//   counties, cities, associations, buildings, fees, rules  -> upserted
//   sirs_filings, milestone_inspections, special_assessments, loans,
//   litigation, insurance, sales_stats                       -> replaced per building
//   sources (origin = 'profile_loader')                      -> replaced per building, one row per fact
// Files that fail to parse (still being written) are skipped with a warning.
// Keys come from the environment only. Never commit them.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const dir = resolve(args.find((a) => !a.startsWith("--")) || process.env.PROFILES_DIR || join(here, "..", "..", "camrexa", "profiles"));

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
if (!DRY && (!SUPABASE_URL || !KEY)) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or use --dry-run).");
  process.exit(1);
}

// ---------------------------------------------------------------- value helpers
const isLeaf = (f) => f && typeof f === "object" && !Array.isArray(f) && "value" in f;
const UNKNOWN = new Set(["unknown", "n/a", "na", "", "not found", "none found"]);

function val(f) {
  const v = isLeaf(f) ? f.value : f;
  if (v === undefined || v === null) return null;
  if (typeof v === "string" && UNKNOWN.has(v.trim().toLowerCase())) return null;
  return v;
}
function text(f) {
  const v = val(f);
  if (v === null) return null;
  if (Array.isArray(v)) return v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join("; ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
function textArray(f) {
  const v = val(f);
  if (v === null) return [];
  if (Array.isArray(v)) return v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x)).trim()).filter(Boolean);
  if (typeof v === "string") return v.split(/\s*;\s*/).map((s) => s.trim()).filter(Boolean);
  return [JSON.stringify(v)];
}
function jsonb(f) {
  return val(f);
}
// Only clean numbers ("$1,234", "22.2%", 245). Prose like "$2,529/qtr" stays text.
function num(f) {
  const v = val(f);
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^\$?\s*(-?[\d,]+(?:\.\d+)?)\s*%?$/);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}
function int(f) {
  const n = num(f);
  return n === null ? null : Math.round(n);
}
function date(f) {
  const v = val(f);
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  m = s.match(/^(\d{4})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-01`;
  return null;
}
function latLng(f) {
  const v = val(f);
  if (v === null) return [null, null];
  if (Array.isArray(v) && v.length >= 2) return [Number(v[0]), Number(v[1])];
  if (typeof v === "object") return [Number(v.lat ?? v.latitude), Number(v.lng ?? v.lon ?? v.longitude)];
  const m = String(v).match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/);
  return m ? [Number(m[1]), Number(m[2])] : [null, null];
}
const slugify = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
function band(f, fallback) {
  const v = (text(f) || fallback || "").toUpperCase().trim();
  if (v.startsWith("HIGH")) return "HIGH RISK";
  if (v.startsWith("WATCH")) return "WATCH";
  if (v.startsWith("STRONG")) return "STRONG";
  return "UNKNOWN";
}
const anyKnown = (...fs) => fs.some((f) => val(f) !== null);

// Public catalog (buildings.js) as fallback for name and band.
function loadPublicCatalog() {
  const p = join(here, "..", "buildings.js");
  if (!existsSync(p)) return new Map();
  const ctx = { window: {} };
  vm.runInNewContext(readFileSync(p, "utf8"), ctx);
  return new Map((ctx.window.CAMREXA_BUILDINGS || []).map((b) => [b.id, b]));
}

// ---------------------------------------------------------------- REST
async function db(path, { method = "GET", body, prefer } = {}) {
  if (DRY) {
    if (method !== "GET") console.log(`[dry-run] ${method} ${path}`, body === undefined ? "" : JSON.stringify(body).slice(0, 300));
    const rows = Array.isArray(body) ? body : body ? [body] : [];
    return rows.map((r, i) => ({ id: r.id || `dry-${path.split("?")[0]}-${i}`, ...r }));
  }
  const headers = { apikey: KEY, authorization: `Bearer ${KEY}`, accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (prefer) headers.prefer = prefer;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${t}`);
  return t ? JSON.parse(t) : null;
}
const upsert = (table, conflict, body) =>
  db(`${table}?on_conflict=${conflict}`, { method: "POST", body, prefer: "resolution=merge-duplicates,return=representation" });
const insert = (table, rows) =>
  rows.length ? db(table, { method: "POST", body: rows, prefer: "return=representation" }) : Promise.resolve([]);
const del = (table, filter) => db(`${table}?${filter}`, { method: "DELETE", prefer: "return=minimal" });

// ---------------------------------------------------------------- sources
function collectLeaves(node, path = "", out = []) {
  if (isLeaf(node)) {
    out.push({ path, leaf: node });
    return out;
  }
  if (Array.isArray(node)) node.forEach((x, i) => collectLeaves(x, `${path}[${i}]`, out));
  else if (node && typeof node === "object")
    for (const [k, v] of Object.entries(node)) collectLeaves(v, path ? `${path}.${k}` : k, out);
  return out;
}

// ---------------------------------------------------------------- per profile
async function loadProfile(p, catalog) {
  if (!p || !p.slug) throw new Error("profile without slug");
  const slug = slugify(p.slug);
  const pub = catalog.get(slug) || {};
  const a = p.association || {};
  const bl = p.building || {};
  const fees = p.fees || {};
  const rules = p.rules || {};
  const h = p.health || {};
  const mk = p.market || {};
  const state = (val(p.state) || "FL").toString().toUpperCase().slice(0, 2);

  const countyName = text(p.county);
  const cityName = text(p.city);
  let county = null;
  let city = null;
  if (countyName) {
    [county] = await upsert("counties", "state,name", { state, name: countyName, slug: slugify(countyName) });
    if (cityName) [city] = await upsert("cities", "county_id,name", { county_id: county.id, state, name: cityName, slug: slugify(cityName) });
  }

  const dbpr = val(a.dbpr_project_numbers);
  const [assoc] = await upsert("associations", "slug", {
    slug,
    state,
    legal_name: text(a.legal_name),
    dbpr_project_numbers: Array.isArray(dbpr) ? dbpr.map(String) : dbpr ? String(dbpr).split(/\s*[,;]\s*/).filter(Boolean) : [],
    sunbiz_id: text(a.sunbiz_id),
    management_company: text(a.management_company),
    management_contact: text(a.management_contact),
    website: text(a.website)
  });

  const [lat, lng] = latLng(p.lat_lng);
  const [b] = await upsert("buildings", "slug", {
    slug,
    name: text(p.name) || pub.name || slug,
    association_id: assoc.id,
    state,
    county_id: county && county.id,
    city_id: city && city.id,
    address: text(p.address),
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    year_built: int(bl.year_built),
    units: int(bl.units),
    floors: int(bl.floors),
    buildings_count: int(bl.buildings_count),
    unit_mix: jsonb(bl.unit_mix),
    elevators: text(bl.elevators),
    construction_notes: text(bl.construction_notes),
    flood_zone: text(bl.flood_zone),
    amenities: jsonb(p.amenities),
    risk_band: band(h.risk_band, pub.band),
    health_summary: text(h.health_summary),
    conflicts: Array.isArray(p.conflicts) ? p.conflicts.map(String) : [],
    raw_profile: p
  });
  const bid = b.id;

  await upsert("fees", "building_id", {
    building_id: bid,
    dues_by_unit_type: jsonb(fees.dues_by_unit_type),
    dues_frequency: text(fees.dues_frequency),
    dues_cover: textArray(fees.dues_cover),
    dues_exclude: textArray(fees.dues_exclude),
    insurance_assessment: text(fees.insurance_assessment),
    cdd_fee: text(fees.cdd_fee),
    reserves_pct_of_budget: num(fees.reserves_pct_of_budget),
    reserves_note: num(fees.reserves_pct_of_budget) === null ? text(fees.reserves_pct_of_budget) : null,
    recent_dues_change: text(fees.recent_dues_change)
  });

  await upsert("rules", "building_id", {
    building_id: bid,
    pets_owners: text(rules.pets_owners),
    pets_renters: text(rules.pets_renters),
    parking: text(rules.parking),
    parking_fees: text(rules.parking_fees),
    golf_carts_trailers: text(rules.golf_carts_trailers),
    short_term_rentals: text(rules.short_term_rentals),
    rental_minimum_stay: text(rules.rental_minimum_stay),
    renter_min_age: text(rules.renter_min_age),
    rental_program: text(rules.rental_program),
    registration_fees: text(rules.registration_fees)
  });

  // Child tables: replace this building's rows with what the profile says.
  const children = ["sirs_filings", "milestone_inspections", "special_assessments", "loans", "litigation", "insurance", "sales_stats"];
  for (const t of children) await del(t, `building_id=eq.${bid}`);

  const ids = {}; // record ids for sources
  if (anyKnown(h.sirs_status, h.sirs_date)) {
    const [r] = await insert("sirs_filings", [{ building_id: bid, status: text(h.sirs_status), completed_on: date(h.sirs_date), completed_text: text(h.sirs_date) }]);
    ids.sirs = r.id;
  }
  if (anyKnown(h.milestone_status, h.milestone_due)) {
    const [r] = await insert("milestone_inspections", [{ building_id: bid, status: text(h.milestone_status), due_on: date(h.milestone_due), due_text: text(h.milestone_due) }]);
    ids.milestone = r.id;
  }
  const sa = Array.isArray(h.special_assessments) ? h.special_assessments : [];
  ids.sa = [];
  for (const s of sa) {
    if (!s || !anyKnown(s.amount, s.per_unit, s.approved, s.purpose, s.schedule)) {
      ids.sa.push(null);
      continue;
    }
    const [r] = await insert("special_assessments", [{
      building_id: bid,
      amount: num(s.amount),
      amount_text: text(s.amount),
      per_unit: text(s.per_unit),
      approved_on: date(s.approved),
      approved_text: text(s.approved),
      purpose: text(s.purpose),
      schedule: text(s.schedule)
    }]);
    ids.sa.push(r.id);
  }
  if (anyKnown(h.loans)) [{ id: ids.loans }] = await insert("loans", [{ building_id: bid, description: text(h.loans) }]);
  if (anyKnown(h.litigation)) [{ id: ids.litigation }] = await insert("litigation", [{ building_id: bid, description: text(h.litigation) }]);
  if (anyKnown(h.insurance_carrier, h.insurance_issues))
    [{ id: ids.insurance }] = await insert("insurance", [{ building_id: bid, carrier: text(h.insurance_carrier), issues: text(h.insurance_issues) }]);
  if (anyKnown(mk.median_sale_12mo, mk.sales_count_12mo, mk.price_range, mk.period_end))
    [{ id: ids.sales }] = await insert("sales_stats", [{
      building_id: bid,
      period_end: date(mk.period_end),
      period_end_text: text(mk.period_end),
      median_sale: num(mk.median_sale_12mo),
      median_sale_text: text(mk.median_sale_12mo),
      sales_count: int(mk.sales_count_12mo),
      price_range: text(mk.price_range)
    }]);

  // Sources: one row per leaf that carries a url or date, linked to its record.
  function target(path) {
    const top = path.split(/[.[]/)[0];
    if (top === "association") return ["associations", assoc.id];
    if (top === "fees") return ["fees", bid];
    if (top === "rules") return ["rules", bid];
    if (top === "market") return ["sales_stats", ids.sales || null];
    if (top === "health") {
      const m = path.match(/^health\.special_assessments\[(\d+)\]/);
      if (m) return ["special_assessments", ids.sa[Number(m[1])] || null];
      if (/^health\.sirs_/.test(path)) return ["sirs_filings", ids.sirs || null];
      if (/^health\.milestone_/.test(path)) return ["milestone_inspections", ids.milestone || null];
      if (path === "health.loans") return ["loans", ids.loans || null];
      if (path === "health.litigation") return ["litigation", ids.litigation || null];
      if (/^health\.insurance_/.test(path)) return ["insurance", ids.insurance || null];
    }
    return ["buildings", bid];
  }
  await del("sources", `building_id=eq.${bid}&origin=eq.profile_loader`);
  const srcRows = collectLeaves(p)
    .filter(({ leaf }) => leaf.source_url || leaf.as_of)
    .map(({ path, leaf }) => {
      const [record_table, record_id] = target(path);
      return {
        building_id: bid,
        record_table,
        record_id,
        field_path: path,
        value: leaf.value ?? null,
        url: leaf.source_url || null,
        as_of: date(leaf.as_of),
        as_of_text: leaf.as_of ? String(leaf.as_of) : null,
        origin: "profile_loader"
      };
    });
  for (let i = 0; i < srcRows.length; i += 500) await insert("sources", srcRows.slice(i, i + 500));

  return { slug, sources: srcRows.length, band: band(h.risk_band, pub.band) };
}

// ---------------------------------------------------------------- main
function profilesIn(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.profiles)) return data.profiles;
  if (data && Array.isArray(data.buildings)) return data.buildings;
  return data ? [data] : [];
}

const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^group-.*\.json$/.test(f)).sort() : [];
if (!files.length) {
  console.error(`No group-*.json files in ${dir}`);
  process.exit(1);
}
const catalog = loadPublicCatalog();
let ok = 0;
let failed = 0;
for (const f of files) {
  let data;
  try {
    data = JSON.parse(readFileSync(join(dir, f), "utf8"));
  } catch (e) {
    console.warn(`skip ${f}: not valid JSON yet (${e.message})`);
    continue;
  }
  for (const p of profilesIn(data)) {
    try {
      const r = await loadProfile(p, catalog);
      ok++;
      console.log(`ok  ${f}  ${r.slug}  band=${r.band}  sources=${r.sources}`);
    } catch (e) {
      failed++;
      console.error(`ERR ${f}  ${p && p.slug}: ${e.message}`);
    }
  }
}
console.log(`\nLoaded ${ok} profile(s), ${failed} failed${DRY ? " (dry run, nothing written)" : ""}.`);
process.exit(failed ? 1 : 0);
