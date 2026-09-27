/* JaipurEst frontend — fully static: fetches exported JSON and filters
   entirely client-side (works on Cloudflare Pages with zero backend). */

"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const PAGE = 24;
const JAIPUR = { lat: 26.9124, lng: 75.7873 };

const GROUPS = {
  flats:      ["apartment"],
  houses:     ["independent_house", "builder_floor", "house", "floor", "penthouse"],
  plots:      ["residential_plot"],
  land:       ["land", "agricultural_land", "farmhouse", "farm_house", "villa_plot"],
  villas:     ["villa", "villa_plot"],
  commercial: ["commercial_plot", "commercial_land", "commercial_space",
               "commercial", "shop", "office", "industrial", "warehouse", "retail"],
};

const SOURCE_LABELS = {
  "ninety9acres": "99acres", "magicbricks": "Magicbricks",
  "khaliplot": "KhaliPlot", "flatsdekho": "FlatsDekho",
  "housing": "Housing.com", "generic": "Builder site",
};

const state = {
  tab: "sale", cat: "all", q: "",
  minBudget: "", maxBudget: "", minArea: "", maxArea: "",
  locality: "", distance: "", source: "", sort: "new",
  beds: new Set(), badges: new Set(),
  page: 1,
};

let ACTIVE = [], SOLD = [], META = {};

/* ---------------------------------------------------------------- helpers */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function inr(n) {
  if (n == null) return "—";
  if (n >= 1e7) return "₹" + (n / 1e7).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1") + " Cr";
  if (n >= 1e5) return "₹" + (n / 1e5).toFixed(1).replace(/\.0$/, "") + " L";
  return "₹" + Math.round(n).toLocaleString("en-IN");
}
function sqft(n) { return n == null ? "—" : Math.round(n).toLocaleString("en-IN") + " sqft"; }
function timeAgo(iso) {
  if (!iso) return "";
  const raw = /Z$|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + "Z";
  const d = (Date.now() - Date.parse(raw)) / 1000;
  if (!isFinite(d)) return "";
  if (d < 90) return "just now";
  if (d < 3600) return Math.round(d / 60) + " min ago";
  if (d < 86400) return Math.round(d / 3600) + " hr ago";
  if (d < 172800) return "yesterday";
  return Math.round(d / 86400) + " days ago";
}
function haversine(a, b, c, d) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(c - a), dLon = rad(d - b);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a)) * Math.cos(rad(c)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// Real calendar dates for the visit-slot picker, not "Today"/"Tomorrow" filler.
// Anchored to IST: a buyer in Jaipur picking "today" must not get a UTC date
// that has already rolled over. Sundays are skipped -- field agents work Mon-Sat.
// ponytail: hardcoded to 7 days / Sun-off; add when a real availability feed exists.
function nextDays(n = 7) {
  const now = new Date(Date.now() + 5.5 * 3600e3); // IST = UTC+5:30
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  let out = "";
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getTime() + i * 86400e3);
    if (d.getDay() === 0) continue;
    out += `<option value="${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}">` +
      `${DAYS[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}</option>`;
  }
  return out;
}

function typeLabel(t) {
  return (t || "property").replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}
/* public reference code — stable per listing, reveals nothing about origin;
   our team maps it back with `python -m jaipurrealty.lead_lookup <REF>` */
function refCode(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return "JR" + h.toString(36).toUpperCase().slice(0, 6);
}
function waNum() {
  return (META.site && META.site.whatsapp) || "919999999999";
}
function waLink(r) {
  const price = r.price != null ? inr(r.price) : "price on request";
  // The prefilled message carries the ref code AND a filtered link, so the agent
  // reading the chat knows instantly which property it is and can send more
  // options in the same locality with one tap instead of typing them out.
  const ref = refCode(r.id);
  const more = similarLink(r);
  const msg =
    `Hi JaipurEst! I'm interested in ${ref} — ${r.title} (${price}, ${r.locality || "Jaipur"}).\n` +
    `More options in the same area: ${more}`;
  return `https://wa.me/${waNum()}?text=${encodeURIComponent(msg)}`;
}
// Reverse lookup: a buyer/agent only ever has a ref code (JRXXXXXX). Without this
// the code is useless off-site -- paste it in the bar and the property opens.
function findByRef(ref) {
  const want = String(ref || "").trim().toUpperCase();
  if (!/^JR[A-Z0-9]{1,6}$/.test(want)) return null;
  return ACTIVE.concat(SOLD).find((r) => refCode(r.id) === want) || null;
}

