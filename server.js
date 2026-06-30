/* ════════════════════════════════════════════════════════════
   Hipis flight search — unified server
   ────────────────────────────────────────────────────────────
   ONE server that:
     • serves the website (index.html and any static files)
     • serves the price API (/price) from the SAME origin → no CORS
   Works both locally (double-click הפעל.bat) and in the cloud
   (Render / Railway / Replit / Glitch / Fly — any Node host).

   Token resolution order (cloud-safe — keep secrets out of code):
     1. process.env.TP_TOKEN     ← use this in the cloud (a "secret")
     2. proxy.config.json        ← convenient for local use
   Same for the affiliate marker: TP_MARKER, then proxy.config.json.
   ════════════════════════════════════════════════════════════ */

const http  = require("http");
const https = require("https");
const fs    = require("fs");
const path  = require("path");
const { exec } = require("child_process");

/* ── config (file is optional; env vars win) ── */
let FILE_CFG = {};
try { FILE_CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "proxy.config.json"), "utf8")); } catch {}
const CFG = {
  token:    process.env.TP_TOKEN   || FILE_CFG.token   || "",
  marker:   process.env.TP_MARKER  || FILE_CFG.marker  || "",
  currency: process.env.TP_CURRENCY|| FILE_CFG.currency|| "ils",
  market:   process.env.TP_MARKET  || FILE_CFG.market  || "il",  // force IL market so cloud servers get Israeli fares
  port:     process.env.PORT       || FILE_CFG.port    || 8787,
};
const IS_CLOUD = !!process.env.PORT;                       // most hosts set PORT
const TOKEN_OK = CFG.token && !/PASTE|YOUR|HERE/i.test(CFG.token);

/* ── static file serving ── */
const MIME = { ".html":"text/html; charset=utf-8", ".js":"text/javascript",
  ".css":"text/css", ".json":"application/json", ".png":"image/png",
  ".jpg":"image/jpeg", ".svg":"image/svg+xml", ".ico":"image/x-icon" };
function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  const file = path.join(__dirname, path.normalize(rel));
  if (!file.startsWith(__dirname)) { res.writeHead(403); return res.end("forbidden"); }
  // never serve secrets
  if (/proxy\.config\.json$/i.test(file)) { res.writeHead(404); return res.end("not found"); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, {"Content-Type":"text/plain"}); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  });
}

/* ── price API (Travelpayouts / Aviasales) ──
   robust fetch: never hangs (timeout), never rejects (resolves null), and
   retries transient failures — this is why a search used to need several
   Enter/F5 presses before it returned. */
function fetchOnce(url, timeoutMs) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    const req = https.get(url, r => {
      let b = ""; r.on("data", c => b += c);
      r.on("end", () => { try { finish(JSON.parse(b)); } catch { finish(null); } });
    });
    req.on("error", () => finish(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); finish(null); });
  });
}
async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const r = await fetchOnce(url, 12000);
    if (r && r.success !== false) return r;                 // good response (incl. legit empty data)
    if (i < tries - 1) await new Promise(s => setTimeout(s, 350 * (i + 1)));  // brief backoff, then retry
  }
  return null;                                              // gave up after retries — caller falls back gracefully
}
const ALLOWED_CUR = ["ils","usd","eur"];
function curOf(v){ v=(v||"").toLowerCase(); return ALLOWED_CUR.includes(v) ? v : CFG.currency; }
function stopsOf(v){ const n=parseInt(v,10); return (Number.isFinite(n)&&n>=0&&n<=9) ? n : 9; }  // מקס׳ עצירות (ברירת מחדל 9 = ללא הגבלה מעשית)
function tpUrl(o, d, depart, ret, mode, limit, cur) {
  const flex = !ret;                                   // no return chosen → flexible round-trip (return open)
  const dep = mode === "month" ? depart.slice(0,7) : depart;
  const params = { origin:o, destination:d, departure_at:dep,
    currency:(cur||CFG.currency), market:CFG.market, sorting:"price", limit:String(limit||1), one_way:"false", token:CFG.token };
  if (!flex) params.return_at = mode === "month" ? ret.slice(0,7) : ret;
  return "https://api.travelpayouts.com/aviasales/v3/prices_for_dates?" + new URLSearchParams(params).toString();
}
/* חילוץ קודי שדה התעופה של מסלול הטיסה מתוך ה-link של Aviasales.
   הפרמטר t= מקודד את רצף השדות כרצף אותיות (TLVFCOMUC = TLV→FCO→MUC).
   מחזיר {out:[...iata], back:[...iata]} (לפי הסדר הופעה). אין נתון → null. */
