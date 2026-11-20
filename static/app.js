"use strict";
/* Termosifoni — interfaccia. Il Cube numera i giorni da sabato (0); qui li mostriamo da lunedì. */

const WEEK = [["Lun", 2], ["Mar", 3], ["Mer", 4], ["Gio", 5], ["Ven", 6], ["Sab", 0], ["Dom", 1]];
const DAYNAME = { 0: "sabato", 1: "domenica", 2: "lunedì", 3: "martedì", 4: "mercoledì", 5: "giovedì", 6: "venerdì" };
const MODE_TEXT = { auto: "segue il programma", manuale: "manuale", boost: "boost", vacanza: "vacanza" };
const BOOST_MIN = [0, 5, 10, 15, 20, 25, 30, 60];
const MAXPTS = 13;

let snap = null;              // risposta di /api/state
let ui = { editDay: null, slots: [], pending: {} };

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const n1 = v => v.toFixed(1).replace(".", ",");
const deg = v => v == null ? "—" : v <= 4.5 ? "Spento" : v >= 30.5 ? "Massimo" : n1(v) + "°";
const toMin = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const hhmm = m => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
const cubeToday = () => (new Date().getDay() + 1) % 7;
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };

/* ---------- scala termica: 15° blu ghiaccio → 23° brace */
// interpolazione in HSL: la tonalità scorre pulita senza passare per toni fangosi
const STOPS = [[15, 218, 62, 52], [17, 198, 60, 44], [18.5, 178, 46, 38], [19, 44, 66, 48], [20, 28, 76, 52], [21.5, 12, 72, 50], [23, 352, 64, 46]];
function thermal(t) {
  if (t == null || t <= 4.5) return "#7a8699";
  const hsl = s => `hsl(${s[1]} ${s[2]}% ${s[3]}%)`;
  if (t <= STOPS[0][0]) return hsl(STOPS[0]);
  for (let i = 0; i < STOPS.length - 1; i++) {
    const a = STOPS[i], b = STOPS[i + 1];
    if (t <= b[0]) {
      const f = (t - a[0]) / (b[0] - a[0]);
      let hb = b[1]; if (hb - a[1] > 180) hb -= 360;       // percorso breve sul cerchio
      return hsl([0, ((a[1] + (hb - a[1]) * f) + 360) % 360, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f]);
    }
  }
  return hsl(STOPS[STOPS.length - 1]);
}

function ago(ts) {
  const s = Date.now() / 1000 - ts;
  if (s < 90) return "adesso";
  if (s < 3600) return `${Math.round(s / 60)} min fa`;
  if (s < 86400) return `${Math.round(s / 3600)} h fa`;
  return `${Math.round(s / 86400)} giorni fa`;
}

/* prossimo cambio di programma a partire da adesso */
function nextChange(program) {
  if (!program) return null;
  let day = cubeToday(), t = nowMin();
  for (let k = 0; k < 8; k++) {
    const pts = program[day];
    for (let i = 0; i < pts.length; i++) {
      const end = toMin(pts[i].until);
      if (end > t && end < 1440) return { at: hhmm(end), temp: pts[i + 1].temp, tomorrow: k > 0 };
    }
    day = (day + 1) % 7; t = -1;
    if (k === 0) continue;
  }
  return null;
}