// A ready-made filtered link for "same location, more options": the agent sends
// ONE link instead of typing out 3 properties by hand on every call.
function similarLink(r) {
  const p = new URLSearchParams();
  if (r.locality) p.set("loc", r.locality);
  if (state.tab === "rent" || r.listing_type === "rent") p.set("tab", "rent");
  if (r.property_type) p.set("cat", r.property_type);
  if (r.bedrooms) p.set("beds", String(r.bedrooms));
  const base = location.origin + location.pathname;
  return base + (p.toString() ? "#" + p.toString() : "");
}

function waMsgLink(msg) {
  return `https://wa.me/${waNum()}?text=${encodeURIComponent(msg)}`;
}
function telLink() {
  return "tel:" + ((META.site && META.site.phone) || "+919660670160");
}
const BADGE_CLASS = {
  "URGENT": "bg-urgent",
  "HOT": "bg-hot", "DEMANDED": "bg-dem", "PREMIUM": "bg-prem", "VERIFIED": "bg-ver",
  "NEW": "bg-new", "PRICE DROP": "bg-drop", "CROSS LISTED": "bg-cross", "SOLD": "bg-sold",
};

/* ---------------------------------------------------------------- filters */
function currentList() { return state.tab === "sold" ? SOLD : ACTIVE; }