function parseRoute(link) {
  try {
    const m = /[?&]t=([^&]+)/.exec(link || ""); if (!m) return null;
    const runs = (m[1].match(/[A-Z]{6,}/g) || []).filter(s => s.length % 3 === 0);
    const split = s => s.match(/.{3}/g) || [];
    return { out: runs[0] ? split(runs[0]) : null, back: runs[1] ? split(runs[1]) : null };
  } catch { return null; }
}
/* חניות-ביניים מאומתות: רק אם נקודות הקצה והכמות תואמות ל-transfers (אחרת null — לא ממציאים). */
function stopsFromRoute(seq, first, last, count) {
  if (!seq || seq.length < 2) return null;
  if (seq[0] !== first || seq[seq.length-1] !== last) return null;
  const inter = seq.slice(1, -1);
  if (inter.length !== (typeof count === "number" ? count : 0)) return null;
  return inter;
}
function mapFare(it, approx, flex) {
  const da = (it.departure_at||"").slice(0,10);
  const ra = (it.return_at||"").slice(0,10);
  const depDMY = da ? `${da.slice(8,10)}/${da.slice(5,7)}/${da.slice(0,4)}` : "";
  let link = it.link || "";
  const route = parseRoute(it.link);
  const oA = it.origin_airport||it.origin||"", dA = it.destination_airport||it.destination||"";
  const stopsTo  = route ? stopsFromRoute(route.out,  oA, dA, it.transfers)        : null;
  const stopsBack = route ? stopsFromRoute(route.back, dA, oA, it.return_transfers) : null;
  if (link && CFG.marker) link += (link.includes("?")?"&":"?") + "marker=" + CFG.marker;
  return { approx, flex, price:Math.round(it.price),
    currency:(it.currency||CFG.currency).toUpperCase(), airline:it.airline||"",
    dest: dA,                                            // שדה הנחיתה בפועל (לחיפוש ברדיוס — יכול להיות יעד סמוך)
    depart:depDMY, departISO:da, returnISO:ra,
    transfers:(typeof it.transfers==="number"?it.transfers:null), duration:(it.duration||null),
    returnTransfers:(typeof it.return_transfers==="number"?it.return_transfers:null),
    stopsTo: stopsTo, stopsBack: stopsBack,
    departAt:(it.departure_at||""), durationTo:(typeof it.duration_to==="number"?it.duration_to:null),  // ל-ETA נחיתה ביעד
    departTime:(it.departure_at||"").slice(11,16), returnTime:(it.return_at||"").slice(11,16),
    link: link ? "https://www.aviasales.com"+link : "" };
}
/* several DISTINCT real fares (varied airline / price / times) for one route.
   מטרה: לפחות ~10 טיסות אמיתיות לתקופה הנבחרת. צוברים ממספר שאילתות (תאריך מדויק
   → כל החודש → גמיש), מנקים כפילויות, ומחזירים עד TARGET. כל מקור = Travelpayouts אמיתי. */
async function fetchOffers(o, d, depart, ret, cur, maxStops) {
  if (!TOKEN_OK) return { offers:[], reason:"no-token" };
  const flex = !ret; const mx = (maxStops==null?9:maxStops);
  const TARGET = 12;
  const seen = new Set(); const offers = [];
  const add = (arr, isMonth) => {
    for (const it of arr) {
      if (!it || !it.price) continue;
      if ((it.departure_at||"").slice(0,10) < depart) continue;             // only fares on/after the chosen departure date
      if (((typeof it.transfers==="number")?it.transfers:0) > mx) continue; // max stops filter
      const key = `${it.airline}|${it.price}|${(it.departure_at||"").slice(0,16)}|${(it.return_at||"").slice(0,16)}`;
      if (seen.has(key)) continue; seen.add(key);
      offers.push(mapFare(it, isMonth, flex));
    }
  };
  const pull = async (qRet, mode) => {
    try { const json = await getJSON(tpUrl(o, d, depart, qRet, mode, 100, cur));
      return json && json.success && Array.isArray(json.data) ? json.data : []; }
    catch { return []; }
  };
  // 1) תאריכים מדויקים + כל החודש (=התקופה) — במקביל למהירות
  const [exactArr, monthArr] = await Promise.all([ pull(ret, "exact"), pull(ret, "month") ]);
  add(exactArr, false); add(monthArr, true);
  // 2) עדיין דל ויש תאריך חזרה? משלימים בחיפוש גמיש (חזרה פתוחה) — מרחיב את המלאי לתקופה
  if (offers.length < TARGET && ret) add(await pull("", "month"), true);
  if (offers.length) { offers.sort((a,b)=>a.price-b.price); return { offers: offers.slice(0, TARGET), flex }; }
  return { offers:[], reason:"no-data" };
}

/* ── חיפוש ברדיוס: גם שדות תעופה סמוכים ליעד (עד N ק"מ) ──
   נתוני שדות התעופה (קואורדינטות) מ-Travelpayouts data, נטענים פעם אחת ל-cache. */
