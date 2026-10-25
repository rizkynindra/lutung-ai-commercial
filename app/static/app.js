// LUTUNG AI frontend. Identity comes from Firebase; the backend re-verifies every token.
(function () {
  const cfg = window.LUTUNG_CONFIG;
  const $ = (id) => document.getElementById(id);
  const listeners = [];
  let user, fb = null; // user: undefined = loading, null = signed out

  const MSG = {
    INVALID_FILE: "File tidak valid atau formatnya tidak didukung. Pilih gambar JPEG/PNG lalu coba lagi.",
    FILE_TOO_LARGE: "Ukuran file atau dimensi gambar melebihi batas. Perkecil file lalu coba lagi.",
    UNAUTHORIZED: "Sesi Anda berakhir atau tidak valid. Silakan masuk kembali.",
    CONSENT_REQUIRED: "Setujui pemberitahuan penanganan data terlebih dahulu.",
    TRIAL_ALREADY_USED: "Uji coba gratis OCR KTP Anda sudah digunakan. Akses berbayar belum tersedia. Silakan kembali lagi nanti atau hubungi tim LUTUNG untuk akses pilot.",
    TRIAL_IN_PROGRESS: "Permintaan uji coba Anda masih diproses. Tunggu hingga selesai.",
    RATE_LIMITED: "Terlalu banyak permintaan. Coba lagi beberapa saat lagi.",
    SERVICE_UNAVAILABLE: "Layanan sedang tidak tersedia atau sibuk. Coba lagi nanti; jangan kirim berulang kali.",
    PROCESSING_TIMEOUT: "Pemrosesan melebihi batas waktu. Uji coba Anda tidak terpakai; silakan coba lagi.",
    INTERNAL_ERROR: "Terjadi kesalahan pada server.",
  };
  const POST_TRIAL = MSG.TRIAL_ALREADY_USED;

  const AUTH_ERR = {
    "auth/invalid-email": "Email tidak valid.",
    "auth/missing-password": "Isi kata sandi.",
    "auth/weak-password": "Kata sandi minimal 6 karakter.",
    "auth/email-already-in-use": "Email ini sudah terdaftar. Silakan masuk.",
    "auth/invalid-credential": "Email atau kata sandi salah.",
    "auth/user-not-found": "Email atau kata sandi salah.",
    "auth/wrong-password": "Email atau kata sandi salah.",
    "auth/too-many-requests": "Terlalu banyak percobaan. Coba lagi nanti.",
    "auth/unauthorized-domain": "Domain ini belum diizinkan untuk masuk dengan Google.",
    "auth/operation-not-allowed": "Metode masuk ini belum diaktifkan.",
    "auth/popup-blocked": "Browser memblokir jendela Google. Izinkan popup, lalu coba lagi.",
    "auth/network-request-failed": "Tidak tersambung ke Firebase. Periksa jaringan Anda.",
  };
  const PROVIDER_LABEL = { "google.com": "Masuk dengan Google", password: "Masuk dengan email" };

  function store(fn) { try { return fn(); } catch (e) { return null; } }
  function emit() { renderAuth(); listeners.forEach((f) => f(user)); }
  function onAuth(f) { listeners.push(f); if (user !== undefined) f(user); }
  function authErrorText(e) { return AUTH_ERR[e && e.code] || "Gagal masuk. Silakan coba lagi."; }
  function profile(u) {
    const provider = (u.providerData[0] && u.providerData[0].providerId) || "password";
    return { email: u.email, name: u.displayName, provider };
  }

  if (!cfg.devAuth && cfg.firebase.apiKey && window.firebase) {
    firebase.initializeApp(cfg.firebase);
    fb = firebase.auth();
    fb.onAuthStateChanged((u) => { user = u ? profile(u) : null; emit(); });
  } else {
    const t = cfg.devAuth && store(() => localStorage.getItem("lutung_dev_token"));
    user = t ? { email: t.split(":")[2] } : null;
    setTimeout(emit);
  }

  async function getToken() {
    if (fb && fb.currentUser) return fb.currentUser.getIdToken(); // auto-refreshes expired tokens
    if (cfg.devAuth) return store(() => localStorage.getItem("lutung_dev_token"));
    return null;
  }

  function showAuthError(e) {
    const el = $("auth-error");
    if (el) el.textContent = e && e.code ? authErrorText(e) : "";
  }

  async function googleSignIn() {
    showAuthError({ code: "" });
    try {
      await fb.signInWithPopup(new firebase.auth.GoogleAuthProvider());
      $("auth-dialog").close();
    } catch (e) {
      if (e.code !== "auth/popup-closed-by-user") showAuthError(e);
    }
  }

  async function emailAuth(create) {
    const form = $("auth-form");
    if (!form.reportValidity()) return;
    form.password.autocomplete = create ? "new-password" : "current-password";
    showAuthError({ code: "" });
    try {
      const email = form.email.value.trim();
      const password = form.password.value;
      if (create) await fb.createUserWithEmailAndPassword(email, password);
      else await fb.signInWithEmailAndPassword(email, password);
      form.reset();
      $("auth-dialog").close();
    } catch (e) {
      showAuthError(e);
    }
  }

  function bindAuthDialog() {
    const dialog = $("auth-dialog");
    const form = $("auth-form");
    if (!dialog || !form) return;
    dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
    $("auth-close").addEventListener("click", () => dialog.close());
    $("auth-google").addEventListener("click", googleSignIn);
    $("auth-signup").addEventListener("click", () => emailAuth(true));
    form.addEventListener("submit", (e) => { e.preventDefault(); emailAuth(false); });
  }

  function signIn() {
    if (cfg.devAuth) {
      const email = prompt("Dev sign-in (LUTUNG_DEV_AUTH): email");
      if (email) { store(() => localStorage.setItem("lutung_dev_token", `dev:${email}:${email}`)); user = { email }; emit(); }
      return;
    }
    if (!fb) {
      alert("Masuk belum dikonfigurasi di server ini.");
      return;
    }
    showAuthError({ code: "" });
    $("auth-dialog").showModal();
  }

  async function signOut() {
    if (fb) await fb.signOut();
    else { store(() => localStorage.removeItem("lutung_dev_token")); user = null; emit(); }
  }

  function renderAuth() {
    const area = $("auth-area");
    if (!area) return;
    area.replaceChildren();
    if (user === undefined) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn small" + (user ? " ghost" : "");
    if (user) {
      const a = document.createElement("a");
      a.href = "/account"; a.textContent = user.email || "Akun";
      btn.textContent = "Keluar"; btn.onclick = signOut;
      area.append(a, btn);
    } else {
      btn.textContent = "Masuk"; btn.dataset.signin = "";
      area.append(btn);
    }
  }

  bindAuthDialog();
  document.addEventListener("click", (e) => { if (e.target.closest("[data-signin]")) signIn(); });

  // Docs: copy buttons copy their data-copy value, or the code block in the same card.
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-copy]");
    if (!b) return;
    const card = b.closest(".code-card");
    const text = b.dataset.copy || (card && card.querySelector("pre").textContent) || "";
    try { await navigator.clipboard.writeText(text); b.textContent = "Copied"; }
    catch (err) { b.textContent = "Failed"; }
    setTimeout(() => { b.textContent = "Copy"; }, 1500);
  });

  async function api(path, opts = {}) {
    const headers = Object.assign({}, opts.headers);
    const token = await getToken();
    if (token) headers.Authorization = "Bearer " + token;
    try {
      const r = await fetch(path, Object.assign({}, opts, { headers }));
      let body = {};
      try { body = await r.json(); } catch (e) { /* non-JSON */ }
      return { ok: r.ok, status: r.status, body };
    } catch (e) {
      return { ok: false, status: 0, body: { error: { code: "SERVICE_UNAVAILABLE" } } };
    }
  }

  function errorText(r) {
    const code = (r.body.error && r.body.error.code) || "INTERNAL_ERROR";
    const rid = r.body.request_id ? ` (ID permintaan: ${r.body.request_id})` : "";
    return (MSG[code] || MSG.INTERNAL_ERROR) + rid;
  }

  // Card CTA labels depend on sign-in and trial state.
  onAuth(async (u) => {
    const ctas = document.querySelectorAll("[data-cta]");
    if (!ctas.length || u === undefined) return;
    let trials = {};
    if (u) { const r = await api("/api/v1/me"); if (r.ok) trials = r.body.trials; }
    ctas.forEach((a) => {
      if (!u) a.textContent = "Masuk untuk mencoba";
      else if (a.dataset.access === "trial" && trials[a.dataset.cta] === "CONSUMED") a.textContent = "Uji coba terpakai";
      else a.textContent = "Coba sekarang";
    });
  });

  function initCatalog() {
    const q = $("q"), cat = $("cat"), st = $("st"), cards = [...document.querySelectorAll("#catalog .card")];
    function apply() {
      const term = q.value.trim().toLowerCase();
      let n = 0;
      cards.forEach((c) => {
        const show = (!term || c.dataset.name.includes(term)) && (!cat.value || c.dataset.category === cat.value)
          && (!st.value || c.dataset.status === st.value);
        c.hidden = !show; n += show;
      });
      $("count").textContent = n ? `${n} teknologi` : "Tidak ada teknologi yang cocok dengan pencarian.";
    }
    [q, cat, st].forEach((x) => x.addEventListener("input", apply));
    apply();
  }

  function initPlayground() {
    const pg = $("pg"), slug = pg.dataset.slug, trial = pg.dataset.access === "trial";
    const sensitive = pg.dataset.sensitive === "true", maxBytes = +pg.dataset.max;
    const form = $("pg-form"), status = $("status"), file = $("file"), preview = $("preview");
    let lastRid = null, lastJson = "";

    function show(id, on) { const x = $(id); if (x) x.hidden = !on; }
    function postTrial() { $("trial-state").textContent = POST_TRIAL; show("trial-state", true); show("pg-form", false); }

    onAuth(async (u) => {
      ["need-login", "trial-state", "consent", "pg-form", "feedback"].forEach((id) => show(id, false));
      if (u === undefined || pg.dataset.live !== "true") return;
      if (!u) return show("need-login", true);
      status.textContent = "Memeriksa status akun…";
      const r = await api("/api/v1/me");
      status.textContent = "";
      if (!r.ok) { status.textContent = errorText(r); return; }
      show("feedback", true);
      if (trial) {
        const s = r.body.trials[slug];
        if (s === "CONSUMED") return postTrial();
        $("trial-state").textContent = s === "RESERVED"
          ? "Permintaan uji coba Anda sedang diproses."
          : "Uji coba gratis tersedia: 1 kali pemrosesan yang berhasil untuk akun Anda.";
        show("trial-state", true);
      }
      if (sensitive && !r.body.consent) return show("consent", true);
      show("pg-form", true);
    });

    if (sensitive) {
      $("consent-check").addEventListener("change", (e) => { $("consent-btn").disabled = !e.target.checked; });
      $("consent-btn").addEventListener("click", async () => {
        const r = await api("/api/v1/consent", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notice_version: cfg.noticeVersion }) });
        if (!r.ok) { status.textContent = errorText(r); return; }
        show("consent", false); show("pg-form", true);
      });
    }

    file.addEventListener("change", () => {
      const f = file.files[0];
      preview.hidden = true;
      status.textContent = "";
      if (!f) return;
      if (!["image/jpeg", "image/png"].includes(f.type)) { status.textContent = MSG.INVALID_FILE; file.value = ""; return; }
      if (f.size > maxBytes) { status.textContent = MSG.FILE_TOO_LARGE; file.value = ""; return; }
      preview.src = URL.createObjectURL(f);
      preview.hidden = false;
      status.textContent = `File dipilih: ${f.name}`;
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!file.files[0]) return;
      const btn = $("submit");
      btn.disabled = true;
      show("result", false);
      status.textContent = "Mengunggah dan memproses… Permintaan pertama bisa lebih lama saat layanan sedang dinyalakan.";
      const fd = new FormData();
      fd.append("file", file.files[0]);
      const r = await api(`/api/v1/playground/${slug}`, { method: "POST", body: fd });
      btn.disabled = false;
      lastRid = r.body.request_id || null;
      if (!r.ok) {
        status.textContent = errorText(r);
        if (r.body.error && r.body.error.code === "TRIAL_ALREADY_USED") postTrial();
        if (r.status === 401) show("need-login", true);
        return;
      }
      status.textContent = "Selesai.";
      renderResult(r.body.data || {});
      if (trial) postTrial();
    });

    function renderResult(data) {
      const kv = $("kv");
      kv.replaceChildren();
      Object.entries(data).forEach(([k, v]) => {
        if (k.startsWith("_")) return;
        const tr = kv.insertRow(), th = document.createElement("th");
        th.textContent = k;
        tr.append(th);
        tr.insertCell().textContent = typeof v === "object" ? JSON.stringify(v) : String(v);
      });
      if (!kv.rows.length) kv.insertRow().insertCell().textContent = "Tidak ada field yang dapat ditampilkan; lihat JSON mentah.";
      lastJson = JSON.stringify(data, null, 2);
      $("raw").textContent = lastJson;  // textContent: model output is never rendered as HTML
      show("result", true);
      show("result-empty", false);
    }

    $("copy").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(lastJson); status.textContent = "JSON disalin."; }
      catch (e) { status.textContent = "Gagal menyalin JSON."; }
    });
    $("download").addEventListener("click", () => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([lastJson], { type: "application/json" }));
      a.download = `${slug}-${lastRid || "result"}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
    $("fb-send").addEventListener("click", async () => {
      const message = $("fb-msg").value.trim();
      if (!message) return;
      const r = await api("/api/v1/feedback", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ technology: slug, request_id: lastRid, message, context: navigator.userAgent }) });
      status.textContent = r.ok ? "Laporan terkirim. Terima kasih." : errorText(r);
      if (r.ok) $("fb-msg").value = "";
    });
  }

  function initAccount() {
    const LABEL = { AVAILABLE: ["Tersedia", "s-available"], RESERVED: ["Sedang diproses", "s-beta"], CONSUMED: ["Sudah digunakan", "s-coming_soon"] };
    $("acct-signout").addEventListener("click", signOut);
    onAuth(async (u) => {
      $("acct").hidden = true;
      $("acct-login").hidden = true;
      if (u === undefined) return;
      if (!u) { $("acct-status").textContent = ""; $("acct-login").hidden = false; return; }
      $("acct-status").textContent = "Memuat…";
      const r = await api("/api/v1/me");
      if (!r.ok) { $("acct-status").textContent = errorText(r); return; }
      const me = r.body, name = me.display_name || me.email || "Pengguna";
      $("acct-status").textContent = "";
      $("acct-name").textContent = name;
      $("acct-email").textContent = me.email || "";
      $("acct-provider").textContent = PROVIDER_LABEL[u.provider] || "Masuk";
      $("acct-avatar").textContent = name.trim().charAt(0).toUpperCase();
      $("acct-consent").textContent = me.consent ? "Sudah disetujui" : "Belum disetujui";
      document.querySelectorAll("[data-trial]").forEach((el) => {
        const [text, cls] = LABEL[me.trials[el.dataset.trial]] || ["—", ""];
        el.textContent = text;
        el.className = "badge " + cls;
      });
      document.querySelectorAll("[data-trial-cta]").forEach((a) => {
        if (a.dataset.trialCta && me.trials[a.dataset.trialCta] === "CONSUMED") a.textContent = "Lihat detail";
      });
      $("acct").hidden = false;
    });
  }

  window.LUTUNG = { initCatalog, initPlayground, initAccount };
})();