function matches(r) {
  if (state.tab !== "sold") {
    if (state.tab === "sale" && r.listing_type !== "sale") return false;
    if (state.tab === "rent" && r.listing_type !== "rent") return false;
  }
  if (state.cat !== "all") {
    const types = GROUPS[state.cat] || [];
    if (!types.includes(r.property_type)) return false;
  }
  if (state.q) {
    const hay = [r.title, r.locality, r.address, r.property_type, (r.tags || []).join(" ")]
      .filter(Boolean).join(" ").toLowerCase();
    if (!state.q.split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  if (state.locality && r.locality !== state.locality) return false;
  if (state.minBudget && (r.price == null || r.price < +state.minBudget)) return false;
  if (state.maxBudget && (r.price == null || r.price > +state.maxBudget)) return false;
  if (state.minArea && (r.area_sqft == null || r.area_sqft < +state.minArea)) return false;
  if (state.maxArea && (r.area_sqft == null || r.area_sqft > +state.maxArea)) return false;
  if (state.beds.size) {
    const b = r.bedrooms || 0;
    let ok = false;
    for (const n of state.beds) ok = ok || (n === 5 ? b >= 5 : b === n);
    if (!ok) return false;
  }
  if (state.badges.size) {
    for (const b of state.badges) if (!(r.badges || []).includes(b)) return false;
  }
  if (state.source && r.source !== state.source) return false;
  if (state.distance) {
    const loc = META.localities.find((l) => l.name === state.locality);
    const c = loc && loc.lat != null ? loc : JAIPUR;
    let pLat = r.lat, pLng = r.lng;
    if (pLat == null || pLng == null) {
      // most sources don't geocode — fall back to the listing's locality centre
      const lc = META.localities.find((l) => l.name === r.locality);
      if (lc && lc.lat != null) { pLat = lc.lat; pLng = lc.lng; }
      else return false;
    }
    if (haversine(c.lat, c.lng, pLat, pLng) > +state.distance) return false;
  }
  return true;
}

function sorted(list) {
  const c = [...list];
  const nn = (a, b, f) => (f(a) == null) - (f(b) == null) || f(a) - f(b);
  if (state.sort === "plow") c.sort((a, b) => nn(a, b, (r) => r.price));
  else if (state.sort === "phigh") c.sort((a, b) => nn(b, a, (r) => r.price));
  else if (state.sort === "area") c.sort((a, b) => nn(b, a, (r) => r.area_sqft));
  else c.sort((a, b) => new Date(b.last_seen || 0) - new Date(a.last_seen || 0));
  return c;
}

/* ---------------------------------------------------------------- render */
function cardHTML(r) {
  const ORD = ["URGENT", "SOLD", "PRICE DROP", "HOT", "DEMANDED", "NEW", "PREMIUM", "VERIFIED", "CROSS LISTED"];
  const badges = (r.badges || []).slice()
    .sort((a, b) => ORD.indexOf(a) - ORD.indexOf(b))
    .slice(0, 3).map((b) =>
    `<span class="bg ${BADGE_CLASS[b] || "bg-cross"}">${esc(b)}</span>`).join("");
  const img = r.images && r.images[0]
    ? `<img src="${esc(r.images[0])}" alt="${esc(r.title)}" data-t="${esc(typeLabel(r.property_type))}" loading="lazy">`
    : `<div class="ph">${esc(typeLabel(r.property_type))}</div>`;
  const beds = r.bedrooms ? `<div><b>${r.bedrooms}</b> BHK</div>` : "";
  const baths = r.bathrooms ? `<div><b>${r.bathrooms}</b> Bath</div>` : "";
  const area = r.area_sqft ? `<div><b>${sqft(r.area_sqft)}</b></div>` : "";
  const priceSub = r.listing_type === "rent" ? `<small>/month</small>` :
    (r.price_per_sqft ? `<small>${inr(r.price_per_sqft)}/sqft</small>` : "");
  const priceTxt = r.price == null
    ? `<span class="pr-na">Price on request</span>`
    : inr(r.price);
  const npx = r.images && r.images.length > 1
    ? `<span class="npx">📷 ${r.images.length} photos</span>` : "";
  return `
  <article class="card" data-id="${r.id}">
    <div class="card-img">
      ${img}
      ${npx}
      <div class="badges">${badges}</div>
    </div>
    <div class="card-body">
      <div class="price">${priceTxt} ${priceSub}</div>
      <span class="ptype">${esc(typeLabel(r.property_type))}${r.bedrooms ? " · " + r.bedrooms + " BHK" : ""}</span>
      <h3 class="card-title">${esc(r.title)}</h3>
      <div class="card-loc">
        <svg width="13" height="13" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 14.5 9 2.5 2.5 0 0 1 12 11.5z"/></svg>
        <span>${esc(r.locality || r.address || "Jaipur")}</span>
      </div>
      <div class="specs">${beds}${baths}${area}</div>
      <div class="card-time">seen ${esc(timeAgo(r.last_seen))}</div>
    </div>
  </article>`;
}

function render() {
  const list = sorted(currentList().filter(matches));
  const shown = list.slice(0, state.page * PAGE);

  $("#grid").innerHTML = shown.map(cardHTML).join("");
  $("#empty").hidden = list.length > 0;
  $("#more").hidden = shown.length >= list.length;
  $("#count").innerHTML = `<b>${list.length.toLocaleString("en-IN")}</b> ${state.tab === "sold" ? "sold" : "listings"} found`;

  const active = [state.q, state.locality, state.minBudget, state.maxBudget,
    state.minArea, state.maxArea, state.distance, state.source,
    ...state.beds, ...state.badges].filter(Boolean).length;
  $("#activeCount").textContent = active ? ` (${active})` : "";

  writeHash();
}

/* ---------------------------------------------------------------- detail modal */
/* ---------- photo gallery: thumbs in modal + full-screen lightbox ---------- */
let LB = null;
function bindGallery(r, gal) {
  const box = $("#modalBody .gal");
  if (!box) return;
  const main = box.querySelector("#galImg");
  const count = box.querySelector(".gal-count");
  const thumbs = [...box.querySelectorAll(".gal-thumbs img")];
  const show = (i) => {
    const k = (i + gal.length) % gal.length;
    main.src = gal[k];
    count.textContent = `${k + 1} / ${gal.length}`;
    thumbs.forEach((t, j) => t.classList.toggle("on", j === k));
    box._i = k;
  };
  box._i = 0;
  box.querySelector(".g-prev").addEventListener("click", (e) => { e.stopPropagation(); show(box._i - 1); });
  box.querySelector(".g-next").addEventListener("click", (e) => { e.stopPropagation(); show(box._i + 1); });
  box.querySelector(".gal-thumbs").addEventListener("click", (e) => {
    const t = e.target.closest("img[data-i]");
    if (t) show(+t.dataset.i);
  });
  box.querySelector(".gal-main").addEventListener("click", () => openLightbox(gal, box._i, r));
}

function openLightbox(gal, i, r) {
  if (!LB) {
    LB = document.createElement("div");
    LB.id = "lbox";
    LB.hidden = true;
    LB.innerHTML = `
      <img id="lbImg" alt="">
      <button type="button" class="gal-nav l-prev" aria-label="Previous photo">‹</button>
      <button type="button" class="gal-nav l-next" aria-label="Next photo">›</button>
      <span class="gal-count lb-count"></span>
      <button type="button" class="lb-x" aria-label="Close">×</button>
      <div class="lb-cap"></div>`;
    document.body.appendChild(LB);
    LB.addEventListener("click", (e) => {
      if (e.target === LB || e.target.closest(".lb-x")) { closeLightbox(); return; }
      if (e.target.closest(".l-prev")) { e.stopPropagation(); lbShow(LB._i - 1); return; }
      if (e.target.closest(".l-next")) { e.stopPropagation(); lbShow(LB._i + 1); return; }
    });
  }
  LB._gal = gal; LB._i = i; LB._r = r;
  lbShow(i);
  LB.hidden = false;
  document.body.style.overflow = "hidden";
}
function lbShow(i) {
  const g = LB._gal || [];
  if (!g.length) return;
  LB._i = (i + g.length) % g.length;
  LB.querySelector("#lbImg").src = g[LB._i];
  LB.querySelector(".lb-count").textContent = `${LB._i + 1} / ${g.length}`;
  LB.querySelector(".lb-cap").textContent = LB._r
    ? `${LB._r.title} · ${LB._r.locality || "Jaipur"} · ${refCode(LB._r.id)}`
    : "";
}
function closeLightbox() {
  if (!LB) return;
  LB.hidden = true;
  const m = $("#modal");
  document.body.style.overflow = (m && m.classList.contains("on")) ? "hidden" : "";
}

// ------------------------------------------------------------- demand count
// Fire-and-forget. The badge only asks "is this hot?", never an exact number, so
// a dropped or duplicate increment is not worth a spinner or an error path.
// `keepalive` lets the POST survive the page being closed on mobile.
function countView(ref) {
  const ep = (META.site || {}).view_endpoint;
  if (!ep || !ref) return;
  try {
    fetch(ep + "/view", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: ref }),
      keepalive: true,
      mode: "cors",
    }).catch(() => {});
  } catch (e) { /* a lost view must never break the page */ }
}

