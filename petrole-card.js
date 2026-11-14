/**
 * petrole-card — « Pétrole »
 *
 * Carte Lovelace du pétrole d'un poêle (combustible liquide en bidons) : bidon en service, pétrole
 * restant estimé, durée moyenne d'un bidon, fin estimée, consommation, coût, réserve et saison de chauffe.
 *
 * Elle lit les événements « Bidon pétrole » d'un calendrier Home Assistant, écrits à chaque nouveau
 * bidon par l'automatisation du tag NFC (créée depuis l'éditeur de la carte, ou packages/petrole.yaml) :
 *   description « 20 L · 32.9 € »
 * Les achats de bidons sont notés « Achat pétrole » par le bouton « + Achat » de la carte :
 *   description « 3 × 35.95 € · Auchan »
 *
 * type: custom:petrole-card
 * calendar: calendar.home
 */

const CARD_VERSION = "0.1.0-beta.4";

/* ------------------------------------------------------------- affichage */

const fmt = (n, digits = 1) =>
  n === null || n === undefined || !Number.isFinite(Number(n))
    ? "—"
    : Number(n).toLocaleString("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits });

const euro = (n) =>
  n === null || n === undefined || !Number.isFinite(Number(n))
    ? "—"
    : Number(n).toLocaleString("fr-FR", { style: "currency", currency: "EUR" });

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const DAY = 86400000;
const dateFr = (d, long = false) => d.toLocaleDateString("fr-FR", long
  ? { day: "numeric", month: "long", year: "numeric" }
  : { day: "numeric", month: "short", year: "numeric" }).replace(".", "");
const plural = (n, one, many) => `${fmt(n, 0)} ${Math.round(n) > 1 ? many : one}`;
/** Nombre de jours lisible : une décimale sous 10 jours, « jour » au singulier sous 2. */
const daysNum = (n) => fmt(n, n < 10 ? 1 : 0);
const daysUnit = (n) => (n < 2 ? "jour" : "jours");
/** Durée d'un bidon : en heures le premier jour (« moins d'1 h », « 5 h »), en jours ensuite. */
const span = (days) => {
  const d = Math.max(0, days);
  if (d >= 1) return { v: daysNum(d), u: daysUnit(d) };
  const h = d * 24;
  return h < 1 ? { v: "< 1", u: "h" } : { v: fmt(h, 0), u: "h" };
};

/** Classe de thème : v2 (bleu nuit), auto (bleu nuit, ou clair si Home Assistant est en mode clair), ha (thème Home Assistant). */
const themeClass = (theme, hass) => {
  const light = hass?.themes?.darkMode === false;
  if (theme === "ha") return `th-ha${light ? " light" : ""}`;
  if (theme === "auto") return `th-v2${light ? " light" : ""}`;
  return "th-v2";
};

/* ---------------------------------------------------------------- calculs */

const PETROLE_DEFAULTS = {
  title: "Pétrole",
  calendar: "calendar.home",
  summary: "Bidon pétrole",
  purchase_summary: "Achat pétrole",
  purchases: 3,
  capacity: 20,
  price: "input_number.petrole_prix_du_bidon",
  stock: "input_number.petrole_bidons_en_reserve",
  label: "",
  average_over: 5,
  season_start: 9,
  history: 5,
  warn_days: 3,
  theme: "v2",
  font_size: 100,
};

const PETROLE = {
  /** Nombre (« 32,9 » accepté), ou null. */
  num(v) {
    if (v === undefined || v === null || v === "") return null;
    const x = Number(String(v).replace(",", ".").replace(/\s/g, ""));
    return Number.isFinite(x) ? x : null;
  },

  /** Valeur d'une option : nombre écrit dans la carte, ou état d'une entité (input_number, sensor). */
  value(hass, v) {
    if (v === undefined || v === null || v === "") return null;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    const s = String(v).trim();
    if (/^[a-z_]+\.[\w-]+$/.test(s)) return PETROLE.num(hass?.states?.[s]?.state);
    return PETROLE.num(s);
  },

  /** Un bidon à partir d'un événement du calendrier (« 20 L · 32.9 € »), ou null s'il n'est pas lisible. */
  parse(ev, summary) {
    if (String(ev.summary || "").trim().toLowerCase() !== String(summary || "").trim().toLowerCase()) return null;
    const start = new Date(ev.start?.dateTime || ev.start?.date || ev.start);
    if (Number.isNaN(start.getTime())) return null;
    const d = String(ev.description || "").replace(/,/g, ".");
    const get = (re) => { const m = re.exec(d); return m ? Number(m[1]) : null; };
    return { start, litres: get(/([\d.]+)\s*L\b/), price: get(/([\d.]+)\s*€/) };
  },

  /** Un achat à partir d'un événement « Achat pétrole » (« 3 × 35.95 € · Auchan »), ou null. */
  parsePurchase(ev, summary) {
    if (String(ev.summary || "").trim().toLowerCase() !== String(summary || "").trim().toLowerCase()) return null;
    const date = new Date(ev.start?.dateTime || ev.start?.date || ev.start);
    if (Number.isNaN(date.getTime())) return null;
    const raw = String(ev.description || "");
    const d = raw.replace(/,/g, ".");
    const qty = Number((/(\d+)\s*[×x*]/i.exec(d) || [])[1] || 1);
    const price = Number((/([\d.]+)\s*€/.exec(d) || [])[1]);
    const parts = raw.split("·");
    const store = parts.length > 1 ? parts[parts.length - 1].trim() : "";
    if (!Number.isFinite(price) || price <= 0 || !(qty > 0)) return null;
    return { date, qty, price, store };
  },

  /** Bidons du plus récent au plus ancien : durée de chaque bidon jusqu'au suivant, le dernier est en service.
   *  Deux bips à moins d'une heure d'écart ne comptent qu'une fois. Chaque bidon prend le prix et le magasin
   *  de son achat, les plus anciens d'abord (un achat noté le jour même du bip compte encore). */
  bidons(events, capacity, price, now, purchases = []) {
    const list = [...events].sort((a, b) => a.start - b.start)
      .filter((b, i, arr) => i === 0 || b.start - arr[i - 1].start > 3600000);
    const lots = [...purchases].sort((a, b) => a.date - b.date).map((p) => ({ ...p, left: p.qty }));
    const lotOf = list.map((b) => {
      const lot = lots.find((l) => l.left > 0 && l.date.getTime() <= b.start.getTime() + DAY);
      if (lot) lot.left -= 1;
      return lot || null;
    });
    return list.map((b, i) => {
      const end = list[i + 1]?.start || null;
      const lot = lotOf[i];
      return {
        ...b,
        litres: b.litres ?? capacity,
        price: lot ? lot.price : b.price ?? price,
        store: lot ? lot.store : "",
        end,
        days: Math.max(0, ((end || now) - b.start) / DAY),
        current: !end,
      };
    }).reverse();
  },

  /** Achats : les plus récents, prix moyen par bidon sur un an et magasin le moins cher (prix moyen par magasin). */
  purchaseStats(purchases, now) {
    const list = [...purchases].sort((a, b) => b.date - a.date);
    const year = list.filter((p) => now - p.date <= 365 * DAY);
    const qty = year.reduce((s, p) => s + p.qty, 0);
    const avg = qty ? year.reduce((s, p) => s + p.qty * p.price, 0) / qty : null;
    const byStore = {};
    for (const p of year) {
      if (!p.store) continue;
      const k = p.store.toLowerCase();
      byStore[k] ||= { store: p.store, qty: 0, cost: 0 };
      byStore[k].qty += p.qty;
      byStore[k].cost += p.qty * p.price;
    }
    const stores = Object.values(byStore).map((x) => ({ ...x, avg: x.cost / x.qty })).sort((a, b) => a.avg - b.avg);
    return { list, avg, best: stores.length > 1 ? stores[0] : null, stores };
  },

  /** Début de la saison de chauffe en cours (1er du mois choisi, septembre par défaut). */
  seasonStart(now, month) {
    const m = Math.min(12, Math.max(1, Number(month) || 9)) - 1;
    const y = now.getMonth() >= m ? now.getFullYear() : now.getFullYear() - 1;
    return new Date(y, m, 1);
  },

  /** Tout ce qu'affiche la carte. */
  stats(bidons, o, now) {
    const current = bidons.find((b) => b.current) || null;
    const done = bidons.filter((b) => !b.current);
    // moyenne sur les derniers bidons terminés : la consommation change avec la saison
    const recent = done.slice(0, Math.max(1, Number(o.average_over) || 5));
    const avg = recent.length ? recent.reduce((s, b) => s + b.days, 0) / recent.length : null;
    const litres = current?.litres ?? o.capacity;
    const price = current?.price ?? o.price;
    const days = current ? current.days : null;
    const pct = avg && current ? Math.max(0, 1 - days / avg) : null;
    const end = avg && current ? new Date(current.start.getTime() + avg * DAY) : null;
    const left = avg && current ? avg - days : null;
    const perDay = avg ? litres / avg : null;
    const perMonth = avg && price !== null ? (price / avg) * 30.44 : null;
    const season = o.seasonStart;
    const inSeason = bidons.filter((b) => b.start >= season);
    const seasonCost = inSeason.reduce((s, b) => s + (b.price || 0), 0);
    const seasonLitres = inSeason.reduce((s, b) => s + (b.litres || 0), 0);
    // réserve : bidons d'avance ; ils durent chacun la durée moyenne, après la fin du bidon en service
    const stock = o.stock;
    const stockEnd = avg && end && stock !== null && stock > 0 ? new Date(end.getTime() + stock * avg * DAY) : null;
    return {
      current, done, recent, avg, litres, price, days, pct, end, left, perDay, perMonth,
      season, seasonCount: inSeason.length, seasonCost, seasonLitres, stock, stockEnd,
    };
  },
};

const JERRICAN_ICON = `<svg viewBox="0 0 32 32" aria-hidden="true"><path class="can" d="M9 7.5h11.5l4 4V27a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V9.5a2 2 0 0 1 2-2z"/><path class="cap" d="M20 3.5h3.5v4H20z"/><path class="band" d="M10 15.5h11v6H10z"/><path class="grip" d="M10.5 7.5V5.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5v2"/></svg>`;

class PetroleCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement("petrole-card-editor");
  }

  static getStubConfig(hass) {
    const cal = Object.keys(hass?.states || {}).find((k) => k.startsWith("calendar."));
    return { calendar: cal || PETROLE_DEFAULTS.calendar };
  }

  setConfig(config) {
    if (!config) throw new Error("Configuration de la carte manquante.");
    this._config = { ...PETROLE_DEFAULTS, ...config };
    this._sig = null;
    this._events = null;
    this._purchases = [];
    this._fetched = 0;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    if (!this._wired) this._wire();
    this._render(true);
  }

  set hass(hass) {
    this._hass = hass;
    this._loadCalendar();
    this._render(false);
  }

  getCardSize() {
    return 6;
  }

  /** Bidons notés au calendrier : relus toutes les heures, ou dès qu'un bip met le calendrier à jour. */
  async _loadCalendar() {
    const c = this._config;
    if (!c?.calendar || !this._hass?.callApi || this._loading) return;
    const cal = this._hass.states?.[c.calendar];
    const key = `${c.calendar}|${cal?.last_changed || ""}|${this._autoChanged()}`;
    if (this._events && this._key === key && Date.now() - this._fetched < 3600000) return;
    this._loading = true;
    try {
      const end = new Date(Date.now() + DAY), start = new Date(end.getTime() - 4 * 365 * DAY);
      const events = await this._hass.callApi("GET", `calendars/${c.calendar}?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`);
      const all = Array.isArray(events) ? events : [];
      this._events = all.map((e) => PETROLE.parse(e, c.summary)).filter(Boolean);
      this._purchases = all.map((e) => PETROLE.parsePurchase(e, c.purchase_summary)).filter(Boolean);
      this._calError = null;
    } catch (err) {
      this._events = [];
      this._calError = String(err?.body?.message || err?.message || err || "erreur");
    }
    this._fetched = Date.now();
    this._key = key;
    this._loading = false;
    this._render(true);
  }

  /** Dernier déclenchement de l'automatisation du tag : un nouveau bip relit le calendrier. */
  _autoChanged() {
    const st = Object.values(this._hass?.states || {}).find((s) => s.entity_id?.startsWith("automation.") && s.attributes?.friendly_name === AUTOMATION_ALIAS);
    return st?.attributes?.last_triggered || "";
  }

  _render(force) {
    if (!this._config || !this._hass || !this.shadowRoot) return;
    const c = this._config, hass = this._hass;
    const ids = [c.price, c.stock, c.capacity].filter((x) => typeof x === "string" && x.includes("."));
    const sig = `${c.theme}|${hass.themes?.darkMode}|${ids.map((id) => hass.states?.[id]?.state ?? "-").join("|")}|${this._fetched}|${Math.floor(Date.now() / 3600000)}`;
    // formulaire d'achat ouvert : pas de redessin pendant la saisie
    if (!force && (sig === this._sig || this._buy)) return;
    this._sig = sig;
    const theme = themeClass(c.theme, hass);
    const fs = Math.min(150, Math.max(70, Number(c.font_size) || 100)) / 100;
    const open = `${STYLE}<ha-card class="${theme}" style="--fs:${fs}">`;
    if (!c.calendar || !hass.states?.[c.calendar]) {
      this.shadowRoot.innerHTML = `${open}${this._header(null)}<div class="empty"><strong>Calendrier introuvable : ${esc(c.calendar || "aucun")}</strong>
        <span>Choisissez dans l'éditeur de la carte le calendrier où chaque nouveau bidon est noté.</span></div></ha-card>`;
      return;
    }
    if (this._events === null) {
      this.shadowRoot.innerHTML = `${open}${this._header(null)}<div class="empty"><span>Lecture du calendrier…</span></div></ha-card>`;
      return;
    }
    const now = new Date();
    const capacity = PETROLE.value(hass, c.capacity) ?? 20;
    const price = PETROLE.value(hass, c.price);
    const stockSt = typeof c.stock === "string" && c.stock.includes(".") ? hass.states?.[c.stock] : null;
    const stock = typeof c.stock === "number" ? c.stock : stockSt ? PETROLE.num(stockSt.state) : null;
    const bidons = PETROLE.bidons(this._events, capacity, price, now, this._purchases);
    const buys = PETROLE.purchaseStats(this._purchases, now);
    this._stock = stock;
    this._lastPrice = buys.list[0]?.price ?? price;
    if (!bidons.length) {
      this.shadowRoot.innerHTML = `${open}${this._header(null)}${this._buyForm()}<div class="empty">
        <strong>Aucun bidon noté pour l'instant</strong>
        <span>Bipez le tag NFC du poêle quand vous entamez un bidon : il est noté « ${esc(c.summary)} » dans
        ${esc(hass.states[c.calendar].attributes?.friendly_name || c.calendar)}. L'installation du tag se fait dans l'éditeur de la carte.</span>
        ${this._calError ? `<span class="err">Calendrier illisible : ${esc(this._calError)}</span>` : ""}</div></ha-card>`;
      return;
    }
    const m = PETROLE.stats(bidons, { capacity, price, stock, average_over: c.average_over, seasonStart: PETROLE.seasonStart(now, c.season_start) }, now);
    m.bidons = bidons;
    m.buys = buys;
    this.shadowRoot.innerHTML = `${open}${this._header(m.current)}${this._buyForm()}${this._hero(m)}${this._tiles(m)}${this._history(m)}${this._purchasesHtml(m)}${this._footer(m)}</ha-card>`;
  }

  _header(current) {
    const c = this._config;
    const sub = [c.label, current ? `bidon entamé le ${dateFr(current.start, true)}` : ""].filter(Boolean).join(" · ");
    return `<header><div class="brand">${JERRICAN_ICON}
      <div><div class="title">${esc(c.title || PETROLE_DEFAULTS.title)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div></div>
      <button type="button" class="buy-btn${this._buy ? " on" : ""}" data-act="buy" aria-expanded="${!!this._buy}">+ Achat</button></header>`;
  }

  _hero(m) {
    const warn = m.left !== null && m.left <= Number(this._config.warn_days || 0);
    const gauge = m.pct !== null
      ? `<div class="gauge${warn ? " low" : ""}"><i style="width:${(m.pct * 100).toFixed(1)}%"></i></div>
         <div class="split-l"><span>≈ ${fmt(m.litres * m.pct, 1)} L restants sur ${fmt(m.litres, 0)} L</span><span>${fmt(m.pct * 100, 0)} %</span></div>`
      : `<div class="split wait">Pétrole restant estimé dès le prochain bidon : il faut un bidon terminé pour connaître sa durée.</div>`;
    return `<section class="hero">
      <div>
        <div class="hero-l">Bidon en service depuis</div>
        <div class="hero-v">${span(m.days).v}<span>${span(m.days).u}</span></div>
        ${m.avg ? (m.days > m.avg
          ? `<div class="evo up">au-delà de la moyenne (${fmt(m.avg, 1)} jours)</div>`
          : `<div class="hero-p">moyenne : ${fmt(m.avg, 1)} jours par bidon</div>`) : ""}
      </div>
      <div class="hero-r">
        ${m.left !== null
          ? (m.left > 0
            ? `<div class="peak${warn ? " low" : ""}">${daysNum(m.left)}<span>${daysUnit(m.left)}</span></div><div class="cost-l">${warn ? "bientôt vide" : "restants environ"}</div>`
            : `<div class="peak low">0<span>jour</span></div><div class="cost-l">bidon sans doute vide</div>`)
          : `<div class="peak">${fmt(m.litres, 0)}<span>L</span></div><div class="cost-l">contenance du bidon</div>`}
      </div>
      <div class="split">${gauge}</div>
    </section>`;
  }

  _tiles(m) {
    const later = "connue au prochain bidon";
    const tile = (label, value, unit, notes, cls = "") => `<div class="tile${cls}">
      <div class="tile-l">${label}</div><div class="tile-v">${value}${unit ? `<span>${unit}</span>` : ""}</div>
      ${notes.filter(Boolean).length ? `<div class="tile-n">${notes.filter(Boolean).join("<br>")}</div>` : ""}</div>`;
    const list = [
      tile("Durée moyenne", m.avg ? fmt(m.avg, 1) : "—", m.avg ? "jours" : "", [m.recent.length ? (m.recent.length > 1 ? `sur les ${m.recent.length} derniers bidons` : "sur le dernier bidon") : later]),
      tile("Fin estimée", m.end ? esc(dateFr(m.end)) : "—", "", [m.end ? (m.left > 0 ? `dans ${daysNum(m.left)} ${daysUnit(m.left)}` : "dépassée : bidon à changer ?") : later]),
      tile("Consommation", m.perDay !== null ? fmt(m.perDay, 2) : "—", m.perDay !== null ? "L/jour" : "", [m.perDay !== null ? `≈ ${fmt(m.perDay * 30.44, 0)} L par mois` : later]),
      m.perMonth !== null
        ? tile("Coût", euro(m.perMonth), "/mois", [`${euro(m.price)} le bidon${m.current?.store ? ` (${esc(m.current.store)})` : ""}`, `soit ${euro(m.price / m.litres)} le litre`])
        : tile("Bidon", m.price !== null ? euro(m.price) : "—", "", [m.price !== null ? "coût par mois connu au prochain bidon" : "prix non renseigné"]),
    ];
    if (m.stock !== null) {
      list.push(tile("Réserve", fmt(m.stock, 0), Math.round(m.stock) > 1 ? "bidons" : "bidon",
        [m.stock <= 0 ? "plus de bidon d'avance" : m.stockEnd ? `jusqu'au ${esc(dateFr(m.stockEnd))} environ` : "durée connue au prochain bidon"],
        m.stock <= 1 ? " low" : ""));
    }
    list.push(tile("Cette saison", euro(m.seasonCost), "", [`${plural(m.seasonCount, "bidon", "bidons")} · ${fmt(m.seasonLitres, 0)} L`, `depuis le ${esc(dateFr(m.season))}`]));
    return `<section class="tiles${list.length > 4 ? " six" : ""}">${list.join("")}</section>`;
  }

  _history(m) {
    const n = Math.max(1, Number(this._config.history) || 5);
    const rows = m.bidons.slice(0, n).map((b) => `<div class="row">
      <span>${esc(dateFr(b.start))} → ${b.current ? "en service" : esc(dateFr(b.end))}${b.price !== null ? ` · ${euro(b.price)}` : ""}${b.store ? ` · ${esc(b.store)}` : ""}</span>
      <b class="${b.current ? "now" : ""}">${b.days < 1 ? `${span(b.days).v} h` : `${fmt(b.days, b.days < 10 ? 1 : 0)} j`}</b></div>`).join("");
    return `<section class="rows"><div class="rows-h">Derniers bidons</div>${rows}${this._calError ? `<div class="err">Calendrier illisible : ${esc(this._calError)}</div>` : ""}</section>`;
  }

  _purchasesHtml(m) {
    const b = m.buys;
    if (!b.list.length) return "";
    const n = Math.max(1, Number(this._config.purchases) || 3);
    const rows = b.list.slice(0, n).map((p) => `<div class="row">
      <span>${esc(dateFr(p.date))}${p.store ? ` · ${esc(p.store)}` : ""}</span><b>${p.qty} × ${euro(p.price)}</b></div>`).join("");
    const sum = [
      b.avg !== null ? `prix moyen ${euro(b.avg)} le bidon sur un an` : "",
      b.best ? `le moins cher : ${esc(b.best.store)} (${euro(b.best.avg)} en moyenne)` : "",
    ].filter(Boolean).join(" · ");
    return `<section class="rows"><div class="rows-h">Derniers achats</div>${rows}${sum ? `<div class="rows-n">${sum}</div>` : ""}</section>`;
  }

  /** Formulaire « + Achat » : bidons achetés, prix par bidon, magasin, date, et réserve après l'achat. */
  _buyForm() {
    const v = this._buy;
    if (!v) return "";
    const stores = [...new Set((this._purchases || []).slice().sort((a, b) => b.date - a.date).map((p) => p.store).filter(Boolean))];
    const stock = this._stockEntity();
    return `<form class="buy">
      <div class="buy-g">
        <label>Bidons achetés<input name="qty" type="number" min="1" max="50" step="1" inputmode="numeric" value="${esc(v.qty)}" required></label>
        <label>Prix par bidon (€)<input name="price" type="text" inputmode="decimal" value="${esc(v.price)}" required></label>
        <label>Magasin<input name="store" type="text" list="pt-stores" value="${esc(v.store)}" autocomplete="off"></label>
        <label>Date de l'achat<input name="date" type="date" value="${esc(v.date)}" required></label>
        ${stock ? `<label>Réserve après l'achat<input name="reserve" type="number" min="0" max="100" step="1" value="${esc(v.reserve)}"></label>` : ""}
      </div>
      <datalist id="pt-stores">${stores.map((x) => `<option value="${esc(x)}">`).join("")}</datalist>
      ${stock ? `<p class="buy-n">Réserve : les bidons pleins d'avance, sans compter le bidon en service.</p>` : ""}
      ${v.error ? `<p class="err">${esc(v.error)}</p>` : ""}
      <div class="buy-a"><button type="button" class="ghost" data-act="buy-cancel">Annuler</button><button type="submit"${v.busy ? " disabled" : ""}>Noter l'achat</button></div>
    </form>`;
  }

  /** Entité de la réserve, si c'est un input_number (le formulaire la met à jour). */
  _stockEntity() {
    const s = this._config.stock;
    return typeof s === "string" && s.startsWith("input_number.") && this._hass?.states?.[s] ? s : null;
  }

  /** Clics et saisie, branchés une seule fois (le contenu de la carte est redessiné). */
  _wire() {
    this._wired = true;
    const root = this.shadowRoot;
    root.addEventListener("click", (ev) => {
      const act = ev.target.closest?.("[data-act]")?.dataset.act;
      if (act === "buy") {
        if (this._buy) this._buy = null;
        else {
          const today = new Date(), pad = (n) => String(n).padStart(2, "0");
          const stock = Math.max(0, Math.round(this._stock || 0));
          const last = (this._purchases || []).slice().sort((a, b) => b.date - a.date)[0];
          this._buy = {
            qty: 1, price: this._lastPrice ? String(this._lastPrice).replace(".", ",") : "", store: last?.store || "",
            date: `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`,
            stock, reserve: stock + 1, reserveTouched: false,
          };
        }
        this._render(true);
      } else if (act === "buy-cancel") {
        this._buy = null;
        this._render(true);
      }
    });
    root.addEventListener("input", (ev) => {
      const f = ev.target.closest?.("form.buy");
      if (!f || !this._buy) return;
      const v = this._buy, name = ev.target.name;
      v[name] = ev.target.value;
      if (name === "reserve") v.reserveTouched = true;
      if (name === "qty" && !v.reserveTouched) {
        v.reserve = v.stock + Math.max(0, Math.round(Number(ev.target.value)) || 0);
        const r = f.querySelector("input[name=reserve]");
        if (r) r.value = v.reserve;
      }
    });
    root.addEventListener("submit", (ev) => {
      if (!ev.target.closest?.("form.buy")) return;
      ev.preventDefault();
      this._saveBuy();
    });
  }

  async _saveBuy() {
    const v = this._buy, c = this._config, hass = this._hass;
    if (!v || v.busy) return;
    const qty = Math.round(Number(v.qty));
    const price = PETROLE.num(v.price);
    const store = String(v.store || "").replace(/·/g, "-").trim();
    if (!(qty >= 1) || !(price > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(String(v.date))) {
      v.error = "Indiquez le nombre de bidons, le prix d'un bidon et la date.";
      this._render(true);
      return;
    }
    v.busy = true; v.error = ""; this._render(true);
    try {
      // achat d'aujourd'hui : à l'heure actuelle ; achat d'un autre jour : à midi
      const pad = (n) => String(n).padStart(2, "0");
      const txt = (x) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())} ${pad(x.getHours())}:${pad(x.getMinutes())}:${pad(x.getSeconds())}`;
      const now = new Date();
      const start = txt(now).startsWith(v.date) ? now : new Date(`${v.date}T12:00:00`);
      await hass.callService("calendar", "create_event", {
        entity_id: c.calendar, summary: c.purchase_summary || PETROLE_DEFAULTS.purchase_summary,
        description: `${qty} × ${price} €${store ? ` · ${store}` : ""}`,
        start_date_time: txt(start), end_date_time: txt(new Date(start.getTime() + 60000)),
      });
      const stock = this._stockEntity();
      if (stock && v.reserve !== "" && Number.isFinite(Number(v.reserve))) {
        await hass.callService("input_number", "set_value", { entity_id: stock, value: Math.max(0, Math.round(Number(v.reserve))) });
      }
      // prix du dernier achat : celui que l'automatisation note au prochain bip (la carte reprend celui de l'achat)
      if (typeof c.price === "string" && c.price.startsWith("input_number.") && hass.states?.[c.price]) {
        await hass.callService("input_number", "set_value", { entity_id: c.price, value: price });
      }
      this._buy = null;
      this._key = null;
      this._fetched = 0;
      this._loadCalendar();
    } catch (err) {
      v.busy = false;
      v.error = `Achat non noté : ${err?.message || err}`;
    }
    this._render(true);
  }

  _footer(m) {
    return `<footer>${m.avg ? `Estimations d'après la durée moyenne ${m.recent.length > 1 ? `des ${m.recent.length} derniers bidons` : "du dernier bidon"}` : "Durée comptée depuis le début du bidon"} ; la consommation varie avec le froid et le réglage du poêle.</footer>`;
  }
}

