const fs = require("fs");
const path = require("path");

const REPORTS_DIR = path.join(__dirname, "reports");
const OUTPUT_FILE = path.join(__dirname, "reports.json");
const FILENAME_RE = /^([A-Z]+)_(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})\.html$/;

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
 * Parse a single report HTML file and return structured metadata.
 * @param {string} filename - e.g. "TSLA_2026-04-14T1342.html"
 * @param {string} html - Full HTML content of the report
 * @returns {object|null} Report metadata object, or null if filename doesn't match
 */
function parseReport(filename, html) {
  const m = filename.match(FILENAME_RE);
  if (!m) return null;

  const [, ticker, date, hh, mm] = m;
  const time = `${hh}:${mm}`;

  const company = extract(html, 'class="company"').replace(/&middot;/g, "\u00B7");
  const price = extract(html, 'class="price"');
  const riskScoreRaw = extract(html, 'class="num"');
  const verdict = extract(html, 'class="verdict"').replace(/\u2014/g, "\u2014");

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

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(reports, null, 2));
  console.log(`Built reports.json — ${reports.length} report(s)`);
}

build();