/* ---------- rete */
async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Errore ${r.status}`);
  return j;
}

async function loadState(force) {
  const btn = $("#refresh");
  if (force) btn.classList.add("spin");
  try {
    snap = force ? await api("/api/refresh", {}) : await api("/api/state");
    if (!snap.state && !snap.error) { setTimeout(loadState, 1500); }
  } catch (e) {
    snap = { ...(snap || {}), error: e.message };
  } finally { btn.classList.remove("spin"); }
  renderStatus(); render();
}


function toast(msg, bad) {
  const t = $("#toast");
  t.textContent = msg; t.className = "show" + (bad ? " bad" : "");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.className = bad ? "bad" : "", bad ? 6000 : 3200);
}

function confirmDialog(title, html, yes = "Invia al Cube") {
  const d = $("#confirm");
  $("#confirm-title").textContent = title; $("#confirm-body").innerHTML = html; $("#confirm-yes").textContent = yes;
  d.showModal();
  return new Promise(res => d.addEventListener("close", () => res(d.returnValue === "yes"), { once: true }));
}

async function send(path, body, okText) {
  try {
    const r = await api(path, body);
    toast(r.total === 0 ? "Già così: niente da inviare" : `${okText} (${r.sent} ${r.sent === 1 ? "messaggio" : "messaggi"} radio)`);
    setTimeout(() => loadState(true), 3500);
    return true;
  } catch (e) { toast(e.message, true); return false; }
}

/* ---------- intestazione */
function renderStatus() {
  const st = snap?.state;
  const txt = $("#status-text");
  if (snap?.error && !st) txt.textContent = "Cube non raggiungibile";
  else if (st) txt.textContent = (snap.error ? "Ultima lettura " : "Aggiornato ") +
    new Date(snap.updated * 1000).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
  $("#cube-dot").className = "dot " + (snap?.error ? "bad" : st ? "ok" : "");
  const route = location.hash.match(/^#\/stanza\/(\d+)/);
  $("#nav").innerHTML = (st?.rooms || []).map(r =>
    `<a href="#/stanza/${r.id}" ${route && +route[1] === r.id ? 'aria-current="page"' : ""}>${esc(r.name)}</a>`).join("");
}

/* ---------- router */
function render() {
  const m = location.hash.match(/^#\/stanza\/(\d+)/);
  const view = $("#view");
  if (!snap?.state) {
    view.innerHTML = snap?.error
      ? `<div class="error-box"><h2 style="margin:0 0 6px">Il Cube non risponde</h2><p class="muted" style="margin:0">${esc(snap.error)}. Controlla che sia acceso e collegato al router. Se ha cambiato indirizzo, cercalo in rete.</p>
          <div class="row"><button class="btn primary" data-open-cube>Cerca il Cube in rete</button></div></div>`
      : `<div class="tiles">${'<div class="skeleton"></div>'.repeat(4)}</div>`;
    return;
  }
  if (m) renderRoom(+m[1]); else renderHome();
}
window.addEventListener("hashchange", () => { ui.editDay = null; renderStatus(); render(); window.scrollTo(0, 0); });

/* ================================================================ HOME */
function renderHome() {
  const rooms = snap.state.rooms;
  const known = rooms.filter(r => r.measured != null);
  const avg = known.length ? known.reduce((a, r) => a + r.measured, 0) / known.length : null;
  const heating = rooms.filter(r => r.heating);
  const alerts = rooms.flatMap(r => r.alerts.map(a => ({ ...a, room: r.name })));

  let summary = avg != null ? `Media in casa ${n1(avg)}°. ` : "";
  summary += heating.length ? `Stanno scaldando: ${heating.map(r => `${r.name} (valvola ${r.valve}%)`).join(", ")}.`
    : "Nessun termosifone sta scaldando in questo momento.";

  $("#view").innerHTML = `
    <section class="home-head">
      <div><h1>Casa</h1><p>${esc(summary)}</p></div>
      <div class="house-actions">
        <button class="btn" data-house="auto">Tutto in programma</button>
        <button class="btn" data-house="eco">Tutto in eco</button>
        <button class="btn" data-house="vacanza">Vacanza…</button>
      </div>
    </section>
    ${alerts.length ? `<ul class="alerts">${alerts.map(a =>
      `<li class="${a.kind}"><span><b>${esc(a.text)}</b>: ${esc(a.device)}, ${esc(a.room)}</span></li>`).join("")}</ul>` : ""}
    <section class="tiles">${rooms.map(tileHTML).join("")}</section>`;
}

function tileHTML(r) {
  const nc = r.mode === "auto" ? nextChange(r.program) : null;
  const fromValve = r.measured_ts && Date.now() / 1000 - r.measured_ts > 300;
  return `<a class="tile" href="#/stanza/${r.id}" style="--t:${thermal(r.measured ?? r.setpoint)}">
    ${r.heating ? `<span class="heat">${flame()}Scalda ${r.valve}%</span>` : ""}
    <h2>${esc(r.name)}${r.alerts.length ? '<span class="flag" title="Ci sono avvisi"></span>' : ""}</h2>
    ${r.measured != null
      ? `<div class="reading">${n1(r.measured)}<small>°</small></div>`
      : `<div class="reading unknown">—</div>`}
    <p class="line">Obiettivo ${deg(r.setpoint)}, ${MODE_TEXT[r.mode] || "—"}</p>
    ${nc ? `<p class="line">${nc.tomorrow ? "Domani alle" : "Alle"} ${nc.at} passa a ${deg(nc.temp)}</p>` : ""}
    <p class="age">${r.measured == null ? "Nessuna misura: le valvole la inviano solo ogni tanto"
      : fromValve ? `Misurata dalla valvola ${ago(r.measured_ts)}` : `Misurata da ${esc(r.measured_by)}`}</p>
  </a>`;
}

const flame = () => `<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2s5 5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5 0 2 1 3 2 3 0-3 1-6 1-8.5z"/></svg>`;


