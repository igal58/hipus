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

/* ── price API (Travelpayouts / Aviasales) ── */
function getJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, r => { let b=""; r.on("data",c=>b+=c);
      r.on("end",()=>{ try{resolve(JSON.parse(b));}catch{resolve(null);} }); }).on("error", reject);
  });
}
function tpUrl(o, d, depart, ret, mode, limit) {
  const flex = !ret;                                   // no return chosen → flexible round-trip (return open)
  const dep = mode === "month" ? depart.slice(0,7) : depart;
  const params = { origin:o, destination:d, departure_at:dep,
    currency:CFG.currency, market:CFG.market, sorting:"price", limit:String(limit||1), one_way:"false", token:CFG.token };
  if (!flex) params.return_at = mode === "month" ? ret.slice(0,7) : ret;
  return "https://api.travelpayouts.com/aviasales/v3/prices_for_dates?" + new URLSearchParams(params).toString();
}
function mapFare(it, approx, flex) {
  const da = (it.departure_at||"").slice(0,10);
  const ra = (it.return_at||"").slice(0,10);
  const depDMY = da ? `${da.slice(8,10)}/${da.slice(5,7)}/${da.slice(0,4)}` : "";
  let link = it.link || "";
  if (link && CFG.marker) link += (link.includes("?")?"&":"?") + "marker=" + CFG.marker;
  return { approx, flex, price:Math.round(it.price),
    currency:(it.currency||CFG.currency).toUpperCase(), airline:it.airline||"",
    depart:depDMY, departISO:da, returnISO:ra,
    transfers:(typeof it.transfers==="number"?it.transfers:null), duration:(it.duration||null),
    departTime:(it.departure_at||"").slice(11,16), returnTime:(it.return_at||"").slice(11,16),
    link: link ? "https://www.aviasales.com"+link : "" };
}
/* several DISTINCT real fares (varied airline / price / times) for one route */
async function fetchOffers(o, d, depart, ret) {
  if (!TOKEN_OK) return { offers:[], reason:"no-token" };
  const flex = !ret;
  for (const mode of ["exact","month"]) {
    try {
      const json = await getJSON(tpUrl(o,d,depart,ret,mode,30));
      const arr = json && json.success && Array.isArray(json.data) ? json.data : [];
      if (arr.length) {
        const seen = new Set(); const offers = [];
        for (const it of arr) {
          if (!it || !it.price) continue;
          const key = `${it.airline}|${it.price}|${(it.departure_at||"").slice(0,16)}|${(it.return_at||"").slice(0,16)}`;
          if (seen.has(key)) continue; seen.add(key);
          offers.push(mapFare(it, mode==="month", flex));
          if (offers.length >= 6) break;
        }
        if (offers.length) { offers.sort((a,b)=>a.price-b.price); return { offers, flex }; }
      }
    } catch {}
  }
  return { offers:[], reason:"no-data" };
}
async function fetchPrice(o, d, depart, ret) {
  if (!TOKEN_OK) return { found:false, reason:"no-token" };
  for (const mode of ["exact","month"]) {
    try {
      const json = await getJSON(tpUrl(o,d,depart,ret,mode));
      const it = json && json.success && Array.isArray(json.data) && json.data[0];
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
function tpLatestUrl(origin) {
  const p = new URLSearchParams({ origin, currency:CFG.currency, market:CFG.market,
    sorting:"price", limit:"60", one_way:"false", token:CFG.token });
  return "https://api.travelpayouts.com/v2/prices/latest?" + p.toString();
}
async function fetchDeals(origin) {
  if (!TOKEN_OK) return { deals:[], reason:"no-token" };
  try {
    const json = await getJSON(tpLatestUrl(origin));
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
function tpCalendarUrl(o, d, month) {
  const p = new URLSearchParams({ origin:o, destination:d, departure_at:month,
    currency:CFG.currency, market:CFG.market, group_by:"departure_at", token:CFG.token });
  return "https://api.travelpayouts.com/aviasales/v3/grouped_prices?" + p.toString();
}
async function fetchCalendar(o, d, month) {
  if (!TOKEN_OK) return { days:[], reason:"no-token" };
  try {
    const json = await getJSON(tpCalendarUrl(o, d, month));
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
    const out = await fetchPrice(o,d,depart,ret);
    res.writeHead(200,{"Content-Type":"application/json"});
    return res.end(JSON.stringify(out));
  }
  if (u.pathname === "/offers") {
    const o=(u.searchParams.get("origin")||"").toUpperCase();
    const d=(u.searchParams.get("destination")||"").toUpperCase();
    const depart=u.searchParams.get("depart")||"", ret=u.searchParams.get("return")||"";
    if (!o||!d||!depart) { res.writeHead(400,{"Content-Type":"application/json"});
      return res.end(JSON.stringify({offers:[],reason:"bad-params"})); }
    const out = await fetchOffers(o,d,depart,ret);
    res.writeHead(200,{"Content-Type":"application/json"});
    return res.end(JSON.stringify(out));
  }
  if (u.pathname === "/calendar") {
    const o=(u.searchParams.get("origin")||"").toUpperCase();
    const d=(u.searchParams.get("destination")||"").toUpperCase();
    const month=u.searchParams.get("month")||"";
    if (!o||!d||!month) { res.writeHead(400,{"Content-Type":"application/json"});
      return res.end(JSON.stringify({days:[],reason:"bad-params"})); }
    const out = await fetchCalendar(o,d,month);
    res.writeHead(200,{"Content-Type":"application/json"});
    return res.end(JSON.stringify(out));
  }
  if (u.pathname === "/deals") {
    const o = (u.searchParams.get("origin") || "TLV").toUpperCase();
    const out = await fetchDeals(o);
    res.writeHead(200, {"Content-Type":"application/json"});
    return res.end(JSON.stringify(out));
  }
  return serveStatic(req, res);   // everything else → static files (index.html, etc.)
});

server.listen(CFG.port, () => {
  const url = `http://localhost:${CFG.port}`;
  console.log(`✈  Hipis running on ${url}`);
  console.log(`   token configured: ${TOKEN_OK ? "yes" : "NO — set TP_TOKEN or edit proxy.config.json"}`);
  if (!IS_CLOUD && process.platform === "win32") {
    exec(`start "" ${url}`);   // open the browser automatically on local Windows
  }
});