const STYLE_BASE = `<style>
:host {
  --med-bg: #1a2434; --med-surface: #212d40; --med-line: #2f3d55;
  --med-text: #e7edf5; --med-muted: #8fa0b8;
  --med-blue: #1d93e3; --t-red: #ee4a4a;
  --med-up: #f08a4b; --med-down: #5fcf8a;
  --pt-main: #4cc36b; --pt-core: #b6ec5a;
}
ha-card { display: block; background: var(--med-bg); color: var(--med-text); border: 1px solid var(--med-line);
  border-radius: 18px; overflow: hidden; font-variant-numeric: tabular-nums; container-type: inline-size; }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 18px 8px; flex-wrap: wrap; }
.brand { display: flex; align-items: center; gap: 10px; }
.brand svg { width: 34px; height: 34px; flex: none; }
.brand .can { fill: var(--pt-main); } .brand .cap { fill: var(--pt-core); }
.brand .band { fill: var(--med-bg); opacity: .55; }
.brand .grip { fill: none; stroke: var(--pt-main); stroke-width: 2; stroke-linecap: round; }
.title { font-size: 1.15rem; font-weight: 700; letter-spacing: .2px; }
.sub { font-size: .78rem; color: var(--med-muted); }
.hero { margin: 4px 12px 0; padding: 16px; border-radius: 14px; background: var(--med-surface);
  border: 1px solid var(--med-line); display: grid; grid-template-columns: 1fr auto; gap: 6px 16px; }
.hero-l { color: var(--med-muted); font-size: .85rem; }
.hero-v { font-size: 2.4rem; font-weight: 700; line-height: 1.1; }
.hero-v span, .tile-v span, .peak span { font-size: .9rem; font-weight: 500; color: var(--med-muted); margin-left: 4px; }
.hero-r { text-align: right; align-self: center; }
.peak { font-size: 1.6rem; font-weight: 700; color: var(--pt-main); }
.peak.low { color: var(--t-red); }
.hero-p { font-size: .75rem; color: var(--med-muted); margin-top: 6px; }
.cost-l { font-size: .75rem; color: var(--med-muted); max-width: 160px; }
.evo { font-size: .8rem; font-weight: 600; margin-top: 2px; }
.evo.up { color: var(--med-up); }
.split { grid-column: 1 / -1; margin-top: 6px; }
.split.wait { font-size: .8rem; color: var(--med-muted); border-top: 1px dashed var(--med-line); padding-top: 8px; }
.gauge { height: 10px; border-radius: 6px; background: var(--med-line); overflow: hidden; margin-top: 4px; }
.gauge i { display: block; height: 100%; border-radius: 6px; background: linear-gradient(90deg, var(--pt-main), var(--pt-core)); }
.gauge.low i { background: var(--t-red); }
.split-l { display: flex; justify-content: space-between; gap: 8px; font-size: .78rem; margin-top: 6px; }
.tiles { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin: 10px 12px 0; }
@container (min-width: 620px) { .tiles { grid-template-columns: repeat(4, 1fr); } .tiles.six { grid-template-columns: repeat(3, 1fr); } }
.tile { padding: 12px; border-radius: 12px; border: 1px solid var(--med-line); min-width: 0; }
.tile.low { border-color: var(--t-red); }
.tile-l { font-size: .78rem; color: var(--med-muted); }
.tile-v { font-size: 1.35rem; font-weight: 700; margin-top: 2px; }
.tile-n { font-size: .72rem; color: var(--med-muted); margin-top: 4px; }
.rows { margin: 14px 12px 0; }
.rows-h { font-size: .82rem; color: var(--med-muted); margin: 0 4px 2px; }
.row { display: flex; justify-content: space-between; gap: 12px; padding: 8px 12px; border: 1px solid var(--med-line);
  border-radius: 10px; font-size: .85rem; margin-top: 6px; }
.row span { color: var(--med-muted); min-width: 0; }
.row b { white-space: nowrap; flex: none; }
.row b.now { color: var(--pt-main); }
.buy-btn { all: unset; cursor: pointer; padding: 6px 12px; border-radius: 999px; font-size: .8rem; font-weight: 600;
  border: 1px solid var(--med-line); background: var(--med-surface); color: var(--med-text); }
.buy-btn.on, .buy-btn:hover { border-color: var(--pt-main); }
.buy-btn:focus-visible { outline: 2px solid var(--pt-main); }
.buy { margin: 0 12px 8px; padding: 12px; border-radius: 14px; border: 1px solid var(--pt-main); background: var(--med-surface); }
.buy-g { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px 10px; }
@container (min-width: 620px) { .buy-g { grid-template-columns: repeat(5, 1fr); } }
.buy label { display: flex; flex-direction: column; gap: 4px; font-size: .75rem; color: var(--med-muted); min-width: 0; }
.buy input { font: inherit; font-size: .9rem; padding: 7px 9px; border-radius: 8px; border: 1px solid var(--med-line);
  background: var(--med-bg); color: var(--med-text); min-width: 0; width: 100%; box-sizing: border-box; }
.buy-n { margin: 8px 0 0; font-size: .72rem; color: var(--med-muted); }
.buy-a { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
.buy-a button { font: inherit; font-size: .85rem; font-weight: 600; padding: 7px 14px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--pt-main); background: var(--pt-main); color: #10301a; }
.buy-a button.ghost { background: transparent; color: var(--med-text); border-color: var(--med-line); }
.buy-a button[disabled] { opacity: .5; cursor: default; }
.rows-n { font-size: .72rem; color: var(--med-muted); margin: 6px 4px 0; }
.err { margin-top: 8px; padding: 8px 12px; border-radius: 12px; border: 1px solid var(--t-red); font-size: .8rem; color: var(--med-text); }
footer { padding: 10px 18px 14px; font-size: .7rem; color: var(--med-muted); }
.empty { padding: 4px 18px 18px; display: flex; flex-direction: column; gap: 6px; font-size: .9rem; }
.empty span { color: var(--med-muted); }
ha-card.th-ha {
  --med-blue: var(--primary-color, #1d93e3);
  --med-bg: var(--ha-card-background, var(--card-background-color, #fff));
  --med-surface: color-mix(in srgb, var(--primary-text-color, #000) 5%, transparent);
  --med-line: var(--divider-color, rgba(127, 127, 127, .25));
  --med-text: var(--primary-text-color, #1f2937);
  --med-muted: var(--secondary-text-color, #6b7280);
  border-radius: var(--ha-card-border-radius, 12px);
  border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, var(--divider-color, #e0e0e0));
}
ha-card.th-v2.light {
  --med-bg: #ffffff; --med-surface: #f2f5f9; --med-line: #dbe2ec;
  --med-text: #1a2434; --med-muted: #5b6b82; --med-up: #c2560f;
  box-shadow: 0 1px 3px rgba(26, 36, 52, .08);
}
ha-card.light { --pt-main: #23944a; --pt-core: #7cb518; }
@media (max-width: 420px) { .hero-v { font-size: 2rem; } }
</style>`;
// Variable --fs (réglage « taille du texte ») : sans réglage elle vaut 1 et rien ne change.
const STYLE = STYLE_BASE.replace(/(-?\d*\.?\d+)rem/g, "calc($1rem * var(--fs, 1))");

