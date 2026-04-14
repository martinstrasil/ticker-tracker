const fs = require("fs");
const path = require("path");

const REPORTS_DIR = path.join(__dirname, "reports");
const DIST_DIR = path.join(__dirname, "dist");
/** ISO-style: TICKER_YYYY-MM-DDTHH-MM-SS+ZZZZ.html (CET/UTC offset) */
const FILENAME_RE_ISO =
  /^([A-Z]+)_(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})([+-]\d{2,4})\.html$/;
/** Legacy: TICKER_YYYY-MM-DDTHHmm.html */
const FILENAME_RE_LEGACY = /^([A-Z]+)_(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})\.html$/;

/**
 * Extract text content between an opening tag pattern and its closing tag.
 * @param {string} html - Raw HTML string
 * @param {string} pattern - Regex-safe substring to match inside the opening tag
 * @returns {string} Trimmed inner text, or empty string if not found
 */
function extract(html, pattern) {
  const re = new RegExp(`<[^>]*${pattern}[^>]*>([^<]+)<`, "i");
  const m = html.match(re);
  return m ? m[1].trim() : "";
}

/**
 * Derive trading signal from the verdict line (leading word before the em dash).
 * @param {string} verdict - Full verdict text from the report
 * @returns {"buy"|"hold"|"sell"} Normalized signal, defaulting to hold if unknown
 */
function parseSignal(verdict) {
  const m = verdict.match(/^([A-Za-z]+)/);
  const word = m ? m[1].toUpperCase() : "";
  if (word === "BUY" || word === "HOLD" || word === "SELL") {
    return word.toLowerCase();
  }
  return "hold";
}

const ALLOWED_COLOR_TOKENS = new Set(["green", "amber", "red", "cyan", "blue"]);

/**
 * Read the report CSS token used for the large gauge number (matches child `.gauge-label .num`).
 * @param {string} html - Full report HTML
 * @returns {string} Token name without `--`, e.g. `green`
 */
function extractGaugeNumColorToken(html) {
  const m = html.match(/\.gauge-label\s*\.num\s*\{[^}]*?color:\s*var\(--([a-z0-9-]+)\)/i);
  const token = m ? m[1].toLowerCase() : "amber";
  return ALLOWED_COLOR_TOKENS.has(token) ? token : "amber";
}

/**
 * Read the report CSS token for the bottom-line verdict label (matches child `.rating-bar .verdict`).
 * @param {string} html - Full report HTML
 * @returns {string} Token name without `--`
 */
function extractVerdictBarColorToken(html) {
  const m = html.match(/\.rating-bar\s*\.verdict\s*\{[^}]*?color:\s*var\(--([a-z0-9-]+)\)/i);
  const token = m ? m[1].toLowerCase() : "amber";
  return ALLOWED_COLOR_TOKENS.has(token) ? token : "amber";
}

/**
 * Parse a single report HTML file and return structured metadata.
 * @param {string} filename - e.g. "TSLA_2026-04-14T1342.html"
 * @param {string} html - Full HTML content of the report
 * @returns {object|null} Report metadata object, or null if filename doesn't match
 */
function parseReport(filename, html) {
  const iso = filename.match(FILENAME_RE_ISO);
  const leg = filename.match(FILENAME_RE_LEGACY);
  if (!iso && !leg) return null;

  let ticker;
  let date;
  let time;
  if (iso) {
    const [, t, d, hh, mm, ss] = iso;
    ticker = t;
    date = d;
    time = `${hh}:${mm}:${ss}`;
  } else {
    const [, t, d, hh, mm] = leg;
    ticker = t;
    date = d;
    time = `${hh}:${mm}`;
  }

  const company = extract(html, 'class="company"').replace(/&middot;/g, "\u00B7");
  const price = extract(html, 'class="price"');
  const riskScoreRaw = extract(html, 'class="num"');
  const verdict = extract(html, 'class="verdict"').replace(/\u2014/g, "\u2014");
  const signal = parseSignal(verdict);

  const changeMatch = html.match(/<div class="change\s+(neg|pos)"[^>]*>([^<]+)</i);
  const change = changeMatch ? changeMatch[2].trim() : "";
  const changeDir = changeMatch ? changeMatch[1] : "neg";

  return {
    ticker,
    company,
    date,
    time,
    price,
    change,
    changeDir,
    riskScore: parseInt(riskScoreRaw, 10) || 0,
    verdict,
    signal,
    gaugeNumColor: extractGaugeNumColorToken(html),
    verdictColor: extractVerdictBarColorToken(html),
    file: `reports/${filename}`,
  };
}

function build() {
  const files = fs.readdirSync(REPORTS_DIR).filter((f) => f.endsWith(".html"));
  const reports = [];

  for (const file of files) {
    const html = fs.readFileSync(path.join(REPORTS_DIR, file), "utf-8");
    const meta = parseReport(file, html);
    if (meta) reports.push(meta);
  }

  reports.sort((a, b) => {
    const da = `${a.date}T${a.time}`;
    const db = `${b.date}T${b.time}`;
    return db.localeCompare(da);
  });

  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.mkdirSync(path.join(DIST_DIR, "reports"), { recursive: true });

  fs.writeFileSync(path.join(DIST_DIR, "reports.json"), JSON.stringify(reports, null, 2));
  fs.copyFileSync(path.join(__dirname, "index.html"), path.join(DIST_DIR, "index.html"));

  for (const file of files) {
    fs.copyFileSync(path.join(REPORTS_DIR, file), path.join(DIST_DIR, "reports", file));
  }

  console.log(`Built dist/ — ${reports.length} report(s)`);
}

build();