function openModal(id) {
  const r = currentList().find((x) => x.id === id) || ACTIVE.find((x) => x.id === id);
  if (!r) return;
  countView(refCode(r.id));
  const gal = (r.images || []).filter(Boolean);
  const img = gal.length > 1
    ? `<div class="gal">
         <div class="gal-main" title="Click to view full screen">
           <img id="galImg" src="${esc(gal[0])}" alt="${esc(r.title)}" data-t="${esc(typeLabel(r.property_type))}">
           <button type="button" class="gal-nav g-prev" aria-label="Previous photo">‹</button>
           <button type="button" class="gal-nav g-next" aria-label="Next photo">›</button>
           <span class="gal-count">1 / ${gal.length}</span>
         </div>
         <div class="gal-thumbs">${gal.map((u, i) =>
           `<img src="${esc(u)}" data-i="${i}" class="${i === 0 ? "on" : ""}" loading="lazy" alt="">`).join("")}</div>
       </div>`
    : gal.length
      ? `<img src="${esc(gal[0])}" alt="${esc(r.title)}" data-t="${esc(typeLabel(r.property_type))}">`
      : `<div class="ph">${esc(typeLabel(r.property_type))}</div>`;
  const cells = [
    ["Type", typeLabel(r.property_type) + (r.listing_type === "rent" ? " · Rent" : " · Sale")],
    ["Size", r.area_sqft ? sqft(r.area_sqft) : "—"],
    ["Configuration", r.bedrooms ? r.bedrooms + " BHK" + (r.bathrooms ? " · " + r.bathrooms + " bath" : "") : "—"],
    ["Floor", r.floor || "—"],
    ["Price / sqft", r.price_per_sqft ? inr(r.price_per_sqft) : "—"],
    ["Reference", refCode(r.id)],
  ].map(([k, v]) => `<div class="m-cell"><span>${k}</span><b>${esc(v)}</b></div>`).join("");

  $("#modalBody").innerHTML = `
    <div class="m-hero">${img}</div>
    <div class="m-body">
      <div class="m-badges">${(r.badges || []).map((b) =>
        `<span class="bg ${BADGE_CLASS[b] || "bg-cross"}">${esc(b)}</span>`).join("")}</div>
      <div class="m-price">${r.price == null ? '<span class="pr-na">Price on request</span>' : inr(r.price)} ${r.listing_type === "rent" ? "<small>/month</small>" : ""}</div>
      <div class="m-title">${esc(r.title)}</div>
      <div class="m-loc">${esc(r.address || r.locality || "Jaipur")}</div>
      <div class="m-grid">${cells}</div>
      ${r.description ? `<div class="m-desc">${esc(r.description)}</div>` : ""}
      <div class="m-actions">
        <a class="btn btn-primary" href="${esc(waLink(r))}" target="_blank" rel="noopener">💬 WhatsApp our property agent</a>
        <a class="btn btn-ghost" href="${esc(telLink())}">📞 Call us</a>
        <button class="btn btn-ghost" id="modalClose2">Close</button>
      </div>
      <div class="m-book">
        <div class="bk-h">📅 Book a meeting / site visit — ${esc(refCode(r.id))}</div>
        <form id="bookForm" class="bk-form">
          <input id="bkName" required maxlength="60" placeholder="Your name *" autocomplete="name">
          <input id="bkPhone" required type="tel" inputmode="tel" maxlength="16" pattern="[0-9+ ]{8,16}" placeholder="Mobile number *" autocomplete="tel">
          <input id="bkBudget" maxlength="40" placeholder="Budget (e.g. 60 L) — optional">
          <select id="bkMode">
            <option>Meet our sales executive at the JaipurEst office</option>
            <option>Meet at a public place near me</option>
            <option>Straight to the property site visit</option>
          </select>
          <select id="bkDay">${nextDays(7)}</select>
          <input id="bkTime" type="time" value="15:00" aria-label="Preferred time">
          <button class="btn btn-primary bk-go" type="submit">Request callback &amp; slot</button>
          <p class="bk-note">Our sales executive confirms your slot on WhatsApp within 10 minutes — meeting first at our office or a public place, property site visit after we finalise the shortlist.</p>
        </form>
        <div class="bk-ok" id="bkOk" hidden>✅ Enquiry sent — check WhatsApp, our property expert is on it. Ref <b>${esc(refCode(r.id))}</b>.</div>
      </div>
      <div class="m-seen">First seen ${esc(timeAgo(r.first_seen))} · last verified ${esc(timeAgo(r.last_seen))} · re-verified ${esc(META.site.refresh_note || "daily")}</div>
    </div>`;
  $("#modal").hidden = false;
  document.body.style.overflow = "hidden";
  if (gal.length > 1) bindGallery(r, gal);
  const c2 = $("#modalClose2");
  if (c2) c2.onclick = closeModal;
  const bf = $("#bookForm");
  if (bf) bf.onsubmit = (e) => {
    e.preventDefault();
    const payload = {
      ref: refCode(r.id), title: r.title,
      price: r.price != null ? inr(r.price) : "on request",
      locality: r.locality || r.address || "Jaipur",
      name: $("#bkName").value.trim(),
      phone: $("#bkPhone").value.trim(),
      budget: $("#bkBudget").value.trim() || "not specified",
      mode: $("#bkMode").value,
      day: $("#bkDay").value,
      time: $("#bkTime").value || "15:00",
    };
    const msg =
      `🏠 New buyer enquiry — ${payload.ref}\n` +
      `Property: ${payload.title}\n` +
      `Price: ${payload.price}\n` +
      `Locality: ${payload.locality}\n` +
      `Buyer: ${payload.name}\n` +
      `Phone: ${payload.phone}\n` +
      `Budget: ${payload.budget}\n` +
      `Meeting: ${payload.mode}\n` +
      `Preferred slot: ${payload.day} at ${payload.time}\n` +
      `— via JaipurEst website`;
    // Never fire a request at the un-replaced placeholder: a browser error in
    // the console on every enquiry is worse than no POST at all.
    const ep = META.site && META.site.lead_endpoint;
    if (ep && /^https:\/\//.test(ep) && !/YOUR-|<your-/i.test(ep)) {
      fetch(ep, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).catch(() => {});
    }
    window.open(waMsgLink(msg), "_blank", "noopener");
    bf.hidden = true;
    $("#bkOk").hidden = false;
  };
}
function closeModal() { $("#modal").hidden = true; document.body.style.overflow = ""; }

