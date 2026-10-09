(function () {
  const KEY = "camrexa_attribution";
  const params = new URLSearchParams(location.search);
  const keys = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "gclid", "ttclid"];
  const incoming = {};
  keys.forEach((k) => {
    if (params.get(k)) incoming[k] = params.get(k);
  });
  if (Object.keys(incoming).length) {
    incoming.landing = location.pathname;
    incoming.at = new Date().toISOString();
    localStorage.setItem(KEY, JSON.stringify(incoming));
  }
  window.camrexaAttribution = function () {
    try {
      return JSON.parse(localStorage.getItem(KEY) || "{}");
    } catch (e) {
      return {};
    }
  };

  const cfg = window.CAMREXA_CONFIG || {};
  if (cfg.pixelId) {
    !(function (f, b, e, v, n, t, s) {
      if (f.fbq) return;
      n = f.fbq = function () {
        n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
      };
      if (!f._fbq) f._fbq = n;
      n.push = n;
      n.loaded = !0;
      n.version = "2.0";
      n.queue = [];
      t = b.createElement(e);
      t.async = !0;
      t.src = v;
      s = b.getElementsByTagName(e)[0];
      s.parentNode.insertBefore(t, s);
    })(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");
    fbq("init", cfg.pixelId);
    fbq("track", "PageView");
  }
  if (cfg.gtagId) {
    const s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + cfg.gtagId;
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () {
      dataLayer.push(arguments);
    };
    gtag("js", new Date());
    gtag("config", cfg.gtagId);
  }

  window.camrexaEvent = function (name, payload) {
    const data = Object.assign({ event: name, path: location.pathname }, payload || {}, window.camrexaAttribution());
    const log = JSON.parse(localStorage.getItem("camrexa_events") || "[]");
    log.push(Object.assign({ at: new Date().toISOString() }, data));
    localStorage.setItem("camrexa_events", JSON.stringify(log));
    if (window.fbq) {
      const map = { Lead: "Lead", InitiateCheckout: "InitiateCheckout", Subscribe: "Subscribe", ViewContent: "ViewContent" };
      fbq("track", map[name] || "CustomEvent", payload || {});
    }
    if (window.gtag) gtag("event", name.toLowerCase(), payload || {});
  };

  window.camrexaSendLead = function (lead) {
    const body = Object.assign(
      {
        _subject: lead.subject || "CAMREXA lead",
        source: "camrexa-site"
      },
      lead,
      window.camrexaAttribution()
    );
    const email = (window.CAMREXA_CONFIG && window.CAMREXA_CONFIG.deskEmail) || "chad@chadmiller.com";
    return fetch("https://formsubmit.co/ajax/" + email, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body)
    }).catch(function () {});
  };
})();