document.addEventListener("click", async e => {
  const h = e.target.closest("[data-house]");
  if (!h) return;
  const rooms = snap.state.rooms, kind = h.dataset.house;
  if (kind === "auto") {
    if (await confirmDialog("Tutto in programma?", "<p>Tutte le stanze tornano a seguire il proprio programma settimanale.</p>", "Conferma"))
      send("/api/mode", { room: "all", mode: "auto" }, "Tutte le stanze seguono il programma");
  } else if (kind === "eco") {
    const eco = rooms.find(r => r.config)?.config.eco ?? 17;
    if (await confirmDialog("Tutto in eco?", `<p>Tutte le stanze passano in manuale a ${deg(eco)} finché non le rimetti in programma.</p>`, "Conferma"))
      send("/api/mode", { room: "all", mode: "manuale", temp: eco }, `Tutte le stanze a ${deg(eco)}`);
  } else {
    const def = new Date(Date.now() + 7 * 86400000); def.setHours(18, 0, 0, 0);
    const ok = await confirmDialog("Vacanza", `<p>Tutte le stanze restano alla temperatura scelta fino al rientro, poi riprendono il programma.</p>
      <div class="row"><label class="f">Rientro<input type="datetime-local" id="vac-until" step="1800" value="${isoLocal(def)}"></label>
      <label class="f">Temperatura<select id="vac-temp">${tempOptions(15)}</select></label></div>`, "Imposta vacanza");
    if (ok) send("/api/mode", { room: "all", mode: "vacanza", temp: +$("#vac-temp").value, until: roundHalf($("#vac-until").value) }, "Vacanza impostata");
  }
});