/* ---------------------------------------------------------------- URL hash */
let hashLock = false;
function writeHash() {
  if (hashLock) return;
  const p = new URLSearchParams();
  if (state.tab !== "sale") p.set("tab", state.tab);
  if (state.cat !== "all") p.set("cat", state.cat);
  if (state.q) p.set("q", state.q);
  if (state.locality) p.set("loc", state.locality);
  if (state.minBudget) p.set("min", state.minBudget);
  if (state.maxBudget) p.set("max", state.maxBudget);
  if (state.minArea) p.set("amin", state.minArea);
  if (state.maxArea) p.set("amax", state.maxArea);
  if (state.distance) p.set("dist", state.distance);
  if (state.source) p.set("src", state.source);
  if (state.sort !== "new") p.set("sort", state.sort);
  if (state.beds.size) p.set("beds", [...state.beds].join(","));
  if (state.badges.size) p.set("b", [...state.badges].join(","));
  const h = p.toString();
  history.replaceState(null, "", h ? "#" + h : location.pathname);
}
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (!p.toString()) return;
  hashLock = true;
  state.tab = p.get("tab") || state.tab;
  state.cat = p.get("cat") || state.cat;
  state.q = p.get("q") || "";
  state.locality = p.get("loc") || "";
  state.minBudget = p.get("min") || "";
  state.maxBudget = p.get("max") || "";
  state.minArea = p.get("amin") || "";
  state.maxArea = p.get("amax") || "";
  state.distance = p.get("dist") || "";
  state.source = p.get("src") || "";
  state.sort = p.get("sort") || "new";
  (p.get("beds") || "").split(",").filter(Boolean).forEach((n) => state.beds.add(+n));
  (p.get("b") || "").split(",").filter(Boolean).forEach((b) => state.badges.add(b));
  hashLock = false;
}

