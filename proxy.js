/* ════════════════════════════════════════════════════════════
   Hipis flight-price proxy
   ────────────────────────────────────────────────────────────
   Why this exists:
     • Travelpayouts/Aviasales API blocks direct browser calls (no CORS).
     • The API token must NOT sit in public client code.
   This tiny Node server (no npm deps) holds the token, calls the API,
   and returns clean JSON to index.html with a permissive CORS header.

   Run:  node proxy.js     (or double-click start_proxy.bat on Windows)
   Config: edit proxy.config.json and paste your token.
   ════════════════════════════════════════════════════════════ */

const http  = require("http");
const https = require("https");
const fs    = require("fs");
const path  = require("path");

/* ── load config ── */
const CFG_PATH = path.join(__dirname, "proxy.config.json");
let CFG = { token: "", marker: "", port: 8787, currency: "ils" };
try { CFG = { ...CFG, ...JSON.parse(fs.readFileSync(CFG_PATH, "utf8")) }; }
catch (e) { console.warn("⚠  proxy.config.json not found/invalid — using defaults. Add your token there."); }

const TOKEN_OK = CFG.token && !/PASTE|YOUR|HERE/i.test(CFG.token);
if (!TOKEN_OK) console.warn("⚠  No valid Travelpayouts token in proxy.config.json — prices will be unavailable until you add one.");

/* ── helper: GET JSON over https ── */
function getJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let body = "";
      res.on("data", c => (body += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, json: null, raw: body }); }
      });
    }).on("error", reject);
  });
}

/* ── build Travelpayouts URL (exact dates or month fallback) ── */
function tpUrl(o, d, depart, ret, mode) {
  const dep = mode === "month" ? depart.slice(0, 7) : depart; // YYYY-MM or YYYY-MM-DD
  const rtn = mode === "month" ? ret.slice(0, 7)    : ret;
  const p = new URLSearchParams({
    origin: o, destination: d,
    departure_at: dep, return_at: rtn,
    currency: CFG.currency, sorting: "price", limit: "1",
    one_way: "false", token: CFG.token,
  });
  return "https://api.travelpayouts.com/aviasales/v3/prices_for_dates?" + p.toString();
}

/* ── fetch cheapest real price for a route ── */
async function fetchPrice(o, d, depart, ret) {
  if (!TOKEN_OK) return { found: false, reason: "no-token" };
  for (const mode of ["exact", "month"]) {
    try {
      const { json } = await getJSON(tpUrl(o, d, depart, ret, mode));
      const item = json && json.success && Array.isArray(json.data) && json.data[0];
      if (item && item.price) {
        const da = (item.departure_at || "").slice(0, 10); // YYYY-MM-DD
        const depDMY = da ? `${da.slice(8,10)}/${da.slice(5,7)}/${da.slice(0,4)}` : "";
        return {
          found: true, approx: mode === "month",
          price: Math.round(item.price),
          currency: (item.currency || CFG.currency).toUpperCase(),
          airline: item.airline || "",
          depart: depDMY,
        };
      }
    } catch (e) { /* try next mode */ }
  }
  return { found: false, reason: "no-data" };
}

/* ── HTTP server ── */
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const u = new URL(req.url, "http://localhost");

  if (u.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, tokenConfigured: TOKEN_OK }));
  }

  if (u.pathname === "/price") {
    const o = (u.searchParams.get("origin")      || "").toUpperCase();
    const d = (u.searchParams.get("destination") || "").toUpperCase();
    const depart = u.searchParams.get("depart") || "";
    const ret    = u.searchParams.get("return") || "";
    if (!o || !d || !depart) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ found: false, reason: "bad-params" }));
    }
    const out = await fetchPrice(o, d, depart, ret);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(out));
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not-found" }));
});

server.listen(CFG.port, () => {
  console.log(`✈  Hipis price proxy running on http://127.0.0.1:${CFG.port}`);
  console.log(`   token configured: ${TOKEN_OK ? "yes" : "NO — add it to proxy.config.json"}`);
});