/* ================================================================ STANZA */
function renderRoom(id) {
  const r = snap.state.rooms.find(x => x.id === id);
  if (!r) { location.hash = "#/"; return; }
  const p = ui.pending[id] ?? r.setpoint ?? 20;
  const nc = nextChange(r.program);
  const cfg = r.config || {};
  const fromValve = r.measured_ts && Date.now() / 1000 - r.measured_ts > 300;

  $("#view").innerHTML = `
  <div class="room-grid">
    <div class="hero">
      <div class="tile" style="--t:${thermal(r.measured ?? r.setpoint)}">
        ${r.heating ? `<span class="heat">${flame()}Scalda ${r.valve}%</span>` : ""}
        <h1>${esc(r.name)}</h1>
        ${r.measured != null ? `<div class="reading">${n1(r.measured)}<small>°</small></div>` : `<div class="reading unknown">—</div>`}
        <p class="age">${r.measured == null ? "Nessuna misura disponibile" : fromValve ? `Misurata dalla valvola ${ago(r.measured_ts)}` : `Misurata da ${esc(r.measured_by)}`}</p>
        <p class="sub" style="margin-top:14px">Obiettivo attuale ${deg(r.setpoint)}, ${MODE_TEXT[r.mode] || "—"}</p>
        <div class="stepper" role="group" aria-label="Nuova temperatura">
          <button data-step="-0.5" aria-label="Mezzo grado in meno">−</button>
          <div class="val" id="pending">${deg(p)}</div>
          <button data-step="0.5" aria-label="Mezzo grado in più">+</button>
        </div>
        <div class="hold">
          ${cfg.comfort ? `<button data-preset="${cfg.comfort}">Comfort ${deg(cfg.comfort)}</button>` : ""}
          ${cfg.eco ? `<button data-preset="${cfg.eco}">Eco ${deg(cfg.eco)}</button>` : ""}
        </div>
        <div class="hold">
          ${nc ? `<button class="solid" data-apply="until">Applica fino alle ${nc.at}</button>` : ""}
          <button class="${nc ? "" : "solid"}" data-apply="manual">Applica sempre</button>
        </div>
      </div>

      <div class="panel" style="margin-top:18px">
        <h2>Modalità</h2>
        <div class="modes">
          <button data-mode="auto" aria-pressed="${r.mode === "auto"}">Programma<span>orari settimanali</span></button>
          <button data-mode="manuale" aria-pressed="${r.mode === "manuale"}">Manuale<span>fissa a ${deg(p)}</span></button>
          <button data-mode="boost" aria-pressed="${r.mode === "boost"}">Boost<span>${cfg.boost_minutes ?? 5} min al ${cfg.boost_valve ?? 80}%</span></button>
          <button data-mode="vacanza" aria-pressed="${r.mode === "vacanza"}">Vacanza<span>fino a una data</span></button>
        </div>
        <div class="vacation" id="vacation">
          <label class="f">Fino a<input type="datetime-local" id="r-vac-until" step="1800" value="${isoLocal(new Date(Date.now() + 3 * 86400000))}"></label>
          <label class="f">Temperatura<select id="r-vac-temp">${tempOptions(cfg.eco ?? 17)}</select></label>
          <button class="btn primary" id="r-vac-go">Imposta</button>
        </div>
      </div>

      <div class="panel">
        <h2>Dispositivi</h2>
        <ul class="devices">${r.devices.map(deviceHTML).join("")}</ul>
      </div>
    </div>

    <div>
      <section class="panel">
        <h2>Programma settimanale</h2>
        <p class="lead">${r.program_mismatch ? "<b>I dispositivi della stanza hanno programmi diversi.</b> Qui vedi quello della prima valvola; salvando un giorno lo allinei su tutti. " : ""}Scegli un giorno per cambiarne gli orari.</p>
        <div class="week" id="week">${weekHTML(r)}</div>
        <div class="editor ${ui.editDay != null ? "open" : ""}" id="editor"></div>
      </section>

      ${r.config ? settingsHTML(r) : ""}
    </div>
  </div>`;

  if (ui.editDay != null) renderEditor(r);
}

function deviceHTML(d) {
  const tags = [];
  if (d.battery_low) tags.push('<span class="tag warn">batteria scarica</span>');
  if (d.link_error) tags.push('<span class="tag err">non raggiungibile</span>');
  else if (d.error) tags.push('<span class="tag err">comando non confermato</span>');
  const val = d.actual != null ? `${n1(d.actual)}°<small>misurati</small>` : d.valve != null && d.type !== 3 ? `${d.valve}%<small>valvola</small>` : "";
  return `<li><span class="d-name">${esc(d.name)}${tags.join("")}</span>
    <span class="d-meta">${esc(d.type_name)}, obiettivo ${deg(d.setpoint)}, ${esc(d.mode || "—")}</span>
    <span class="d-val">${val}</span></li>`;
}


/* ---------- programma */
function weekHTML(r) {
  if (!r.program) return `<div></div><p class="hint">Nessun termostato in questa stanza.</p>`;
  const today = cubeToday(), pos = nowMin() / 1440 * 100;
  return WEEK.map(([lbl, i]) => `<div class="d ${i === today ? "today" : ""}">${lbl}</div>
    <button class="bar ${ui.editDay === i ? "sel" : ""}" data-day="${i}" aria-label="Modifica ${DAYNAME[i]}">${barSegs(r.program[i])}${i === today ? `<span class="now" style="left:${pos}%"></span>` : ""}</button>`).join("")
    + `<div class="axis">${[0, 3, 6, 9, 12, 15, 18, 21, 24].map(h => `<span>${h}</span>`).join("")}</div>`;
}
function barSegs(pts) {
  let s = 0;
  return pts.map(p => {
    const e = toMin(p.until), w = (e - s) / 14.4, from = s; s = e;
    return `<span class="s" style="width:${w}%;background:${thermal(p.temp)}" title="${hhmm(from)}–${p.until}: ${deg(p.temp)}">${w > 8 ? deg(p.temp) : ""}</span>`;
  }).join("");
}

