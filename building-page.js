/* CAMREXA per-building page: /b/<slug>
   Public: teaser (name, city, county, year built, units, band).
   Signed in + entitled: full file from /api/building (gated by Postgres RLS). */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const m = location.pathname.match(/^\/b\/([a-z0-9-]+)\/?$/);
  const slug = m ? m[1] : new URLSearchParams(location.search).get("slug");
  const params = new URLSearchParams(location.search);
  const paidSession = params.get("paid");

  const BAND_COPY = {
    "HIGH RISK": "High Risk does not mean never buy. It means price the remaining work into the deal.",
    WATCH: "Watch means work is coming or the public file is incomplete. Do not use monthly dues as the whole story.",
    STRONG: "Strong on the factors we can share here. Still pull the budget, SIRS, insurance dec page, and estoppel.",
    UNKNOWN: "Not banded yet. The desk is still compiling this association."
  };

  // ------------------------------------------------------------ data
  async function load() {
    const token = window.camrexaAuth ? await window.camrexaAuth.token() : null;
    const r = await fetch("/api/building?slug=" + encodeURIComponent(slug), {
      headers: token ? { authorization: "Bearer " + token } : {}
    });
    if (r.status === 404) return { notFound: true };
    if (!r.ok) throw new Error("Could not load this building");
    return r.json();
  }

  // ------------------------------------------------------------ teaser
  function renderTeaser(t) {
    document.title = t.name + " — CAMREXA Health Check";
    const facts = [
      [t.city, t.county ? t.county + " County" : null, t.state].filter(Boolean).join(", "),
      t.year_built ? "Built " + t.year_built : null,
      t.units ? t.units + " units" : null
    ].filter(Boolean);
    $("teaser").innerHTML =
      '<p class="band">' + esc(t.risk_band) + "</p>" +
      "<h1>" + esc(t.name) + "</h1>" +
      '<p class="fine">' + esc(facts.join(" · ")) + "</p>" +
      "<p>" + esc(BAND_COPY[t.risk_band] || BAND_COPY.UNKNOWN) + "</p>";
    if (window.camrexaEvent) window.camrexaEvent("ViewContent", { content_name: t.slug, content_category: t.risk_band });
  }

  // ------------------------------------------------------------ full report
  let sourceIndex = new Map(); // field_path -> footnote number
  let sourceList = [];

  function buildSourceIndex(sources) {
    sourceIndex = new Map();
    sourceList = [];
    const byUrl = new Map();
    (sources || []).forEach((s) => {
      if (!s.url) return;
      let n = byUrl.get(s.url);
      if (!n) {
        sourceList.push(s);
        n = sourceList.length;
        byUrl.set(s.url, n);
      }
      if (!sourceIndex.has(s.field_path)) sourceIndex.set(s.field_path, n);
    });
  }

  function cite(path) {
    const n = path && sourceIndex.get(path);
    return n ? ' <a class="cite" href="#src-' + n + '">[' + n + "]</a>" : "";
  }

  function isEmpty(v) {
    return v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0) ||
      (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
  }

  function fmt(v) {
    if (isEmpty(v)) return "";
    if (Array.isArray(v)) return "<ul>" + v.map((x) => "<li>" + fmt(x) + "</li>").join("") + "</ul>";
    if (typeof v === "object")
      return '<dl class="kv">' + Object.entries(v).filter(([, x]) => !isEmpty(x))
        .map(([k, x]) => "<dt>" + esc(k.replace(/_/g, " ")) + "</dt><dd>" + fmt(x) + "</dd>").join("") + "</dl>";
    if (typeof v === "string" && /^https?:\/\//.test(v))
      return '<a href="' + esc(v) + '" target="_blank" rel="noopener">' + esc(v) + "</a>";
    return esc(v);
  }

  // rows: [label, value, field_path]
  function section(title, rows, extraHtml) {
    const body = rows.filter((r) => !isEmpty(r[1]))
      .map((r) => '<div class="row"><div class="k">' + esc(r[0]) + '</div><div class="v">' + fmt(r[1]) + cite(r[2]) + "</div></div>")
      .join("");
    const content = body + (extraHtml || "");
    return '<section class="card rpt"><h2>' + esc(title) + "</h2>" +
      (content || '<p class="fine">Not found in the public record yet.</p>') + "</section>";
  }

  function renderFull(p) {
    buildSourceIndex(p.sources);
    const a = p.association || {};
    const b = p.building || {};
    const f = p.fees || {};
    const r = p.rules || {};
    const docs = p.documents || [];
    const docList = (types) => {
      const d = docs.filter((x) => types.indexOf(x.doc_type) !== -1 && x.download_url);
      return d.length
        ? '<p class="fine">Documents:</p><ul>' + d.map((x) =>
            '<li><a href="' + esc(x.download_url) + '" target="_blank" rel="noopener">' + esc(x.title || x.doc_type) + "</a>" +
            (x.as_of ? " (" + esc(x.as_of) + ")" : "") + "</li>").join("") + "</ul>"
        : "";
    };

    const html = [];
    html.push(section("Overview", [
      ["Address", p.address, "address"],
      ["Location", [p.city, p.county ? p.county + " County" : null, p.state].filter(Boolean).join(", ")],
      ["Risk band", p.risk_band, "health.risk_band"],
      ["Health summary", p.health_summary, "health.health_summary"],
      ["Association", a.legal_name, "association.legal_name"],
      ["DBPR project #", a.dbpr_project_numbers, "association.dbpr_project_numbers"],
      ["Sunbiz ID", a.sunbiz_id, "association.sunbiz_id"],
      ["Management", a.management_company, "association.management_company"],
      ["Management contact", a.management_contact, "association.management_contact"],
      ["Website", a.website, "association.website"],
      ["Where sources disagree", p.conflicts]
    ]));
    html.push(section("Units & amenities", [
      ["Year built", b.year_built, "building.year_built"],
      ["Units", b.units, "building.units"],
      ["Floors", b.floors, "building.floors"],
      ["Buildings", b.buildings_count, "building.buildings_count"],
      ["Unit mix", b.unit_mix, "building.unit_mix"],
      ["Elevators", b.elevators, "building.elevators"],
      ["Flood zone", b.flood_zone, "building.flood_zone"],
      ["Construction", b.construction_notes, "building.construction_notes"],
      ["Amenities", p.amenities, "amenities"]
    ]));
    html.push(section("HOA dues and what they cover", [
      ["Dues by unit type", f.dues_by_unit_type, "fees.dues_by_unit_type"],
      ["Billed", f.dues_frequency, "fees.dues_frequency"],
      ["Dues cover", f.dues_cover, "fees.dues_cover"],
      ["Not covered", f.dues_exclude, "fees.dues_exclude"],
      ["Insurance assessment", f.insurance_assessment, "fees.insurance_assessment"],
      ["CDD fee", f.cdd_fee, "fees.cdd_fee"],
      ["Reserves, % of budget", f.reserves_pct_of_budget != null ? f.reserves_pct_of_budget + "%" : f.reserves_note, "fees.reserves_pct_of_budget"],
      ["Recent dues change", f.recent_dues_change, "fees.recent_dues_change"]
    ], docList(["budget", "financials"])));
    html.push(section("Pets", [
      ["Owners", r.pets_owners, "rules.pets_owners"],
      ["Renters / guests", r.pets_renters, "rules.pets_renters"]
    ]));
    html.push(section("Parking", [
      ["Parking", r.parking, "rules.parking"],
      ["Parking fees", r.parking_fees, "rules.parking_fees"],
      ["Golf carts / trailers", r.golf_carts_trailers, "rules.golf_carts_trailers"]
    ]));
    html.push(section("Rentals", [
      ["Short-term rentals", r.short_term_rentals, "rules.short_term_rentals"],
      ["Minimum stay", r.rental_minimum_stay, "rules.rental_minimum_stay"],
      ["Renter minimum age", r.renter_min_age, "rules.renter_min_age"],
      ["Rental program", r.rental_program, "rules.rental_program"],
      ["Registration fees", r.registration_fees, "rules.registration_fees"]
    ], docList(["rules", "declaration"])));

    const sirsRows = [];
    (p.sirs_filings || []).forEach((s) => {
      sirsRows.push(["SIRS status", s.status, "health.sirs_status"]);
      sirsRows.push(["SIRS date", s.completed_on || s.completed_text, "health.sirs_date"]);
      if (s.notes) sirsRows.push(["SIRS notes", s.notes]);
    });
    (p.milestone_inspections || []).forEach((s) => {
      sirsRows.push(["Milestone" + (s.phase ? " (" + s.phase + ")" : ""), s.status, "health.milestone_status"]);
      sirsRows.push(["Milestone due", s.due_on || s.due_text, "health.milestone_due"]);
    });
    html.push(section("SIRS & milestone inspection", sirsRows, docList(["sirs", "milestone"])));

    const saRows = [];
    (p.special_assessments || []).forEach((s, i) => {
      const base = "health.special_assessments[" + i + "]";
      saRows.push([s.purpose || "Special assessment " + (i + 1), {
        amount: s.amount_text || s.amount,
        per_unit: s.per_unit,
        approved: s.approved_on || s.approved_text,
        schedule: s.schedule
      }, base + ".amount"]);
    });
    html.push(section("Special assessments", saRows));

    const liRows = [];
    (p.loans || []).forEach((l) => liRows.push(["Association loans", l.description || l.lender, "health.loans"]));
    (p.litigation || []).forEach((l) => liRows.push(["Litigation", l.description || l.case_number, "health.litigation"]));
    (p.insurance || []).forEach((x) => {
      liRows.push(["Insurance carrier", x.carrier, "health.insurance_carrier"]);
      liRows.push(["Insurance issues", x.issues, "health.insurance_issues"]);
    });
    html.push(section("Loans, litigation & insurance", liRows, docList(["insurance"])));

    const s0 = (p.sales_stats || [])[0] || {};
    html.push(section("Sales", [
      ["Median sale, 12 months", s0.median_sale_text || s0.median_sale, "market.median_sale_12mo"],
      ["Sales, 12 months", s0.sales_count, "market.sales_count_12mo"],
      ["Price range", s0.price_range, "market.price_range"],
      ["Period ending", s0.period_end || s0.period_end_text, "market.period_end"]
    ]));

    const srcHtml = sourceList.length
      ? "<ol class=\"sources\">" + sourceList.map((s, i) =>
          '<li id="src-' + (i + 1) + '"><a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.url) + "</a>" +
          (s.as_of || s.as_of_text ? ' <span class="fine">as of ' + esc(s.as_of || s.as_of_text) + "</span>" : "") + "</li>").join("") + "</ol>"
      : "";
    html.push(section("Sources", [], srcHtml + docList(["other", "minutes"])));

    $("full").innerHTML = html.join("");
    $("full").hidden = false;
    $("locked").hidden = true;
  }

  // ------------------------------------------------------------ unlock / sign in
  async function startCheckout() {
    const btn = $("unlock-btn");
    btn.disabled = true;
    $("unlock-msg").textContent = "Opening secure checkout…";
    try {
      const token = window.camrexaAuth ? await window.camrexaAuth.token() : null;
      const headers = { "content-type": "application/json" };
      if (token) headers.authorization = "Bearer " + token;
      if (window.camrexaEvent) window.camrexaEvent("InitiateCheckout", { content_name: slug, value: 149, currency: "USD" });
      const r = await fetch("/api/checkout", { method: "POST", headers: headers, body: JSON.stringify({ slug: slug }) });
      const d = await r.json();
      if (!r.ok || !d.url) throw new Error(d.error || "Checkout is not available right now");
      location.href = d.url;
    } catch (e) {
      $("unlock-msg").textContent = e.message;
      btn.disabled = false;
    }
  }

  function wireLocked(state) {
    $("locked").hidden = false;
    $("unlock-btn").onclick = startCheckout;
    $("signin-form").onsubmit = async function (e) {
      e.preventDefault();
      $("signin-msg").textContent = "Sending…";
      try {
        await window.camrexaAuth.sendMagicLink($("signin-email").value, location.origin + "/b/" + slug);
        $("signin-msg").textContent = "Check your email for the sign-in link.";
      } catch (err) {
        $("signin-msg").textContent = err.message;
      }
    };
    if (state.signed_in) {
      $("signin-box").hidden = true;
      $("unlock-msg").textContent = "Signed in as " + (state.email || "you") + ". This building is not unlocked on this account yet.";
    }
    if (paidSession) {
      $("signin-box").open = !state.signed_in;
      $("unlock-msg").textContent = state.signed_in
        ? "Payment received. Unlocking — this can take a few seconds."
        : "Payment received. Sign in below with the email you paid with to open the full file.";
    }
  }

  function wireAccount(state) {
    const link = $("account-link");
    if (!state.signed_in) return;
    link.hidden = false;
    link.textContent = "Sign out";
    link.onclick = function (e) {
      e.preventDefault();
      window.camrexaAuth.signOut();
      location.reload();
    };
  }

  // ------------------------------------------------------------ boot
  async function boot(attempt) {
    if (!slug) {
      $("teaser").innerHTML = '<p>Pick a building on <a href="/">Check My Condo</a>.</p>';
      return;
    }
    try {
      const state = await load();
      if (state.notFound) {
        $("teaser").innerHTML = '<h1>Not on the desk yet</h1><p><a href="/capture">Send the building name</a> and we will run the Health Check.</p>';
        return;
      }
      renderTeaser(state.teaser);
      wireAccount(state);
      if (state.entitled && state.profile) return renderFull(state.profile);
      wireLocked(state);
      // Just paid and signed in: the webhook may land a moment after the redirect.
      if (paidSession && state.signed_in && attempt < 8) setTimeout(() => boot(attempt + 1), 2500);
    } catch (e) {
      $("teaser").innerHTML = '<p class="fine">' + esc(e.message) + "</p>";
    }
  }
  boot(0);
})();