/* ---------------------------------------------------------------- éditeur */

const THEME_SELECT = {
  name: "theme",
  selector: {
    select: {
      mode: "dropdown",
      options: [
        { value: "v2", label: "Bleu nuit" },
        { value: "auto", label: "Bleu nuit, ou clair si Home Assistant est en mode clair" },
        { value: "ha", label: "Thème Home Assistant (clair ou sombre)" },
      ],
    },
  },
};
const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const SCHEMA = [
  { name: "calendar", required: true, selector: { entity: { domain: "calendar" } } },
  { name: "title", selector: { text: {} } },
  { name: "label", selector: { text: {} } },
  { name: "average_over", selector: { number: { min: 1, max: 20, step: 1, mode: "box" } } },
  { name: "season_start", selector: { select: { mode: "dropdown", options: MONTHS.map((m, i) => ({ value: i + 1, label: m })) } } },
  { name: "history", selector: { number: { min: 1, max: 20, step: 1, mode: "box" } } },
  { name: "purchases", selector: { number: { min: 1, max: 20, step: 1, mode: "box" } } },
  { name: "warn_days", selector: { number: { min: 0, max: 30, step: 1, mode: "box", unit_of_measurement: "jours" } } },
  THEME_SELECT,
  { name: "font_size", selector: { number: { min: 70, max: 150, step: 5, mode: "slider", unit_of_measurement: "%" } } },
];
const LABELS = {
  calendar: "Calendrier où chaque nouveau bidon est noté",
  title: "Titre",
  label: "Texte sous le titre (par exemple le combustible : PTX 2000)",
  average_over: "Durée moyenne calculée sur les derniers bidons",
  season_start: "Début de la saison de chauffe",
  history: "Derniers bidons affichés",
  purchases: "Derniers achats affichés",
  warn_days: "Alerte « bientôt vide » quand il reste moins de",
  theme: "Couleurs de la carte",
  font_size: "Taille du texte",
};