function tempOptions(sel) {
  let o = "";
  for (let v = 4.5; v <= 30.5; v += .5) o += `<option value="${v}" ${v === sel ? "selected" : ""}>${deg(v)}</option>`;
  return o;
}

function renderEditor(r) {
  const ed = $("#editor");
  let from = "00:00";
  ed.innerHTML = `
    <h2 style="font-size:17px">${DAYNAME[ui.editDay][0].toUpperCase() + DAYNAME[ui.editDay].slice(1)}</h2>
    <div class="slots">${ui.slots.map((s, k) => {
      const last = k === ui.slots.length - 1;
      const row = `<div class="slot">
        <span class="from">${from}</span><span class="muted">→</span>
        ${last ? `<span class="from">24:00</span>` : `<input type="time" step="300" value="${s.until}" data-k="${k}" aria-label="Fine fascia">`}
        <select data-k="${k}" aria-label="Temperatura" style="border-left:6px solid ${thermal(s.temp)}">${tempOptions(s.temp)}</select>
        ${ui.slots.length > 1 ? `<button class="x" data-del="${k}" aria-label="Rimuovi fascia">✕</button>` : "<span></span>"}
      </div>`; from = s.until; return row;
    }).join("")}</div>
    <div class="row">
      <button class="btn small" id="add-slot" ${ui.slots.length >= MAXPTS ? "disabled" : ""}>Aggiungi fascia</button>
      <label class="hint">Copia da
        <select id="copy-from"><option value="">—</option>${WEEK.map(([l, i]) => `<option value="${i}">${DAYNAME[i]}</option>`).join("")}</select></label>
      <span class="hint">${ui.slots.length} di ${MAXPTS} fasce</span>
    </div>
    <p class="hint" style="margin:16px 0 0">Salva su questi giorni</p>
    <div class="days">${WEEK.map(([l, i]) => `<label><input type="checkbox" value="${i}" ${i === ui.editDay ? "checked" : ""}>${l}</label>`).join("")}</div>
    <div class="row" style="margin-top:4px">
      <button class="btn small" data-pick="2,3,4,5,6">Lun–Ven</button>
      <button class="btn small" data-pick="0,1">Sab–Dom</button>
      <button class="btn small" data-pick="0,1,2,3,4,5,6">Tutti</button>
    </div>
    <div class="row">
      <button class="btn primary" id="save-prog">Salva programma…</button>
      <button class="btn" id="close-ed">Chiudi</button>
      <span class="err-text" id="ed-err"></span>
    </div>`;
}

function slotProblem() {
  let prev = 0;
  for (const s of ui.slots) { const m = toMin(s.until); if (m % 5) return "Gli orari vanno a passi di 5 minuti."; if (m <= prev) return "Ogni fascia deve finire dopo la precedente."; prev = m; }
  return null;
}

/* ---------- impostazioni */
function settingsHTML(r) {
  const c = r.config;
  const sel = (id, opts, v) => `<select id="${id}">${opts.map(([val, lbl]) => `<option value="${val}" ${String(val) === String(v) ? "selected" : ""}>${lbl}</option>`).join("")}</select>`;
  const temps = []; for (let v = 4.5; v <= 30.5; v += .5) temps.push([v, deg(v)]);
  const range = (a, b, s, f) => { const o = []; for (let v = a; v <= b; v += s) o.push([v, f(v)]); return o; };
  return `<section class="panel">
    <h2>Impostazioni della stanza</h2>
    <p class="lead">Valgono per tutti i dispositivi della stanza. La massima limita anche i comandi manuali: adesso è ${deg(c.max)}.</p>
    <div class="settings">
      <h3>Temperature</h3>
      <label class="f">Comfort${sel("s-comfort", temps, c.comfort)}</label>
      <label class="f">Eco${sel("s-eco", temps, c.eco)}</label>
      <label class="f">Massima${sel("s-max", temps, c.max)}</label>
      <label class="f">Minima${sel("s-min", temps, c.min)}</label>
      <h3>Finestra aperta</h3>
      <label class="f">Temperatura${sel("s-wtemp", temps, c.window_temp)}</label>
      <label class="f">Per quanto${sel("s-wmin", range(0, 60, 5, v => v ? v + " min" : "disattivato"), c.window_minutes ?? 15)}</label>
      <h3>Boost e manutenzione</h3>
      <label class="f">Durata boost${sel("s-bmin", BOOST_MIN.map(v => [v, v ? v + " min" : "spento"]), c.boost_minutes ?? 5)}</label>
      <label class="f">Apertura valvola${sel("s-bvalve", range(0, 100, 5, v => v + "%"), c.boost_valve ?? 80)}</label>
      <label class="f">Anticalcare, giorno${sel("s-dday", WEEK.map(([l, i]) => [i, DAYNAME[i]]), c.decalc_day ?? 0)}</label>
      <label class="f">Anticalcare, ora${sel("s-dhour", range(0, 23, 1, v => hhmm(v * 60)), c.decalc_hour ?? 12)}</label>
    </div>
    <div class="row"><button class="btn primary" id="save-cfg">Salva impostazioni…</button><span class="err-text" id="cfg-err"></span></div>
  </section>`;
}