let _AIRPORTS = null, _airportsAt = 0;
function loadAirports() {
  if (_AIRPORTS && Date.now() - _airportsAt < 24*3600*1000) return Promise.resolve(_AIRPORTS);
  return new Promise(resolve => {
    https.get("https://api.travelpayouts.com/data/en/airports.json", r => {
      let b = ""; r.on("data", c => b += c);
      r.on("end", () => { try { _AIRPORTS = JSON.parse(b); _airportsAt = Date.now(); } catch { _AIRPORTS = _AIRPORTS || []; } resolve(_AIRPORTS); });
    }).on("error", () => resolve(_AIRPORTS || []))
      .setTimeout(12000, function(){ this.destroy(); resolve(_AIRPORTS || []); });
  });
}
function haversineKm(a, b) {
  const R = 6371, toR = x => x*Math.PI/180;
  const dLat = toR(b.lat-a.lat), dLon = toR(b.lon-a.lon);
  const s = Math.sin(dLat/2)**2 + Math.cos(toR(a.lat))*Math.cos(toR(b.lat))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.min(1, Math.sqrt(s)));
}
async function nearbyDests(destIata, radiusKm, max) {
  const air = await loadAirports();
  if (!Array.isArray(air) || !air.length) return [];
  const home = air.find(x => x.code === destIata && x.coordinates);
  if (!home) return [];
  const out = [];
  for (const x of air) {
    if (!x || !x.coordinates || x.flightable === false) continue;
    if (x.code !== x.city_code) continue;                                              // רק שדה ראשי של עיר (מסנן שדות משניים/צבאיים)
    if (x.code === destIata || x.city_code === (home.city_code||destIata)) continue;   // לא היעד עצמו / אותה עיר
    if (home.country_code && x.country_code !== home.country_code) continue;            // אותה מדינה (מונע באגי-קואורדינטות חוצי-יבשות במקור)
    const km = haversineKm(home.coordinates, x.coordinates);
    if (km <= radiusKm) out.push({ iata:x.code, city:(x.name_translations&&x.name_translations.en)||x.name||x.code, km:Math.round(km) });
  }
  out.sort((a,b)=>a.km-b.km);
  const seenCity = new Set(); const picked = [];   // עיר אחת לכל יעד סמוך
  for (const c of out) { const cc=c.iata.slice(0,3); if (seenCity.has(cc)) continue; seenCity.add(cc); picked.push(c); if (picked.length>=max) break; }
  return picked;
}
/* שליפה קלה ליעד סמוך — שאילתה אחת (חודש) בלבד, מהיר */
async function fetchOffersLite(o, d, depart, ret, cur, maxStops, max) {
  if (!TOKEN_OK) return [];
  const flex = !ret; const mx = (maxStops==null?9:maxStops);
  try {
    const json = await getJSON(tpUrl(o, d, depart, ret, "month", 60, cur));
    const arr = json && json.success && Array.isArray(json.data) ? json.data : [];
    const seen = new Set(); const offers = [];
    for (const it of arr) {
      if (!it || !it.price) continue;
      if ((it.departure_at||"").slice(0,10) < depart) continue;
      if (((typeof it.transfers==="number")?it.transfers:0) > mx) continue;
      const key = `${it.airline}|${it.price}|${(it.departure_at||"").slice(0,16)}`;
      if (seen.has(key)) continue; seen.add(key);
      offers.push(mapFare(it, true, flex));
      if (offers.length >= (max||4)) break;
    }
    return offers;
  } catch { return []; }
}
/* יעד ראשי + שדות סמוכים ברדיוס. מחזיר {offers, flex, nearby:[{iata,city,km}]}.
   הצעות ראשיות קודם (destKm=0), אחריהן הסמוכות (מתויגות עם מרחק+עיר). */
async function fetchOffersRadius(o, d, depart, ret, cur, maxStops, radiusKm) {
  const primary = await fetchOffers(o, d, depart, ret, cur, maxStops);
  const base = (primary.offers || []).map(x => (x.destKm = 0, x.dest = x.dest || d, x));
  const flex = primary.flex != null ? primary.flex : !ret;
  if (!radiusKm || radiusKm <= 0) return { offers: base, flex };
  const near = await nearbyDests(d, radiusKm, 8);
  const lists = await Promise.all(near.map(n => fetchOffersLite(o, n.iata, depart, ret, cur, maxStops, 3)));
  const extra = [];
  near.forEach((n, i) => { for (const of of lists[i]) { of.destKm = n.km; of.destCity = n.city; of.dest = of.dest || n.iata; extra.push(of); } });
  extra.sort((a,b)=> a.destKm!==b.destKm ? a.destKm-b.destKm : a.price-b.price);
  return { offers: [...base, ...extra].slice(0, 30), flex, nearby: near };
}

async function fetchPrice(o, d, depart, ret, cur, maxStops) {
  if (!TOKEN_OK) return { found:false, reason:"no-token" };
  const mx = (maxStops==null?9:maxStops);
  for (const mode of ["exact","month"]) {
    try {
      const json = await getJSON(tpUrl(o,d,depart,ret,mode,30,cur));   // fetch many (sorted by price) so we can pick the cheapest on/after the date
      const arr = json && json.success && Array.isArray(json.data) ? json.data : [];
      const it = arr.find(x => x && x.price && (x.departure_at||"").slice(0,10) >= depart
        && (((typeof x.transfers==="number")?x.transfers:0) <= mx));  // cheapest on/after the date within max stops
      if (it && it.price) {
        const da = (it.departure_at||"").slice(0,10);
        const ra = (it.return_at||"").slice(0,10);
        const depDMY = da ? `${da.slice(8,10)}/${da.slice(5,7)}/${da.slice(0,4)}` : "";
        let link = it.link || "";
        if (link && CFG.marker) link += (link.includes("?")?"&":"?") + "marker=" + CFG.marker;
        return { found:true, approx:mode==="month", flex:!ret, price:Math.round(it.price),
          currency:(it.currency||CFG.currency).toUpperCase(), airline:it.airline||"",
          depart:depDMY, departISO:da, returnISO:ra,           // ISO dates so the client can rebuild deep-links / fill the form
          transfers: (typeof it.transfers==="number"?it.transfers:null),
          duration: (it.duration||null),
          departTime: (it.departure_at||"").slice(11,16),   // local "HH:MM" of outbound flight
          returnTime: (it.return_at||"").slice(11,16),      // local "HH:MM" of return flight
          link: link ? "https://www.aviasales.com"+link : "" };
      }
    } catch {}
  }
  return { found:false, reason:"no-data" };
}