/* ------------------------------------------------------------ installation */

/** Installation du suivi depuis l'éditeur : entrées (prix, réserve) et automatisation du tag NFC,
 *  créées par l'API de Home Assistant comme le ferait l'interface (compte administrateur). */
const AUTOMATION_ALIAS = "Bidon de pétrole entamé (tag NFC)";
const AUTOMATION_ID = "petrole_bidon_tag_nfc";
const INSTALL_DEFAULTS = { tags: "Bidon pétrole", capacity: 20, price: 0, notify: "", stock: true };

const INSTALL = {
  normalize(install) {
    const i = { ...INSTALL_DEFAULTS, ...(install || {}) };
    const tags = (Array.isArray(i.tags) ? i.tags : String(i.tags || "").split(",")).map((t) => String(t).trim()).filter(Boolean);
    return {
      tags: tags.length ? tags : [INSTALL_DEFAULTS.tags],
      capacity: Math.max(1, PETROLE.num(i.capacity) || 20),
      price: Math.max(0, PETROLE.num(i.price) || 0),
      notify: String(i.notify || ""),
      stock: i.stock !== false,
    };
  },

  /** Entrées à créer : l'identifiant vient du nom (« Pétrole prix du bidon » → petrole_prix_du_bidon). */
  helpers(o) {
    const list = [{
      id: "petrole_prix_du_bidon", name: "Pétrole prix du bidon",
      opts: { min: 0, max: 500, step: 0.01, mode: "box", unit_of_measurement: "€", icon: "mdi:cash", initial: o.price },
      value: o.price,
    }];
    if (o.stock) {
      list.push({
        id: "petrole_bidons_en_reserve", name: "Pétrole bidons en réserve",
        opts: { min: 0, max: 100, step: 1, mode: "box", unit_of_measurement: "bidons", icon: "mdi:storage-tank-outline", initial: 0 },
      });
    }
    return list;
  },

  automation(o, calendar) {
    const notify = o.notify ? `notify.${o.notify}` : "";
    const tpl = (v) => ({ condition: "template", value_template: v });
    return {
      id: AUTOMATION_ID,
      alias: AUTOMATION_ALIAS,
      description: "Bip du tag NFC du poêle à chaque bidon de pétrole entamé : note le bidon dans le calendrier (litres et prix), retire un bidon de la réserve et prévient le téléphone qui a bipé. Créée par la carte Pétrole.",
      mode: "single",
      max_exceeded: "silent",
      triggers: o.tags.map((t) => ({ trigger: "tag", tag_id: t })),
      // un second bip juste après (double lecture du tag) ne note pas un deuxième bidon
      conditions: [tpl("{{ this.attributes.last_triggered is none or (now() - this.attributes.last_triggered).total_seconds() > 600 }}")],
      actions: [
        {
          variables: {
            phone: `{% set d = (trigger.event.data.device_id | default('')) if trigger.event is defined else '' %}{% set n = device_attr(d, 'name') if d else '' %}{{ ('notify.mobile_app_' ~ (n | slugify)) if n else '${notify}' }}`,
            litres: o.capacity,
            prix: "{{ states('input_number.petrole_prix_du_bidon') | float(0) }}",
            reserve: o.stock ? "{{ states('input_number.petrole_bidons_en_reserve') | int(-1) }}" : -1,
          },
        },
        {
          action: "calendar.create_event", target: { entity_id: calendar },
          data: {
            summary: "Bidon pétrole",
            description: "{{ litres }} L{% if prix > 0 %} · {{ prix }} €{% endif %}",
            start_date_time: "{{ now() }}",
            end_date_time: "{{ now() + timedelta(minutes=1) }}",
          },
        },
        ...(o.stock ? [{
          if: [tpl("{{ reserve > 0 }}")],
          then: [{ action: "input_number.set_value", target: { entity_id: "input_number.petrole_bidons_en_reserve" }, data: { value: "{{ reserve - 1 }}" } }],
        }] : []),
        {
          if: [tpl("{{ phone != '' }}")],
          then: [{
            action: "{{ phone }}",
            data: {
              title: "Bidon de pétrole noté",
              message: "{{ litres }} L{% if prix > 0 %} à {{ ('%.2f' % prix) | replace('.', ',') }} €{% endif %}, noté le {{ now().strftime('%d/%m à %H:%M') }}."
                + (o.stock ? "{% if reserve > 0 %} Réserve : {{ reserve - 1 }} bidon{{ 's' if reserve - 1 > 1 else '' }}{{ ' : pensez à en racheter.' if reserve - 1 <= 1 else '.' }}{% elif reserve == 0 %} Plus de bidon en réserve.{% endif %}" : ""),
              data: { tag: "petrole_bidon", notification_icon: "mdi:storage-tank" },
            },
          }],
        },
      ],
    };
  },

  /** Réglages repris d'une automatisation déjà en place (relancer l'installation ne perd rien). */
  fromExisting(auto) {
    const tags = (auto?.triggers || auto?.trigger || []).filter((t) => (t.trigger || t.platform) === "tag" && t.tag_id).map((t) => t.tag_id);
    const vars = Object.assign({}, ...(auto?.actions || auto?.action || []).filter((a) => a.variables).map((a) => a.variables));
    const m = /else '([^']*)'\s*\}\}$/.exec(String(vars.phone || ""));
    return {
      tags,
      capacity: PETROLE.num(vars.litres) ?? INSTALL_DEFAULTS.capacity,
      notify: m && m[1].startsWith("notify.") ? m[1].slice(7) : "",
      stock: String(vars.reserve ?? "").includes("petrole_bidons_en_reserve"),
    };
  },

  /** Crée ou met à jour le tout ; log(texte) décrit chaque étape. Les entrées existantes gardent leur valeur,
   *  sauf le prix du bidon, mis au prix saisi s'il est renseigné. */
  async run(hass, config, log) {
    const o = INSTALL.normalize(config.install?.tags ? config.install : { ...(config.install || {}), tags: TAGS.suggest(hass) });
    if (!hass.user?.is_admin) throw new Error("il faut un compte administrateur de Home Assistant");
    const calendar = config.calendar || PETROLE_DEFAULTS.calendar;
    if (!hass.states[calendar]) throw new Error(`le calendrier ${calendar} n'existe pas : choisissez-en un dans les options de la carte`);
    const existing = new Set((await hass.callWS({ type: "input_number/list" })).map((x) => x.id));
    let made = 0;
    for (const h of INSTALL.helpers(o)) {
      if (existing.has(h.id)) {
        if (h.value) await hass.callService("input_number", "set_value", { entity_id: `input_number.${h.id}`, value: h.value });
        continue;
      }
      const res = await hass.callWS({ type: "input_number/create", name: h.name, ...h.opts });
      if (res?.id && res.id !== h.id) throw new Error(`l'entrée « ${h.name} » a reçu l'identifiant ${res.id} au lieu de ${h.id}`);
      made += 1;
    }
    log(made ? `${made} entrée${made > 1 ? "s" : ""} créée${made > 1 ? "s" : ""}` : "entrées déjà présentes");
    const current = Object.values(hass.states).find((s) => s.entity_id?.startsWith("automation.") && s.attributes?.friendly_name === AUTOMATION_ALIAS);
    const id = current?.attributes?.id || AUTOMATION_ID;
    await hass.callApi("POST", `config/automation/config/${id}`, { ...INSTALL.automation(o, calendar), id });
    log(`automatisation « ${AUTOMATION_ALIAS} » ${current ? "mise à jour" : "créée"} (tag${o.tags.length > 1 ? "s" : ""} ${o.tags.join(", ")})`);
    if (!o.notify) log("pas de téléphone par défaut : seul le téléphone qui bipe est prévenu");
  },
};

