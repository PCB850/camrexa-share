(function () {
  const buildings = window.CAMREXA_BUILDINGS || [];
  const select = document.getElementById("building");
  if (select) {
    const first = document.createElement("option");
    first.value = "";
    first.textContent = "Select a PCB condo";
    select.appendChild(first);
    buildings
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((b) => {
        const o = document.createElement("option");
        o.value = b.id;
        o.textContent = b.name;
        select.appendChild(o);
      });
    const params = new URLSearchParams(location.search);
    if (params.get("b")) select.value = params.get("b");
  }

  const form = document.getElementById("check-form");
  if (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      const buildingId = document.getElementById("building").value;
      if (!buildingId) return;
      const lead = {
        building: buildingId,
        intent: document.getElementById("intent").value,
        email: document.getElementById("email").value,
        phone: document.getElementById("phone").value,
        at: new Date().toISOString(),
        subject: "CAMREXA Check My Condo"
      };
      const leads = JSON.parse(localStorage.getItem("camrexa_leads") || "[]");
      leads.push(lead);
      localStorage.setItem("camrexa_leads", JSON.stringify(leads));
      localStorage.setItem("camrexa_last_lead", JSON.stringify(lead));
      if (window.camrexaEvent) window.camrexaEvent("Lead", { content_name: lead.building, status: lead.intent });
      if (window.camrexaSendLead) window.camrexaSendLead(lead);
      location.href = "check.html?b=" + encodeURIComponent(buildingId);
    });
  }

  document.querySelectorAll("[data-event]").forEach((el) => {
    el.addEventListener("click", function () {
      if (window.camrexaEvent) window.camrexaEvent(el.getAttribute("data-event"), { content_name: el.getAttribute("data-content") || el.href });
    });
  });

  const paid = document.getElementById("paid-form");
  if (paid) {
    const q = new URLSearchParams(location.search).get("b");
    const match = buildings.find((x) => x.id === q);
    const field = document.getElementById("paid-building");
    if (field && match) field.value = match.name;
    else if (field && q) field.value = q;
    paid.addEventListener("submit", function (e) {
      e.preventDefault();
      const lead = {
        building: field ? field.value : "",
        email: paid.email.value,
        phone: paid.phone.value,
        intent: "report",
        subject: "CAMREXA $149 report"
      };
      if (window.camrexaEvent) window.camrexaEvent("InitiateCheckout", { content_name: lead.building, value: 149, currency: "USD" });
      if (window.camrexaSendLead) window.camrexaSendLead(lead);
      location.href = "thanks.html";
    });
  }

  const result = document.getElementById("result");
  if (result) {
    const params = new URLSearchParams(location.search);
    const id = params.get("b");
    const building = buildings.find((x) => x.id === id);
    if (!building) {
      result.innerHTML = "<p>Building not on the desk yet. <a href=\"capture.html\">Send the name</a> and we will run the Health Check.</p>";
      return;
    }
    if (window.camrexaEvent) window.camrexaEvent("ViewContent", { content_name: building.name, content_category: building.band });
    const copy = {
      "HIGH RISK": "This is High Risk. That does not mean never buy. It means price the remaining work into the deal.",
      WATCH: "This is Watch. Work is coming or the public file is incomplete. Do not use monthly dues as the whole story.",
      STRONG: "This screens Strong on the factors we can share here. Still pull the budget, SIRS, insurance dec page, and estoppel."
    };
    result.innerHTML =
      '<p class="band">' +
      building.band +
      "</p><h1>" +
      building.name +
      "</h1><p>" +
      copy[building.band] +
      "</p>" +
      "<ul class=\"lock\">" +
      "<li>Reserves — locked</li>" +
      "<li>Assessments — locked</li>" +
      "<li>Insurance — locked</li>" +
      "<li>Roof remaining life — locked</li>" +
      "<li>SIRS / milestone — locked</li>" +
      "<li>Debt — locked</li>" +
      "</ul>" +
      '<p class="fine">Numeric score, reserve cash, and the source file stay in the $149 Condo Intelligence Report™.</p>' +
      '<p><a class="btn" data-event="InitiateCheckout" data-content="' +
      building.id +
      '" href="report.html?b=' +
      encodeURIComponent(building.id) +
      '">Unlock the $149 report</a> <a class="btn" href="watch.html?b=' +
      encodeURIComponent(building.id) +
      '">Join HOA Watch</a></p>';
  }
})();