/* ── "secret flights" — cheapest fares from an origin to anywhere ── */
function tpLatestUrl(origin, cur) {
  const p = new URLSearchParams({ origin, currency:(cur||CFG.currency), market:CFG.market,
    sorting:"price", limit:"60", one_way:"false", token:CFG.token });
  return "https://api.travelpayouts.com/v2/prices/latest?" + p.toString();
}
async function fetchDeals(origin, cur) {
  if (!TOKEN_OK) return { deals:[], reason:"no-token" };
  try {
    const json = await getJSON(tpLatestUrl(origin, cur));
    if (json && json.success && Array.isArray(json.data)) {
      const seen = new Set(); const out = [];
      for (const it of json.data) {
        if (!it.destination || !it.value || seen.has(it.destination)) continue;
        seen.add(it.destination);
        out.push({ dest:it.destination, price:Math.round(it.value),
          depart:it.depart_date || "", ret:it.return_date || "" });
      }
      out.sort((a,b)=>a.price-b.price);
      return { deals: out.slice(0, 18) };
    }
  } catch {}
  return { deals:[], reason:"no-data" };
}

/* ── price calendar — cheapest fare per departure day in a month ── */
function tpCalendarUrl(o, d, month, cur) {
  const p = new URLSearchParams({ origin:o, destination:d, departure_at:month,
    currency:(cur||CFG.currency), market:CFG.market, group_by:"departure_at",
    one_way:"false", token:CFG.token });   // round-trip — matches the main search (was one-way → mismatched prices)
  return "https://api.travelpayouts.com/aviasales/v3/grouped_prices?" + p.toString();
}
async function fetchCalendar(o, d, month, cur) {
  if (!TOKEN_OK) return { days:[], reason:"no-token" };
  try {
    const json = await getJSON(tpCalendarUrl(o, d, month, cur));
    const data = json && json.success && json.data && typeof json.data === "object" ? json.data : null;
    if (data) {
      const days = [];
      for (const date of Object.keys(data)) {
        const it = data[date];
        if (!it || !it.price) continue;
        let link = it.link || "";
        if (link && CFG.marker) link += (link.includes("?")?"&":"?") + "marker=" + CFG.marker;
        days.push({ date, price:Math.round(it.price), airline:it.airline||"",
          transfers:(typeof it.transfers==="number"?it.transfers:null),
          link: link ? "https://www.aviasales.com"+link : "" });
      }
      days.sort((a,b)=> a.date < b.date ? -1 : 1);
      if (days.length) return { days, cheapest: Math.min(...days.map(x=>x.price)) };
    }
  } catch {}
  return { days:[], reason:"no-data" };
}