/* ---------------------------------------------------------------- selects */
const SALE_STEPS = [0, 1e5, 25e4, 5e5, 10e5, 15e5, 25e5, 40e5, 50e5, 75e5,
  1e7, 15e6, 2e7, 3e7, 5e7, 75e6, 1e8, 2e8, 5e8];
const RENT_STEPS = [0, 3000, 5000, 8000, 10000, 15000, 20000, 25000, 35000, 50000, 75000, 100000, 150000];

function fillBudget(sel, steps, keep) {
  sel.innerHTML = `<option value="">${sel.id === "minBudget" ? "No min" : "No max"}</option>` +
    steps.map((v) => `<option value="${v}">${inr(v)}</option>`).join("");
  if (keep && steps.includes(+keep)) sel.value = keep;
}
function fillLocalities() {
  const sel = $("#locality");
  sel.innerHTML = `<option value="">All Jaipur</option>` +
    (META.localities || []).map((l) =>
      `<option value="${esc(l.name)}">${esc(l.name)} (${l.count})</option>`).join("");
  sel.value = state.locality;
}
function fillSources() {
  const sel = $("#source");
  if (!sel) return;
  const counts = META.by_source || {};
  sel.innerHTML = `<option value="">All sources</option>` +
    Object.keys(counts).sort().map((s) =>
      `<option value="${esc(s)}">${esc(SOURCE_LABELS[s] || s)} (${counts[s]})</option>`).join("");
  sel.value = state.source;
}
function syncControls() {
  $$("#tabs .tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
  $$("#pills .pill").forEach((b) => b.classList.toggle("active", b.dataset.cat === state.cat));
  $$("#beds .chip").forEach((b) => b.classList.toggle("active", state.beds.has(+b.dataset.beds)));
  $$("[data-badge]").forEach((c) => { c.checked = state.badges.has(c.dataset.badge); });
  $("#q").value = state.q;
  $("#locality").value = state.locality;
  $("#sort").value = state.sort;
  $("#minArea").value = state.minArea;
  $("#maxArea").value = state.maxArea;
  $("#distance").value = state.distance;
  $("#distance").disabled = !state.locality;
  const steps = state.tab === "rent" ? RENT_STEPS : SALE_STEPS;
  fillBudget($("#minBudget"), steps, state.minBudget);
  fillBudget($("#maxBudget"), steps, state.maxBudget);
  $("#minBudget").value = state.minBudget;
  $("#maxBudget").value = state.maxBudget;
}

/* ---------------------------------------------------------------- meta UI */
function paintMeta() {
  const fin = META.last_run && META.last_run.finished_at;
  $("#updated").textContent = fin ? "↻ updated " + timeAgo(fin) : "↻ auto-updates " + (META.site.refresh_note || "daily");
  const c = META.counts || {};
  const lt = META.listing_type_counts || {};
  $("#footStats").innerHTML =
    `<b style="color:#fff">${c.active ?? "—"}</b> active (${lt.sale ?? "—"} sale · ${lt.rent ?? "—"} rent) · ` +
    `<b style="color:#fff">${c.sold ?? 0}</b> auto-marked sold<br>` +
    (fin ? "last cycle: " + esc(String(fin).replace("T", " ").slice(0, 16)) + " IST" : "");
  const areas = (META.localities || []).slice(0, 8);
  $("#areaList").innerHTML = areas.map((l) =>
    `<li>${esc(l.name)} — ${l.count}</li>`).join("") || "<li>Across Jaipur</li>";
}

/* ---------------------------------------------------------------- events */
let qTimer = null;
function bind() {
  $("#tabs").addEventListener("click", (e) => {
    const b = e.target.closest(".tab"); if (!b) return;
    state.tab = b.dataset.tab; state.page = 1;
    syncControls(); render();
  });
  $("#pills").addEventListener("click", (e) => {
    const b = e.target.closest(".pill"); if (!b) return;
    state.cat = b.dataset.cat; state.page = 1; syncControls(); render();
  });
  // A ref code is what a buyer/agent actually has in hand (from a WhatsApp chat
  // or a call). If the query is a ref, jump straight to that property instead of
  // returning "no results" for a text that appears nowhere in the listing.
  $("#q").addEventListener("input", (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      const raw = e.target.value.trim();
      const hit = findByRef(raw);
      if (hit) { state.q = ""; state.page = 1; openModal(hit); return; }
      state.q = raw.toLowerCase(); state.page = 1; render();
    }, 180);
  });
  $("#locality").addEventListener("change", (e) => {
    state.locality = e.target.value;
    $("#distance").disabled = !state.locality;
    if (!state.locality) { state.distance = ""; $("#distance").value = ""; }
    state.page = 1; render();
  });
  $("#distance").addEventListener("change", (e) => { state.distance = e.target.value; state.page = 1; render(); });
  $("#sort").addEventListener("change", (e) => { state.sort = e.target.value; state.page = 1; render(); });
  $("#minBudget").addEventListener("change", (e) => { state.minBudget = e.target.value; state.page = 1; render(); });
  $("#maxBudget").addEventListener("change", (e) => { state.maxBudget = e.target.value; state.page = 1; render(); });
  $("#minArea").addEventListener("input", (e) => { state.minArea = e.target.value; state.page = 1; render(); });
  $("#maxArea").addEventListener("input", (e) => { state.maxArea = e.target.value; state.page = 1; render(); });
  $("#beds").addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    const n = +b.dataset.beds;
    state.beds.has(n) ? state.beds.delete(n) : state.beds.add(n);
    state.page = 1; syncControls(); render();
  });
  $$("[data-badge]").forEach((c) => c.addEventListener("change", () => {
    c.checked ? state.badges.add(c.dataset.badge) : state.badges.delete(c.dataset.badge);
    state.page = 1; render();
  }));
  $("#reset").addEventListener("click", () => {
    Object.assign(state, {
      cat: "all", q: "", minBudget: "", maxBudget: "", minArea: "", maxArea: "",
      locality: "", distance: "", source: "", sort: "new", page: 1,
    });
    state.beds.clear(); state.badges.clear();
    syncControls(); render();
  });
  $("#more").addEventListener("click", () => { state.page++; render(); });
  $("#filterToggle").addEventListener("click", () => $("#filters").classList.toggle("open"));
  $("#grid").addEventListener("click", (e) => {
    const c = e.target.closest(".card"); if (c) openModal(c.dataset.id);
  });
  $("#modalX").addEventListener("click", closeModal);
  $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (LB && !LB.hidden) { closeLightbox(); return; }
      closeModal();
      return;
    }
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const d = e.key === "ArrowRight" ? 1 : -1;
    if (LB && !LB.hidden) { lbShow(LB._i + d); return; }
    const box = $("#modalBody .gal");
    if (box) box.querySelector(d > 0 ? ".g-next" : ".g-prev")?.click();
  });
}