/* ---------- eventi della pagina stanza */
const currentRoom = () => { const m = location.hash.match(/^#\/stanza\/(\d+)/); return m && snap?.state?.rooms.find(r => r.id === +m[1]); };

document.addEventListener("click", async e => {
  const r = currentRoom();
  if (!r) return;
  const t = e.target;
  const step = t.closest("[data-step]"), preset = t.closest("[data-preset]"), apply = t.closest("[data-apply]");
  if (step || preset) {
    let v = preset ? +preset.dataset.preset : (ui.pending[r.id] ?? r.setpoint ?? 20) + +step.dataset.step;
    v = Math.max(4.5, Math.min(30.5, v)); ui.pending[r.id] = v;
    $("#pending").textContent = deg(v);
    $('[data-mode="manuale"] span').textContent = `fissa a ${deg(v)}`;
    return;
  }
  if (apply) {
    const v = ui.pending[r.id] ?? r.setpoint;
    if (apply.dataset.apply === "until")
      send("/api/mode", { room: r.id, mode: "auto", temp: v }, `${r.name}: ${deg(v)} fino al prossimo cambio`);
    else send("/api/mode", { room: r.id, mode: "manuale", temp: v }, `${r.name}: ${deg(v)} in manuale`);
    delete ui.pending[r.id];
    return;
  }
  const mode = t.closest("[data-mode]");
  if (mode) {
    const m = mode.dataset.mode;
    if (m === "vacanza") { $("#vacation").classList.toggle("open"); return; }
    if (m === "auto") send("/api/mode", { room: r.id, mode: "auto" }, `${r.name} segue il programma`);
    if (m === "manuale") send("/api/mode", { room: r.id, mode: "manuale", temp: ui.pending[r.id] ?? r.setpoint }, `${r.name} in manuale`);
    if (m === "boost") send("/api/mode", { room: r.id, mode: "boost" }, `Boost avviato in ${r.name}`);
    return;
  }
  if (t.id === "r-vac-go")
    return send("/api/mode", { room: r.id, mode: "vacanza", temp: +$("#r-vac-temp").value, until: roundHalf($("#r-vac-until").value) }, `${r.name}: vacanza impostata`);
  const bar = t.closest(".bar[data-day]");
  if (bar) {
    ui.editDay = +bar.dataset.day; ui.slots = r.program[ui.editDay].map(p => ({ ...p }));
    $("#week").innerHTML = weekHTML(r); $("#editor").classList.add("open"); renderEditor(r);
    $("#editor").scrollIntoView({ behavior: "smooth", block: "nearest" });
    return;
  }
  const del = t.closest("[data-del]");
  if (del) { const k = +del.dataset.del; if (k === ui.slots.length - 1) ui.slots[k - 1].until = "24:00"; ui.slots.splice(k, 1); renderEditor(r); return; }
  if (t.id === "add-slot") {
    const last = ui.slots[ui.slots.length - 1], prev = ui.slots.length > 1 ? toMin(ui.slots[ui.slots.length - 2].until) : 0;
    let mid = Math.round((prev + 1440) / 2 / 5) * 5; if (mid <= prev) mid = prev + 5;
    last.until = hhmm(mid); ui.slots.push({ until: "24:00", temp: last.temp }); renderEditor(r); return;
  }
  const pick = t.closest("[data-pick]");
  if (pick) { const set = pick.dataset.pick.split(",").map(Number); document.querySelectorAll(".days input").forEach(i => i.checked = set.includes(+i.value)); return; }
  if (t.id === "close-ed") { ui.editDay = null; $("#editor").classList.remove("open"); $("#week").innerHTML = weekHTML(r); return; }
  if (t.id === "save-prog") {
    const err = slotProblem(), days = [...document.querySelectorAll(".days input:checked")].map(i => +i.value);
    $("#ed-err").textContent = err || (days.length ? "" : "Scegli almeno un giorno.");
    if (err || !days.length) return;
    let from = "00:00";
    const ok = await confirmDialog("Salvare il programma?", `<p>${esc(r.name)}, ${days.map(d => DAYNAME[d]).join(", ")}:</p>
      <ul>${ui.slots.map(s => { const li = `<li>${from}–${s.until}: ${deg(s.temp)}</li>`; from = s.until; return li; }).join("")}</ul>
      <p class="hint">Viene scritto su ${r.devices.filter(d => d.program).length} dispositivi; i giorni già uguali vengono saltati.</p>`);
    if (ok && await send("/api/program", { room: r.id, days, points: ui.slots }, "Programma salvato")) {
      days.forEach(d => r.program[d] = ui.slots.map(s => ({ ...s })));
      $("#week").innerHTML = weekHTML(r);
    }
    return;
  }
  if (t.id === "save-cfg") {
    const v = id => +$(id).value;
    const cfg = { comfort: v("#s-comfort"), eco: v("#s-eco"), max: v("#s-max"), min: v("#s-min"), window_temp: v("#s-wtemp"),
      window_minutes: v("#s-wmin"), boost_minutes: v("#s-bmin"), boost_valve: v("#s-bvalve"), decalc_day: v("#s-dday"), decalc_hour: v("#s-dhour") };
    if (cfg.min > cfg.max) { $("#cfg-err").textContent = "La minima non può superare la massima."; return; }
    $("#cfg-err").textContent = "";
    const names = { comfort: "Comfort", eco: "Eco", max: "Massima", min: "Minima", window_temp: "Finestra aperta", window_minutes: "Durata finestra aperta",
      boost_minutes: "Durata boost", boost_valve: "Apertura valvola in boost", decalc_day: "Giorno anticalcare", decalc_hour: "Ora anticalcare" };
    const fmt = (k, x) => ["window_minutes", "boost_minutes"].includes(k) ? x + " min" : k === "boost_valve" ? x + "%" : k === "decalc_day" ? DAYNAME[x] : k === "decalc_hour" ? hhmm(x * 60) : deg(x);
    const changes = Object.keys(cfg).filter(k => r.config[k] !== undefined && r.config[k] !== cfg[k]);
    if (!changes.length) { toast("Nessuna modifica da salvare"); return; }
    if (await confirmDialog("Salvare le impostazioni?", `<p>${esc(r.name)}:</p><ul>${changes.map(k => `<li>${names[k]}: ${fmt(k, r.config[k])} → ${fmt(k, cfg[k])}</li>`).join("")}</ul>`))
      send("/api/config", { room: r.id, config: cfg }, "Impostazioni salvate");
  }
});

document.addEventListener("change", e => {
  const r = currentRoom();
  if (!r || ui.editDay == null) return;
  const t = e.target;
  if (t.id === "copy-from" && t.value !== "") { ui.slots = r.program[+t.value].map(p => ({ ...p })); renderEditor(r); return; }
  if (t.closest(".slot") && t.dataset.k != null) {
    const k = +t.dataset.k;
    if (t.tagName === "SELECT") ui.slots[k].temp = +t.value; else if (t.value) ui.slots[k].until = t.value;
    renderEditor(r);
  }
});

/* ---------- utilità date */
function isoLocal(d) { const p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes() < 30 ? 0 : 30)}`; }
function roundHalf(v) { const [d, t] = v.split("T"); let [h, m] = t.split(":").map(Number); m = m < 15 ? 0 : m < 45 ? 30 : 60; if (m === 60) { h = Math.min(23, h + 1); m = 0; } return `${d}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`; }

/* ---------- installazione come app */
let installEvt = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; $("#install").hidden = false; });
$("#install").addEventListener("click", async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $("#install").hidden = true; });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => { });

$("#refresh").addEventListener("click", () => loadState(true));

/* ---------- Cube: in uso, ricerca in rete, scelta */
function cubeLine(c) {
  return `<b>${esc(c.serial)}</b> <span class="muted">${esc(c.ip)}${c.firmware ? `, firmware ${esc(c.firmware)}` : ""}</span>`;
}
function renderCubeCurrent() {
  const c = snap?.state?.cube;
  $("#cube-current").innerHTML = c
    ? `<span class="dot ${snap.error ? "bad" : "ok"}"></span><div>In uso: ${cubeLine(c)}${snap.error ? `<br><span class="err-text">${esc(snap.error)}</span>` : ""}</div>`
    : `<span class="dot bad"></span><div>Nessun Cube collegato${snap?.error ? `: ${esc(snap.error)}` : ""}.</div>`;
}
function openCube() {
  renderCubeCurrent();
  $("#cube-err").textContent = "";
  $("#cube-dlg").showModal();
}
async function searchCubes() {
  const btn = $("#cube-search"), list = $("#cube-list");
  btn.disabled = true; list.innerHTML = ""; $("#cube-err").textContent = "";
  $("#cube-progress").textContent = "Cerco con il broadcast eQ-3 e controllo ogni indirizzo della rete locale…";
  try {
    const r = await api("/api/discover", {});
    $("#cube-progress").textContent = `${r.cubes.length ? r.cubes.length === 1 ? "Trovato 1 Cube" : `Trovati ${r.cubes.length} Cube` : "Nessun Cube trovato"} in ${String(r.seconds).replace(".", ",")} s su ${r.networks.join(", ")}.`;
    list.innerHTML = r.cubes.map(c => `<li>
      <div>${cubeLine(c)}<br><span class="hint">${c.method === "broadcast" ? "Ha risposto al broadcast" : "Trovato con la scansione della porta 62910"}</span></div>
      ${c.current ? `<span class="tag">In uso</span>` : `<button class="btn small" data-use-cube="${esc(c.ip)}">Usa questo</button>`}</li>`).join("")
      || `<li class="hint">Controlla che il Cube sia acceso, con il LED fisso, e collegato con il cavo allo stesso router del Mac.</li>`;
  } catch (e) { $("#cube-err").textContent = e.message; $("#cube-progress").textContent = ""; }
  finally { btn.disabled = false; }
}
async function useCube(ip) {
  $("#cube-err").textContent = "";
  try {
    snap = await api("/api/cube", { ip });
    Object.keys(ui.pending).forEach(k => delete ui.pending[k]); ui.editDay = null;
    renderStatus(); render(); renderCubeCurrent();
    $("#cube-list").innerHTML = ""; $("#cube-progress").textContent = "";
    toast(`Collegato al Cube ${snap.state.cube.serial} (${ip})`);
  } catch (e) { $("#cube-err").textContent = e.message; }
}
$("#cube-btn").addEventListener("click", openCube);
$("#cube-close").addEventListener("click", () => $("#cube-dlg").close());
$("#cube-search").addEventListener("click", searchCubes);
$("#cube-manual").addEventListener("submit", e => { e.preventDefault(); const ip = $("#cube-ip").value.trim(); if (ip) useCube(ip); });
document.addEventListener("click", e => {
  const u = e.target.closest("[data-use-cube]"); if (u) useCube(u.dataset.useCube);
  if (e.target.closest("[data-open-cube]")) openCube();
});
loadState();
// aggiorna ogni 30 s, ma non mentre stai compilando qualcosa
const busy = () => $("#confirm").open || $("#cube-dlg").open || ui.editDay != null || $(".vacation.open") ||
  ["INPUT", "SELECT"].includes(document.activeElement?.tagName) || Object.keys(ui.pending).length;
setInterval(() => { if (!document.hidden && !busy()) loadState(); }, 30000);