/* ── חיפוש גמיש רב-חודשי — הזול ביותר בכל אחד מהחודשים הקרובים (לימי שהייה=0) ── */
async function fetchFlexMonths(o, d, fromDate, monthsCount, cur) {
  if (!TOKEN_OK) return { months:[], reason:"no-token" };
  const n = Math.min(Math.max(monthsCount||4, 1), 6);          // 1–6 חודשים
  const baseY = Number(fromDate.slice(0,4)), baseM = Number(fromDate.slice(5,7));
  const out = [];
  for (let i = 0; i < n; i++) {
    const dt = new Date(baseY, baseM - 1 + i, 1);
    const month = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}`;
    const minDate = i === 0 ? fromDate : month + "-01";         // החודש הראשון: רק מתאריך היציאה והלאה
    try {
      const json = await getJSON(tpCalendarUrl(o, d, month, cur));
      const data = json && json.success && json.data && typeof json.data === "object" ? json.data : null;
      let best = null;
      if (data) for (const date of Object.keys(data)) {
        if (date < minDate) continue;
        const it = data[date];
        if (!it || !it.price) continue;
        if (!best || it.price < best.price) {
          let link = it.link || "";
          if (link && CFG.marker) link += (link.includes("?")?"&":"?") + "marker=" + CFG.marker;
          best = { month, date, price:Math.round(it.price), airline:it.airline||"",
            transfers:(typeof it.transfers==="number"?it.transfers:null),
            link: link ? "https://www.aviasales.com"+link : "" };
        }
      }
      if (best) out.push(best);
    } catch {}
  }
  if (!out.length) return { months:[], reason:"no-data" };
  const cheapest = Math.min(...out.map(x=>x.price));
  return { months: out, cheapest };
}

/* ════════════════════════════════════════════════════════════
   🔔 התראות מחיר (MVP) — אחסון בקובץ + שליחת מייל דרך Resend
   ────────────────────────────────────────────────────────────
   הגדרות סביבה (env) הנדרשות בענן:
     RESEND_API_KEY  ← מפתח Resend (חינמי). בלעדיו → מצב "dry-run" (לא שולח, רק מדווח מה היה נשלח)
     ALERT_FROM      ← כתובת השולח המאומתת ב-Resend (ברירת מחדל: onboarding@resend.dev)
     CRON_KEY        ← סוד שמגן על /check-alerts (ה-cron החיצוני חייב לשלוח ?key=...)
   ⚠️ אחסון בקובץ alerts.json הוא ארעי ב-Render חינמי (נמחק בכל deploy/קור-סטארט).
      לפרודקשן יציב: לעבור לאחסון חיצוני (Upstash/DB). ראה _המשך_מכאן.md.
   ════════════════════════════════════════════════════════════ */
const ALERTS_FILE = path.join(__dirname, "alerts.json");
const RESEND_KEY  = process.env.RESEND_API_KEY || "";
const ALERT_FROM  = process.env.ALERT_FROM     || "Hipus <onboarding@resend.dev>";
const CRON_KEY    = process.env.CRON_KEY        || "";
const EMAIL_RE    = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function loadAlerts() { try { return JSON.parse(fs.readFileSync(ALERTS_FILE, "utf8")); } catch { return []; } }
function saveAlerts(arr) { try { fs.writeFileSync(ALERTS_FILE, JSON.stringify(arr, null, 2)); return true; } catch { return false; } }
function genId() { return "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function readBody(req) { return new Promise(resolve => { let b=""; req.on("data",c=>b+=c);
  req.on("end",()=>{ try{resolve(JSON.parse(b||"{}"));}catch{resolve({});} }); req.on("error",()=>resolve({})); }); }

function httpsPostJSON(urlStr, headers, bodyObj) {
  return new Promise(resolve => {
    const data = JSON.stringify(bodyObj);
    const u = new URL(urlStr);
    const r = https.request({ hostname:u.hostname, path:u.pathname+u.search, method:"POST",
      headers: Object.assign({ "Content-Type":"application/json", "Content-Length":Buffer.byteLength(data) }, headers) },
      resp => { let b=""; resp.on("data",c=>b+=c); resp.on("end",()=>{ let j=null; try{j=JSON.parse(b);}catch{}
        resolve({ status:resp.statusCode, json:j }); }); });
    r.on("error", e => resolve({ status:0, error:String(e) }));
    r.write(data); r.end();
  });
}
async function sendEmail(to, subject, html) {
  if (!RESEND_KEY) return { sent:false, dryRun:true, to, subject };       // בלי מפתח → לא שולחים, רק מדווחים
  const r = await httpsPostJSON("https://api.resend.com/emails",
    { "Authorization":"Bearer " + RESEND_KEY }, { from:ALERT_FROM, to:[to], subject, html });
  return { sent: r.status>=200 && r.status<300, status:r.status, id:(r.json&&r.json.id)||null };
}
/* בודק את כל ההתראות הפעילות מול מחיר חי; אם מחיר ≤ יעד → שולח מייל וכבה את ההתראה (one-shot, בלי ספאם) */
async function runAlertCheck() {
  const alerts = loadAlerts();
  const results = []; let changed = false;
  for (const a of alerts) {
    if (!a || a.active === false) { continue; }
    const out = await fetchPrice(a.origin, a.destination, a.depart, a.ret || "", a.cur || "ils");
    const price = (out && out.found) ? out.price : null;
    const sym = out && out.currency ? out.currency : (a.cur||"ILS").toUpperCase();
    if (price != null && price <= a.target) {
      const dates = `${a.depart}${a.ret?` – ${a.ret}`:""}`;
      const subject = `${a.origin}->${a.destination} — ${price} ${sym} (target ${a.target} ${sym})`;
      const html = `<div dir="auto" style="font-family:Arial,sans-serif;max-width:520px">
        <h2 style="margin:0 0 8px">🎉 נמצא מחיר מתחת ליעד שלך!</h2>
        <p style="margin:4px 0">מסלול: <b>${a.origin} → ${a.destination}</b></p>
        <p style="margin:4px 0">תאריכים: ${dates}</p>
        <p style="margin:4px 0;font-size:20px"><b>${price} ${out.currency||"ILS"}</b>
           <span style="color:#888;font-size:14px"> (היעד שלך: ${a.target} ${sym})</span>${out.airline?` · ${out.airline}`:""}</p>
        ${out.link?`<p style="margin:12px 0"><a href="${out.link}" style="background:#0ea5e9;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">לרכישה ב-Aviasales ←</a></p>`:""}
        <p style="color:#999;font-size:12px;margin-top:16px">Hipus — התראת מחיר</p></div>`;
      const mail = await sendEmail(a.email, subject, html);
      results.push({ id:a.id, email:a.email, price, target:a.target, triggered:true, mail });
      if (mail.sent) { a.active=false; a.notifiedAt=new Date().toISOString(); a.lastPrice=price; changed=true; }  // dry-run נשאר פעיל לבדיקות
    } else {
      results.push({ id:a.id, triggered:false, price, target:a.target });
    }
  }
  if (changed) saveAlerts(alerts);
  return { checked: alerts.length, dryRun: !RESEND_KEY, results };
}

/* ════════════════════════════════════════════════════════════
   ✈ ייבוא מקישור Google Flights / Explore
   ────────────────────────────────────────────────────────────
   מקבל URL של Google Flights, מפענח את הפרמטר tfs (ולעיתים tfu) —
   פרוטובאף בקידוד base64url שבתוכו תאריכים (ASCII "YYYY-MM-DD") ומזהי
   ישויות של Google Knowledge Graph ("/m/...") למוצא/יעד. ממיר כל מזהה
   לקוד IATA דרך Wikidata (P646=Freebase MID → P238=IATA / שדה-תעופה
   שמשרת את העיר ב-P931). יושר: לא ממציאים — מזהה שלא נפתר מסומן ב-warning.
   ════════════════════════════════════════════════════════════ */
function b64urlToBuf(s) {
  s = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  try { return Buffer.from(s, "base64"); } catch { return Buffer.alloc(0); }
}
/* חילוץ מדויק של מיקומים מ-protobuf: שדה string (tag 0x12) שאורכו נתון בבית שאחריו.
   ערך תקין = מזהה Google ("/m/...") או קוד IATA ישיר (3 אותיות גדולות). תאריכים מסוננים החוצה. */
function extractLocations(buf) {
  const out = [];
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] !== 0x12) continue;                 // tag: field 2, wire type 2 (length-delimited string)
    const L = buf[i + 1];
    if (L < 3 || L > 24 || i + 2 + L > buf.length) continue;
    const val = buf.slice(i + 2, i + 2 + L).toString("latin1");
    if (/^\/m\/[0-9a-z_]+$/.test(val)) { out.push({ key: val, type: "mid",  value: val }); i += 1 + L; }
    else if (/^[A-Z]{3}$/.test(val))   { out.push({ key: val, type: "iata", value: val }); i += 1 + L; }
  }
  return out;
}
function fetchJSONUA(url, timeoutMs = 12000) {        // כמו fetchOnce אבל עם User-Agent (Wikidata חוסם בלי UA)
  return new Promise(resolve => {
    let done = false; const finish = v => { if (!done) { done = true; resolve(v); } };
    const req = https.get(url, { headers: {
      "User-Agent": "FlyFinder/1.0 (flight search; igal58@gmail.com)",
      "Accept": "application/sparql-results+json" } }, r => {
      let b = ""; r.on("data", c => b += c);
      r.on("end", () => { try { finish(JSON.parse(b)); } catch { finish(null); } });
    });
    req.on("error", () => finish(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); finish(null); });
  });
}
async function resolveMids(mids) {                    // {mid} → {mid:{label,iatas:[]}}
  const out = {};
  for (const m of mids) out[m] = { label: "", iatas: [] };
  if (!mids.length) return out;
  const values = mids.map(m => `"${m}"`).join(" ");
  const q = `SELECT ?mid ?label ?iata WHERE {`
    + ` VALUES ?mid { ${values} } ?item wdt:P646 ?mid.`
    + ` OPTIONAL { ?item rdfs:label ?label. FILTER(LANG(?label)="en") }`
    + ` OPTIONAL { { ?item wdt:P238 ?iata } UNION { ?ap wdt:P931 ?item; wdt:P238 ?iata. ?ap wdt:P31/wdt:P279* wd:Q1248784. } } }`;
  const url = "https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q);
  const json = await fetchJSONUA(url);
  const rows = (json && json.results && json.results.bindings) || [];
  for (const b of rows) {
    const mid = b.mid && b.mid.value; if (!mid || !out[mid]) continue;
    if (b.label && b.label.value && !out[mid].label) out[mid].label = b.label.value;
    const ia = b.iata && b.iata.value;
    if (ia && /^[A-Z]{3}$/.test(ia) && !out[mid].iatas.includes(ia)) out[mid].iatas.push(ia);
  }
  return out;
}
async function parseGFlights(gurl) {
  let tfs = "", tfu = "";
  try { const u = new URL(gurl); tfs = u.searchParams.get("tfs") || ""; tfu = u.searchParams.get("tfu") || ""; }
  catch { const mt = /[?&]tfs=([^&]+)/.exec(gurl); if (mt) tfs = decodeURIComponent(mt[1]);
          const mu = /[?&]tfu=([^&]+)/.exec(gurl); if (mu) tfu = decodeURIComponent(mu[1]); }
  if (!tfs) return { ok: false, reason: "no-tfs" };
  const bufTfs = b64urlToBuf(tfs), bufTfu = b64urlToBuf(tfu);
  const dates = [...new Set((bufTfs.toString("latin1").match(/\d{4}-\d{2}-\d{2}/g) || []))].sort();  // depart=earliest, return=next
  const locs = [...extractLocations(bufTfs), ...extractLocations(bufTfu)];        // ordered: leg1 origin, leg1 dest, ...
  const midsToResolve = [...new Set(locs.filter(l => l.type === "mid").map(l => l.value))];
  const resolved = await resolveMids(midsToResolve);
  const info = l => l.type === "iata" ? { label: l.value, iatas: [l.value] }
                                      : (resolved[l.value] || { label: "", iatas: [] });
  const warnings = [];
  const origin = locs.length ? info(locs[0]) : { label: "", iatas: [] };
  const originKey = locs.length ? locs[0].key : "";
  // destination: first location after the origin that resolves to a real airport (skip the origin itself).
  // handles plain round-trips [A,B,B,A] → B, and Explore URLs [TLV,IN,IN,TLV,Mumbai] → Mumbai.
  let destination = { label: "", iatas: [] };
  for (const l of locs.slice(1)) {
    if (l.key === originKey) continue;             // never pick the origin as the destination
    const r = info(l);
    if (r.iatas.length) { destination = r; break; }
    if (!destination.label && r.label) destination = r;   // keep a label even with no airport (for the warning)
  }
  if (!origin.iatas.length) warnings.push("origin-unresolved");
  if (!destination.iatas.length) warnings.push("destination-unresolved");
  return { ok: true, depart: dates[0] || "", ret: dates[1] || "", dates,
    origin: { label: origin.label, iatas: origin.iatas },
    destination: { label: destination.label, iatas: destination.iatas }, warnings };
}

/* ── HTTP server ── */
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");   // harmless; same-origin anyway
  const u = new URL(req.url, "http://localhost");

  if (u.pathname === "/health") {
    res.writeHead(200, {"Content-Type":"application/json"});
    return res.end(JSON.stringify({ ok:true, tokenConfigured:TOKEN_OK, cloud:IS_CLOUD }));
  }
  if (u.pathname === "/price") {
    const o=(u.searchParams.get("origin")||"").toUpperCase();
    const d=(u.searchParams.get("destination")||"").toUpperCase();
    const depart=u.searchParams.get("depart")||"", ret=u.searchParams.get("return")||"";
    if (!o||!d||!depart) { res.writeHead(400,{"Content-Type":"application/json"});
      return res.end(JSON.stringify({found:false,reason:"bad-params"})); }
    const out = await fetchPrice(o,d,depart,ret,curOf(u.searchParams.get("cur")),stopsOf(u.searchParams.get("stops")));
    res.writeHead(200,{"Content-Type":"application/json"});
    return res.end(JSON.stringify(out));
  }
  if (u.pathname === "/offers") {
    const o=(u.searchParams.get("origin")||"").toUpperCase();
    const d=(u.searchParams.get("destination")||"").toUpperCase();
    const depart=u.searchParams.get("depart")||"", ret=u.searchParams.get("return")||"";
    if (!o||!d||!depart) { res.writeHead(400,{"Content-Type":"application/json"});
      return res.end(JSON.stringify({offers:[],reason:"bad-params"})); }
    const radius = Math.min(Math.max(parseInt(u.searchParams.get("radius"),10)||0, 0), 2000);  // ק"מ סביב היעד (0=כבוי)
    const out = await fetchOffersRadius(o,d,depart,ret,curOf(u.searchParams.get("cur")),stopsOf(u.searchParams.get("stops")),radius);
    res.writeHead(200,{"Content-Type":"application/json"});
    return res.end(JSON.stringify(out));
  }
  if (u.pathname === "/calendar") {
    const o=(u.searchParams.get("origin")||"").toUpperCase();
    const d=(u.searchParams.get("destination")||"").toUpperCase();
    const month=u.searchParams.get("month")||"";
    if (!o||!d||!month) { res.writeHead(400,{"Content-Type":"application/json"});
      return res.end(JSON.stringify({days:[],reason:"bad-params"})); }
    const out = await fetchCalendar(o,d,month,curOf(u.searchParams.get("cur")));
    res.writeHead(200,{"Content-Type":"application/json"});
    return res.end(JSON.stringify(out));
  }
  /* 🔔 יצירת התראת מחיר */
  if (u.pathname === "/alerts" && req.method === "POST") {
    const b = await readBody(req);
    const email=(b.email||"").trim();
    const origin=(b.origin||"").toUpperCase(), destination=(b.destination||"").toUpperCase();
    const depart=(b.depart||"").trim(), ret=(b.ret||"").trim();
    const target=Math.round(Number(b.target)||0);
    const cur=curOf(b.cur);
    if (!EMAIL_RE.test(email)||!origin||!destination||!depart||target<=0) {
      res.writeHead(400,{"Content-Type":"application/json"});
      return res.end(JSON.stringify({ok:false,reason:"bad-params"})); }
    const alerts = loadAlerts();
    const alert = { id:genId(), email, origin, destination, depart, ret, target,
      cur, currency:cur.toUpperCase(), active:true, created:new Date().toISOString() };
    alerts.push(alert); saveAlerts(alerts);
    res.writeHead(200,{"Content-Type":"application/json"});
    return res.end(JSON.stringify({ok:true,id:alert.id}));
  }
  /* רשימת ההתראות של מייל מסוים (לניהול) */
  if (u.pathname === "/alerts" && req.method === "GET") {
    const email=(u.searchParams.get("email")||"").trim();
    if (!EMAIL_RE.test(email)) { res.writeHead(400,{"Content-Type":"application/json"});
      return res.end(JSON.stringify({alerts:[],reason:"bad-email"})); }
    const mine = loadAlerts().filter(a=>a.email===email)
      .map(a=>({id:a.id,origin:a.origin,destination:a.destination,depart:a.depart,ret:a.ret,target:a.target,active:a.active}));
    res.writeHead(200,{"Content-Type":"application/json"});
    return res.end(JSON.stringify({alerts:mine}));
  }
  /* מחיקת התראה (לפי id + אימות מייל) */
  if (u.pathname === "/alerts/delete") {
    const id=(u.searchParams.get("id")||"").trim(), email=(u.searchParams.get("email")||"").trim();
    let alerts=loadAlerts(); const before=alerts.length;
    alerts=alerts.filter(a=>!(a.id===id && a.email===email));
    saveAlerts(alerts);
    res.writeHead(200,{"Content-Type":"application/json"});
    return res.end(JSON.stringify({ok:true,removed:before-alerts.length}));
  }
  /* בדיקת כל ההתראות (מופעל ע"י cron חיצוני) — מוגן ב-CRON_KEY אם מוגדר */
  if (u.pathname === "/check-alerts") {
    if (CRON_KEY && u.searchParams.get("key")!==CRON_KEY) { res.writeHead(403,{"Content-Type":"application/json"});
      return res.end(JSON.stringify({ok:false,reason:"forbidden"})); }
    const out = await runAlertCheck();
    res.writeHead(200,{"Content-Type":"application/json"});
    return res.end(JSON.stringify(out));
  }
  if (u.pathname === "/flexmonths") {
    const o=(u.searchParams.get("origin")||"").toUpperCase();
    const d=(u.searchParams.get("destination")||"").toUpperCase();
    const from=u.searchParams.get("from")||"";
    const months=Number(u.searchParams.get("months"))||4;
    if (!o||!d||!from) { res.writeHead(400,{"Content-Type":"application/json"});
      return res.end(JSON.stringify({months:[],reason:"bad-params"})); }
    const out = await fetchFlexMonths(o,d,from,months,curOf(u.searchParams.get("cur")));
    res.writeHead(200,{"Content-Type":"application/json"});
    return res.end(JSON.stringify(out));
  }
  if (u.pathname === "/parse-gflights") {
    const gurl = u.searchParams.get("url") || "";
    if (!gurl) { res.writeHead(400,{"Content-Type":"application/json"});
      return res.end(JSON.stringify({ok:false,reason:"no-url"})); }
    const out = await parseGFlights(gurl);
    res.writeHead(200,{"Content-Type":"application/json"});
    return res.end(JSON.stringify(out));
  }
  if (u.pathname === "/deals") {
    const o = (u.searchParams.get("origin") || "TLV").toUpperCase();
    const out = await fetchDeals(o,curOf(u.searchParams.get("cur")));
    res.writeHead(200, {"Content-Type":"application/json"});
    return res.end(JSON.stringify(out));
  }
  return serveStatic(req, res);   // everything else → static files (index.html, etc.)
});

/* ── מתזמן פנימי — בודק התראות אוטומטית כל כמה שעות (רץ בזמן שהשרת ער) ──
   ⚠️ ב-Render חינמי השרת נרדם ללא תנועה, אז הטיימר לא ירוץ בזמן שינה.
      הפתרון המלא לבדיקה גם בלי מסך: GitHub Action מתוזמן (.github/workflows/price-alerts.yml)
      שמעיר את השרת כל 3 שעות וקורא ל-/check-alerts. גם self-ping מונע שינה כשיש RENDER_EXTERNAL_URL. */
const CHECK_HOURS = Number(process.env.CHECK_HOURS) || 6;
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || "";
function startSchedulers() {
  setInterval(() => {
    runAlertCheck().then(r => console.log(`[alerts] auto-check: ${r.checked} alert(s), dryRun=${r.dryRun}`)).catch(()=>{});
  }, CHECK_HOURS * 3600 * 1000);
  if (SELF_URL) {                                  // self-ping כל ~13 דק' כדי לצמצם שינה (best-effort)
    setInterval(() => { https.get(SELF_URL.replace(/\/$/,"") + "/health", r=>r.resume()).on("error",()=>{}); }, 13 * 60 * 1000);
  }
}

server.listen(CFG.port, () => {
  const url = `http://localhost:${CFG.port}`;
  console.log(`✈  Hipis running on ${url}`);
  console.log(`   token configured: ${TOKEN_OK ? "yes" : "NO — set TP_TOKEN or edit proxy.config.json"}`);
  if (IS_CLOUD) { startSchedulers(); console.log(`   schedulers on: alert check every ${CHECK_HOURS}h${SELF_URL?", self-ping on":""}`); }
  if (!IS_CLOUD && process.platform === "win32") {
    exec(`start "" ${url}`);   // open the browser automatically on local Windows
  }
});
