/* CAMREXA browser auth: Supabase email magic link, no SDK.
   Session lives in localStorage; the access token is sent to /api/* as a Bearer token. */
(function () {
  const KEY = "camrexa_session";
  let cfgPromise = null;

  function config() {
    if (!cfgPromise) {
      cfgPromise = fetch("/api/public-config").then((r) => {
        if (!r.ok) throw new Error("Sign-in is not configured yet");
        return r.json();
      });
    }
    return cfgPromise;
  }

  function read() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || "null");
    } catch (e) {
      return null;
    }
  }
  function write(s) {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  }
  function fromTokenPayload(p) {
    let email = null;
    try {
      email = JSON.parse(atob(p.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).email || null;
    } catch (e) {}
    return {
      access_token: p.access_token,
      refresh_token: p.refresh_token,
      expires_at: p.expires_at ? Number(p.expires_at) : Math.floor(Date.now() / 1000) + Number(p.expires_in || 3600),
      email: (p.user && p.user.email) || email
    };
  }

  // Magic-link return: tokens arrive in the URL hash.
  (function captureHash() {
    if (!location.hash || location.hash.indexOf("access_token=") === -1) return;
    const h = new URLSearchParams(location.hash.slice(1));
    const s = fromTokenPayload(Object.fromEntries(h.entries()));
    if (s.access_token) write(s);
    history.replaceState(null, "", location.pathname + location.search);
  })();

  async function refresh(s) {
    const c = await config();
    const r = await fetch(c.supabaseUrl + "/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      headers: { apikey: c.supabaseAnonKey, "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: s.refresh_token })
    });
    if (!r.ok) {
      write(null);
      return null;
    }
    const next = fromTokenPayload(await r.json());
    write(next);
    return next;
  }

  async function token() {
    let s = read();
    if (!s) return null;
    if (s.expires_at - 60 < Date.now() / 1000) s = await refresh(s);
    return s ? s.access_token : null;
  }

  async function sendMagicLink(email, redirectTo) {
    const c = await config();
    const r = await fetch(c.supabaseUrl + "/auth/v1/otp?redirect_to=" + encodeURIComponent(redirectTo || location.href), {
      method: "POST",
      headers: { apikey: c.supabaseAnonKey, "content-type": "application/json" },
      body: JSON.stringify({ email: email, create_user: true })
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.msg || d.error_description || "Could not send the sign-in link");
    }
  }

  window.camrexaAuth = {
    token: token,
    email: function () {
      const s = read();
      return s ? s.email : null;
    },
    signedIn: function () {
      return !!read();
    },
    sendMagicLink: sendMagicLink,
    signOut: function () {
      write(null);
    }
  };
})();
