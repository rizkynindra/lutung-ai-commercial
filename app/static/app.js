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
    TRIAL_ALREADY_USED: "Uji coba gratismu sudah digunakan. Kuota kembali 7 hari setelah percobaan yang berhasil.",
    TRIAL_IN_PROGRESS: "Permintaan uji coba Anda masih diproses. Tunggu hingga selesai.",
    RATE_LIMITED: "Terlalu banyak permintaan. Coba lagi beberapa saat lagi.",
    SERVICE_UNAVAILABLE: "Layanan sedang tidak tersedia atau sibuk. Coba lagi nanti; jangan kirim berulang kali.",
    PROCESSING_TIMEOUT: "Pemrosesan melebihi batas waktu. Uji coba Anda tidak terpakai; silakan coba lagi.",
    INVALID_REQUEST: "Permintaan tidak valid. Periksa isian lalu coba lagi.",
    INTERNAL_ERROR: "Terjadi kesalahan pada server.",
  };
  const AUTH_ERR = {
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

  function bindAuthDialog() {
    const dialog = $("auth-dialog");
    if (!dialog || !$("auth-google")) return;
    dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
    $("auth-close").addEventListener("click", () => dialog.close());
    $("auth-google").addEventListener("click", googleSignIn);
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

  function trialUsedText(resetsAt) {
    const days = cfg.trialDays || 7;
    if (!resetsAt) return `Uji coba gratismu sudah digunakan. Kuota kembali ${days} hari setelah percobaan yang berhasil.`;
    const when = new Date(resetsAt * 1000).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" });
    return `Uji coba gratismu sudah digunakan. Tersedia lagi ${when}.`;
  }

  function errorText(r) {
    const code = (r.body.error && r.body.error.code) || "INTERNAL_ERROR";
    const server = r.body.error && r.body.error.message;
    const rid = r.body.request_id ? ` (ID permintaan: ${r.body.request_id})` : "";
    const text = code === "TRIAL_ALREADY_USED" ? trialUsedText(r.body.resets_at)
      : (code === "INVALID_REQUEST" && server) ? server : (MSG[code] || MSG.INTERNAL_ERROR);
    return text + rid;
  }

  // Card CTA labels depend on sign-in and trial state.
  onAuth(async (u) => {
    const ctas = document.querySelectorAll("[data-cta]");
    if (!ctas.length || u === undefined) return;
    let trials = {}, admin = false;
    if (u) {
      const r = await api("/api/v1/me");
      if (r.ok) { trials = r.body.trials; admin = !!r.body.admin; }
    }
    ctas.forEach((a) => {
      if (!u) a.textContent = "Masuk untuk mencoba";
      else if (!admin && a.dataset.access === "trial" && trials[a.dataset.cta] === "CONSUMED") a.textContent = "Uji coba terpakai";
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

  function safeImage(src) {
    return typeof src === "string" && (src.startsWith("data:image/") || src.startsWith("https://"));
  }

  function initPlayground() {
    const pg = $("pg"), slug = pg.dataset.slug, trial = pg.dataset.access === "trial";
    const generate = pg.dataset.kind === "generate";
    const sensitive = pg.dataset.sensitive === "true", maxBytes = +pg.dataset.max;
    const form = $("pg-form"), status = $("status"), file = $(generate ? "source-file" : "file");
    const preview = $(generate ? "source-preview" : "preview");
    let lastRid = null, lastJson = "", lastImage = "", admin = false, ticker = null;
    const submitLabel = { create: "Buat gambar", edit: "Ubah gambar", transparent: "Buat latar transparan" };

    function show(id, on) { const x = $(id); if (x) x.hidden = !on; }
    function clockText(ms) {
      const total = Math.max(0, Math.floor(ms / 1000));
      return Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
    }
    function startClock() {
      stopClock();
      const begun = Date.now();
      const line = $("elapsed"), value = $("elapsed-value");
      if (!line || !value) return begun;
      value.textContent = "0:00";
      line.hidden = false;
      ticker = setInterval(() => { value.textContent = clockText(Date.now() - begun); }, 1000);
      return begun;
    }
    function stopClock() {
      if (ticker) clearInterval(ticker);
      ticker = null;
      const line = $("elapsed");
      if (line) line.hidden = true;
    }
    function postTrial(resetsAt) {
      $("trial-state").textContent = trialUsedText(resetsAt);
      show("trial-state", true);
      show("pg-form", false);
    }

    onAuth(async (u) => {
      ["need-login", "trial-state", "consent", "pg-form", "feedback"].forEach((id) => show(id, false));
      if (u === undefined || pg.dataset.live !== "true") return;
      if (!u) return show("need-login", true);
      status.textContent = "Memeriksa status akun…";
      const r = await api("/api/v1/me");
      status.textContent = "";
      if (!r.ok) { status.textContent = errorText(r); return; }
      admin = !!r.body.admin;
      show("feedback", true);
      if (trial && !admin) {
        const s = r.body.trials[slug];
        if (s === "CONSUMED") return postTrial(r.body.trial_resets_at && r.body.trial_resets_at[slug]);
        $("trial-state").textContent = s === "RESERVED"
          ? "Permintaan uji coba Anda sedang diproses."
          : `Uji coba gratis tersedia: 1 kali pemrosesan yang berhasil, lalu kembali setelah ${cfg.trialDays} hari.`;
        show("trial-state", true);
      } else if (trial && admin) {
        $("trial-state").textContent = "Akun admin: kuota uji coba tidak berlaku. Batas permintaan per menit tetap berjalan.";
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

    function currentMode() {
      const picked = form.querySelector('input[name="mode"]:checked');
      return picked ? picked.value : "create";
    }
    function sendMode() {
      const mode = currentMode();
      const transparent = $("as-transparent");
      return mode === "edit" && transparent && transparent.checked ? "transparent" : mode;
    }
    function syncMode() {
      if (!generate) return;
      const mode = currentMode();
      const editing = mode === "edit";
      show("source-field", editing);
      file.required = editing;
      const hint = $("prompt-hint");
      if (hint) {
        hint.textContent = editing
          ? "Tulis prompt Anda untuk mengubah gambar yang diunggah."
          : "Tulis prompt Anda. Gambar baru dibuat dari teks ini.";
      }
      const outgoing = sendMode();
      $("submit").textContent = outgoing === "transparent" ? "Buat latar transparan" : (submitLabel[mode] || "Buat gambar");
    }
    if (generate) {
      form.querySelectorAll('input[name="mode"]').forEach((el) => el.addEventListener("change", syncMode));
      const transparent = $("as-transparent");
      if (transparent) transparent.addEventListener("change", syncMode);
      const useExample = $("use-example");
      if (useExample) useExample.addEventListener("click", () => {
        const sample = $("example-prompt");
        $("prompt").value = sample.textContent.trim();
        $("prompt").focus();
        status.textContent = "Contoh prompt dimasukkan. Anda bisa mengubahnya sebelum memproses.";
      });
      const aspect = $("aspect");
      function syncAspect() {
        if (!aspect) return;
        const [width, height] = aspect.value.split("x");
        $("width").value = width;
        $("height").value = height;
      }
      if (aspect) aspect.addEventListener("change", syncAspect);
      syncAspect();
      syncMode();
    }

    if (file) file.addEventListener("change", () => {
      const f = file.files[0];
      if (preview) preview.hidden = true;
      status.textContent = "";
      if (!f) return;
      if (!["image/jpeg", "image/png"].includes(f.type)) { status.textContent = MSG.INVALID_FILE; file.value = ""; return; }
      if (f.size > maxBytes) { status.textContent = MSG.FILE_TOO_LARGE; file.value = ""; return; }
      if (preview) {
        preview.src = URL.createObjectURL(f);
        preview.hidden = false;
      }
      status.textContent = `File dipilih: ${f.name}`;
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const mode = generate ? sendMode() : "";
      if (generate && mode !== "create" && !file.files[0]) {
        status.textContent = "Unggah gambar yang ingin diubah, lalu tulis prompt-nya.";
        return;
      }
      if (!generate && !file.files[0]) return;
      const btn = $("submit");
      btn.disabled = true;
      show("result", false);
      status.textContent = generate
        ? "Menggambar… Permintaan sedang diproses."
        : "Mengunggah dan memproses… Permintaan sedang diproses.";
      const begun = startClock();
      if (generate && $("aspect")) {
        const [width, height] = $("aspect").value.split("x");
        $("width").value = width;
        $("height").value = height;
      }
      const fd = generate ? new FormData(form) : new FormData();
      if (generate) {
        fd.set("mode", mode);
        if (mode === "create") fd.delete("file");
      }
      if (!generate) fd.append("file", file.files[0]);
      let r;
      try {
        r = await api(`/api/v1/playground/${slug}`, { method: "POST", body: fd });
      } finally {
        stopClock();
        btn.disabled = false;
      }
      const took = " Waktu proses " + clockText(Date.now() - begun) + ".";
      lastRid = r.body.request_id || null;
      if (!r.ok) {
        status.textContent = errorText(r) + took;
        if (!admin && r.body.error && r.body.error.code === "TRIAL_ALREADY_USED") postTrial(r.body.resets_at);
        if (r.status === 401) show("need-login", true);
        return;
      }
      const data = r.body.data || {};
      status.textContent = (generate && !safeImage(data.image)
        ? "Selesai. Respons tidak berisi gambar yang dapat ditampilkan."
        : "Selesai.") + took;
      renderResult(data);
      if (trial && !admin) postTrial(Date.now() / 1000 + cfg.trialDays * 86400);
    });

    function renderResult(data) {
      const img = $("result-image");
      lastImage = "";
      if (img) {
        if (safeImage(data.image)) {
          img.src = data.image;
          img.removeAttribute("width");
          img.removeAttribute("height");
          img.classList.toggle("transparent-bg", data.mode === "transparent");
          img.hidden = false;
          lastImage = data.image;
        } else {
          img.removeAttribute("src");
          img.hidden = true;
        }
      }
      const shown = {};
      const kv = $("kv");
      kv.replaceChildren();
      Object.entries(data).forEach(([k, v]) => {
        if (k === "image" || k.startsWith("_")) return;
        shown[k] = v;
        const tr = kv.insertRow(), th = document.createElement("th");
        th.textContent = k;
        tr.append(th);
        tr.insertCell().textContent = typeof v === "object" ? JSON.stringify(v) : String(v);
      });
      if (!kv.rows.length) kv.insertRow().insertCell().textContent = "Tidak ada field yang dapat ditampilkan; lihat JSON mentah.";
      lastJson = JSON.stringify(shown, null, 2);
      $("raw").textContent = lastJson;  // textContent: model output is never rendered as HTML
      show("result", true);
      show("result-empty", false);
    }

    $("copy").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(lastJson); status.textContent = "JSON disalin."; }
      catch (e) { status.textContent = "Gagal menyalin JSON."; }
    });
    $("download").addEventListener("click", () => {
      if (generate && !lastImage) { status.textContent = "Tidak ada gambar untuk diunduh."; return; }
      const a = document.createElement("a");
      if (generate) {
        const ext = lastImage.startsWith("data:image/jpeg") ? "jpg" : lastImage.startsWith("data:image/webp") ? "webp" : "png";
        a.href = lastImage;
        a.download = `${slug}-${lastRid || "result"}.${ext}`;
      } else {
        a.href = URL.createObjectURL(new Blob([lastJson], { type: "application/json" }));
        a.download = `${slug}-${lastRid || "result"}.json`;
      }
      a.click();
      if (a.href.startsWith("blob:")) URL.revokeObjectURL(a.href);
    });
    const notice = $("notice-dialog");
    function showNotice(title, body) {
      $("notice-title").textContent = title;
      $("notice-body").textContent = body;
      if (!notice.open) notice.showModal();
    }
    notice.addEventListener("click", (e) => { if (e.target === notice) notice.close(); });
    $("notice-close").addEventListener("click", () => notice.close());
    $("fb-send").addEventListener("click", async () => {
      const message = $("fb-msg").value.trim();
      if (!message) {
        showNotice("Catatan masih kosong", "Tulis apa yang terjadi, lalu kirim lagi.");
        return;
      }
      const send = $("fb-send");
      send.disabled = true;
      try {
        const r = await api("/api/v1/feedback", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ technology: slug, request_id: lastRid, message, context: navigator.userAgent }) });
        if (r.ok) $("fb-msg").value = "";
        showNotice(r.ok ? "Laporan terkirim" : "Laporan belum terkirim",
          r.ok ? "Terima kasih. Catatan Anda sudah tersimpan." : errorText(r));
      } finally {
        send.disabled = false;
      }
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
      $("acct-admin").hidden = !me.admin;
      $("acct-reports").hidden = !me.admin;
      $("acct-avatar").textContent = name.trim().charAt(0).toUpperCase();
      $("acct-consent").textContent = me.consent ? "Sudah disetujui" : "Belum disetujui";
      document.querySelectorAll("[data-trial-note]").forEach((el) => {
        el.textContent = me.admin
          ? "Kuota uji coba tidak berlaku untuk akun admin"
          : `1x uji coba gratis tiap ${cfg.trialDays} hari`;
      });
      document.querySelectorAll("[data-trial]").forEach((el) => {
        if (me.admin) {
          el.textContent = "Tidak dibatasi";
          el.className = "badge s-available";
          return;
        }
        const state = me.trials[el.dataset.trial];
        if (state === "CONSUMED") {
          const at = me.trial_resets_at && me.trial_resets_at[el.dataset.trial];
          el.textContent = at
            ? "Kembali " + new Date(at * 1000).toLocaleString("id-ID", { dateStyle: "medium" })
            : "Sudah digunakan";
          el.className = "badge s-coming_soon";
          return;
        }
        const [text, cls] = LABEL[state] || ["—", ""];
        el.textContent = text;
        el.className = "badge " + cls;
      });
      document.querySelectorAll("[data-trial-cta]").forEach((a) => {
        if (!a.dataset.trialCta) return;
        const used = !me.admin && me.trials[a.dataset.trialCta] === "CONSUMED";
        a.textContent = used ? "Lihat detail" : "Buka Playground";
      });
      $("acct").hidden = false;
    });
  }

  function initReports() {
    onAuth(async (u) => {
      $("reports-login").hidden = true;
      $("reports-denied").hidden = true;
      $("reports-empty").hidden = true;
      $("reports").hidden = true;
      if (u === undefined) return;
      if (!u) { $("reports-status").textContent = ""; $("reports-login").hidden = false; return; }
      $("reports-status").textContent = "Memuat…";
      const r = await api("/api/v1/admin/feedback");
      $("reports-status").textContent = "";
      if (r.status === 401) { $("reports-login").hidden = false; return; }
      if (!r.ok) {
        if (r.body.error && r.body.error.code === "FORBIDDEN") $("reports-denied").hidden = false;
        else $("reports-status").textContent = errorText(r);
        return;
      }
      const items = r.body.items || [];
      if (!items.length) { $("reports-empty").hidden = false; return; }
      const body = $("reports-body");
      body.replaceChildren();
      items.forEach((item) => {
        const tr = body.insertRow();
        const when = document.createElement("time");
        const date = new Date(item.created_at * 1000);
        when.dateTime = date.toISOString();
        when.textContent = date.toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" });
        tr.insertCell().append(when);
        const who = tr.insertCell();
        who.className = "report-who";
        const email = item.email || "";
        const name = item.display_name || "";
        who.append(email || name || "Pengguna tanpa email");
        if (name && email && name !== email) {
          const sub = document.createElement("span");
          sub.textContent = name;
          who.append(sub);
        }
        tr.insertCell().textContent = item.technology_id || "";
        tr.insertCell().textContent = item.request_id || "Tidak ada";
        const note = tr.insertCell();
        note.className = "report-note";
        note.textContent = item.message || "";
      });
      if (r.body.truncated) {
        $("reports-note").hidden = false;
        $("reports-note").textContent = "Hanya " + r.body.limit + " laporan terbaru yang ditampilkan.";
      }
      $("reports").hidden = false;
    });
  }

  window.LUTUNG = { initCatalog, initPlayground, initAccount, initReports };
})();