/** Tags connus de Home Assistant (Paramètres › Tags) : l'automatisation se déclenche sur leur ID. */
const TAGS = {
  list(hass) {
    return Object.values(hass?.states || {}).filter((s) => s.entity_id?.startsWith("tag.") && s.attributes?.tag_id)
      .map((s) => ({ id: String(s.attributes.tag_id), name: String(s.attributes.friendly_name || s.attributes.tag_id) }))
      .sort((a, b) => a.name.localeCompare(b.name, "fr"));
  },
  /** Tag proposé quand rien n'est choisi : celui dont l'ID ou le nom parle de pétrole, sinon « Bidon pétrole ». */
  suggest(hass) {
    const t = TAGS.list(hass).find((x) => /p[ée]trole|bidon|po[êe]le/i.test(`${x.id} ${x.name}`));
    return [t ? t.id : INSTALL_DEFAULTS.tags];
  },
};

const INSTALL_SCHEMA = (phones, tags) => [
  {
    name: "tags",
    selector: { select: { multiple: true, custom_value: true, mode: "dropdown", options: tags.map((t) => ({ value: t.id, label: t.name === t.id ? t.id : `${t.name} (ID : ${t.id})` })) } },
  },
  { name: "capacity", selector: { number: { min: 1, max: 100, step: 1, mode: "box", unit_of_measurement: "L" } } },
  { name: "price", selector: { number: { min: 0, max: 500, step: 0.01, mode: "box", unit_of_measurement: "€" } } },
  { name: "stock", selector: { boolean: {} } },
  { name: "notify", selector: { select: { mode: "dropdown", options: [{ value: "", label: "Aucun" }, ...phones.map((p) => ({ value: p, label: p.replace(/^mobile_app_/, "") }))] } } },
];
const INSTALL_LABELS = {
  tags: "Tag NFC du poêle (choisi dans Paramètres › Tags, ou ID tapé à la main)",
  capacity: "Contenance d'un bidon",
  price: "Prix d'un bidon (modifiable ensuite dans l'entrée « Pétrole prix du bidon »)",
  stock: "Suivre la réserve de bidons (un bidon retiré à chaque bip)",
  notify: "Téléphone par défaut (sinon : le téléphone qui a bipé)",
};

