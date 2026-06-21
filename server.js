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
function getRaw(url) {  // for the temporary /debug endpoint
  return new Promise((resolve, reject) => {
    https.get(url, r => { let b=""; r.on("data",c=>b+=c);
      r.on("end",()=>resolve({ status:r.statusCode, body:b })); }).on("error", reject);
  });
}
function tpUrl(o, d, depart, ret, mode) {
  const dep = mode === "month" ? depart.slice(0,7) : depart;
  const rtn = mode === "month" ? ret.slice(0,7)    : ret;
  const p = new URLSearchParams({ origin:o, destination:d, departure_at:dep, return_at:rtn,
    currency:CFG.currency, market:CFG.market, sorting:"price", limit:"1", one_way:"false", token:CFG.token });
  return "https://api.travelpayouts.com/aviasales/v3/prices_for_dates?" + p.toString();
}
async function fetchPrice(o, d, depart, ret) {
  if (!TOKEN_OK) return { found:false, reason:"no-token" };
  for (const mode of ["exact","month"]) {
    try {
      const json = await getJSON(tpUrl(o,d,depart,ret,mode));
      const it = json && json.success && Array.isArray(json.data) && json.data[0];
      if (it && it.price) {
        const da = (it.departure_at||"").slice(0,10);
        const depDMY = da ? `${da.slice(8,10)}/${da.slice(5,7)}/${da.slice(0,4)}` : "";
        let link = it.link || "";
        if (link && CFG.marker) link += (link.includes("?")?"&":"?") + "marker=" + CFG.marker;
        return { found:true, approx:mode==="month", price:Math.round(it.price),
          currency:(it.currency||CFG.currency).toUpperCase(), airline:it.airline||"",
          depart:depDMY, transfers: (typeof it.transfers==="number"?it.transfers:null),
          duration: (it.duration||null),
          link: link ? "https://www.aviasales.com"+link : "" };
      }
    } catch {}
  }
  return { found:false, reason:"no-data" };
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
  if (u.pathname === "/debug") {   // TEMPORARY diagnostics — remove later
    const o=(u.searchParams.get("origin")||"TLV").toUpperCase();
    const d=(u.searchParams.get("destination")||"ATH").toUpperCase();
    const depart=u.searchParams.get("depart")||"2026-07-01", ret=u.searchParams.get("return")||"2026-07-08";
    const url=tpUrl(o,d,depart,ret,"exact");
    const tk=CFG.token||"";
    let info={ tokenConfigured:TOKEN_OK, market:CFG.market,
      tokenLen:tk.length, tokenHasWhitespace:/\s/.test(tk),
      tokenPreview: tk.length>=6 ? tk.slice(0,3)+"..."+tk.slice(-3) : "(short)" };
    try { const raw=await getRaw(url); info.upstreamStatus=raw.status; info.bodySnippet=raw.body.slice(0,900); }
    catch(e){ info.error=String(e); }
    info.urlSansToken=url.replace(/token=[^&]+/,"token=***");
    res.writeHead(200,{"Content-Type":"application/json"});
    return res.end(JSON.stringify(info));
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