/* ---------------------------------------------------------------- boot */
/* any image that 404s (or the source serves HTML in its place) falls back
   to the branded placeholder instead of a dead gray box */
document.addEventListener("error", (e) => {
  const im = e.target;
  if (im && im.tagName === "IMG" && im.dataset && im.dataset.t) {
    const ph = document.createElement("div");
    ph.className = "ph";
    ph.textContent = im.dataset.t;
    im.replaceWith(ph);
  }
}, true);

async function boot() {
  try {
    const [a, s, m] = await Promise.all([
      fetch("data/listings.json").then((r) => r.json()),
      fetch("data/sold.json").then((r) => r.json()).catch(() => []),
      fetch("data/meta.json").then((r) => r.json()).catch(() => ({})),
    ]);
    ACTIVE = Array.isArray(a) ? a : [];
    SOLD = Array.isArray(s) ? s : [];
    META = m || {};
  } catch (err) {
    $("#count").textContent = "Could not load data — run the scraper first.";
    return;
  }
  // Seller-pushed properties the admin approved. Joined onto ACTIVE so they
  // filter, sort and get a modal for free -- but only AFTER approval, and the
  // seller's number is never in the payload (the leadbox strips it).
  fetch(META?.site?.lead_endpoint + "/listings")
    .then((r) => (r.ok ? r.json() : []))
    .then((own) => {
      if (Array.isArray(own) && own.length) {
        ACTIVE = ACTIVE.concat(own.map(ownCard));
        render(); // the first paint happened before this landed
      }
    })
    .catch(() => {});
  fillLocalities();
  fillSources();
  readHash();
  syncControls();
  paintMeta();
  bind();
  render();
}

// A seller-submitted record in the shape the rest of the UI already expects.
function ownCard(x) {
  return {
    id: x.id,
    title: x.title || `${x.ptype || "Property"} in ${x.locality || "Jaipur"}`,
    locality: x.locality,
    price_display: x.price,
    price: Number(String(x.price || "").replace(/[^\d.]/g, "")) || null,
    area_display: x.area ? x.area + " sq.ft" : null,
    area_sqft: Number(x.area) || null,
    bedrooms: x.beds || null,
    property_type: (x.ptype || "").toLowerCase().replace(/\s+/g, "_"),
    listing_type: x.listingType === "rent" ? "rent" : "sale",
    status: "active",
    images: [],
    source: "seller",
    badges: ["direct"],
    source_url: "",
    is_own: true,
  };
}
boot();