const INSTALL_STYLE = `<style>
.pt-inst { margin-top: 24px; border-top: 1px solid var(--divider-color, #e0e0e0); padding-top: 16px; }
.pt-inst h3 { margin: 0 0 6px; font-size: 1.05rem; font-weight: 500; }
.pt-inst p { margin: 0 0 12px; color: var(--secondary-text-color, #666); font-size: .9rem; line-height: 1.4; }
.pt-inst button { font: inherit; font-size: .9rem; padding: 8px 14px; border-radius: 8px; cursor: pointer;
  border: 1px solid transparent; background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); }
.pt-inst button[disabled] { opacity: .5; cursor: default; }
.pt-row { display: flex; gap: 10px; flex-wrap: wrap; margin: 12px 0; }
.pt-log { margin: 10px 0 0; padding: 0; list-style: none; font-size: .9rem; }
.pt-log li { margin: 4px 0; }
.pt-log .err { color: var(--error-color, #db4437); }
.pt-inst p.pt-warn { color: var(--warning-color, #ffa600); margin: 8px 0 0; }
</style>`;

/** Éditeur de la carte, avec en dessous l'installation du tag NFC. */
class PetroleCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...config };
    this._draw();
  }

  set hass(hass) {
    this._hass = hass;
    this._draw();
  }

  _emit() {
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true }));
  }

  _draw() {
    if (!this._hass || !this._config) return;
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => LABELS[s.name] || s.name;
      this._form.schema = SCHEMA;
      this._form.addEventListener("value-changed", (ev) => {
        const { install } = this._config;
        this._config = { ...ev.detail.value, ...(install ? { install } : {}) };
        this._emit();
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    const { install: _i, ...rest } = this._config;
    this._form.data = { ...PETROLE_DEFAULTS, ...rest };
    this._drawInstall();
  }

  _current() {
    return Object.values(this._hass.states).find((s) => s.entity_id?.startsWith("automation.") && s.attributes?.friendly_name === AUTOMATION_ALIAS);
  }

  /** Première ouverture : reprendre les réglages de l'automatisation déjà en place. */
  async _prefill() {
    this._prefilled = true;
    const st = this._current();
    if (this._config.install || !st?.attributes?.id || !this._hass.user?.is_admin) return;
    try {
      const auto = await this._hass.callApi("GET", `config/automation/config/${st.attributes.id}`);
      const price = PETROLE.num(this._hass.states["input_number.petrole_prix_du_bidon"]?.state);
      this._config = { ...this._config, install: { ...INSTALL.fromExisting(auto), ...(price ? { price } : {}) } };
      this._emit();
      this._drawInstall();
    } catch (e) { /* pas de reprise : réglages par défaut */ }
  }

  _drawInstall() {
    if (!this._prefilled) this._prefill();
    if (!this._inst) {
      this._inst = document.createElement("div");
      this._inst.className = "pt-inst";
      this._inst.innerHTML = `${INSTALL_STYLE}<h3>Installation du tag NFC</h3>
        <p>Crée dans Home Assistant l'entrée du prix du bidon, celle de la réserve et l'automatisation du tag :
        à chaque bidon entamé, on bipe le tag du poêle et le bidon est noté dans le calendrier de la carte.
        Le tag s'écrit avec l'application compagnon (Paramètres › Tags). À relancer après un changement : les bidons déjà notés sont gardés.</p>
        <div class="pt-form"></div>
        <p class="pt-warn" hidden></p>
        <div class="pt-row"><button type="button" class="pt-go">Installer ou mettre à jour</button></div>
        <ul class="pt-log"></ul>`;
      this._instForm = document.createElement("ha-form");
      this._instForm.computeLabel = (s) => INSTALL_LABELS[s.name] || s.name;
      this._instForm.addEventListener("value-changed", (ev) => {
        this._config = { ...this._config, install: { ...ev.detail.value } };
        this._emit();
      });
      this._inst.querySelector(".pt-form").appendChild(this._instForm);
      this._inst.querySelector(".pt-go").addEventListener("click", () => this._install());
      this.appendChild(this._inst);
    }
    const phones = Object.keys(this._hass.services?.notify || {}).filter((s) => s.startsWith("mobile_app_")).sort();
    this._instForm.hass = this._hass;
    const known = TAGS.list(this._hass);
    this._instForm.schema = INSTALL_SCHEMA(phones, known);
    const inst = this._config.install || {};
    const chosen = INSTALL.normalize(inst.tags ? inst : { tags: TAGS.suggest(this._hass) }).tags;
    this._instForm.data = { ...INSTALL_DEFAULTS, ...inst, tags: chosen };
    // un ID absent de Home Assistant : le bip ne déclencherait rien
    const unknown = chosen.filter((t) => !known.some((k) => k.id === t));
    const warn = this._inst.querySelector(".pt-warn");
    warn.hidden = !unknown.length || !known.length;
    warn.textContent = unknown.length ? `⚠ Tag inconnu de Home Assistant : ${unknown.join(", ")}. Choisissez le tag du poêle dans la liste, ou écrivez-le d'abord (Paramètres › Tags).` : "";
    const go = this._inst.querySelector(".pt-go");
    const admin = !!this._hass.user?.is_admin;
    go.disabled = !admin || this._busy;
    go.title = admin ? "" : "Réservé aux administrateurs";
  }

  async _install() {
    const log = this._inst.querySelector(".pt-log");
    const add = (t, err) => { const li = document.createElement("li"); li.textContent = `${err ? "✖" : "✔"} ${t}`; if (err) li.className = "err"; log.appendChild(li); };
    log.innerHTML = "";
    this._busy = true;
    this._drawInstall();
    try {
      await INSTALL.run(this._hass, this._config, (t) => add(t));
      add("installation terminée : bipez le tag pour noter le bidon en service");
    } catch (err) {
      add(`installation arrêtée : ${err?.body?.message || err?.message || err}`, true);
    }
    this._busy = false;
    this._drawInstall();
  }
}

/* ---------------------------------------------------------- enregistrement */

if (typeof customElements !== "undefined") {
  const define = (name, cls) => { if (!customElements.get(name)) customElements.define(name, cls); };
  define("petrole-card", PetroleCard);
  define("petrole-card-editor", PetroleCardEditor);
  window.customCards = window.customCards || [];
  if (!window.customCards.some((c) => c.type === "petrole-card")) {
    window.customCards.push({
      type: "petrole-card",
      name: "Pétrole",
      description: "Poêle à pétrole : bidon en service (tag NFC), pétrole restant, durée moyenne, fin estimée, consommation, coût, réserve et saison de chauffe.",
      preview: true,
    });
  }
  console.info(`%c PETROLE-CARD %c ${CARD_VERSION} `, "background:#4cc36b;color:#1a2434;font-weight:700", "background:#1d93e3;color:#fff");
}

if (typeof module !== "undefined") module.exports = { PETROLE, INSTALL };
