const fs = require("fs");
const path = require("path");

const REPORTS_DIR = path.join(__dirname, "reports");
const DIST_DIR = path.join(__dirname, "dist");

/** Root font size in px (was 14px; bumped ~2pt for readability). */
const REPORT_ROOT_FONT_PX = 16;
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

/**
 * Pull ticker prefix from a report filename.
 * @param {string} filename - e.g. `TSLA_2026-04-14T1342.html`
 * @returns {string} Uppercase ticker or empty string
 */
function extractTickerFromFilename(filename) {
  const m = filename.match(/^([A-Z]+)_/);
  return m ? m[1] : "";
}

/**
 * Normalize report time to HH:MM:SS for lexicographic sort with date.
 * @param {string} time - e.g. `13:42` or `21:22:56`
 * @returns {string} `HH:MM:SS`
 */
function normalizeTimeForSort(time) {
  const raw = String(time || "0:0:0")
    .split(":")
    .map((p) => String(p).replace(/\D/g, "").slice(0, 2));
  const hh = (raw[0] || "00").padStart(2, "0");
  const mm = (raw[1] || "00").padStart(2, "0");
  const ss = (raw[2] || "00").padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/**
 * Sortable instant key (ISO-like, lexicographic).
 * @param {{ date: string; time: string; file: string }} meta - Report row
 * @returns {string} Sort key
 */
function chronologicalSortKey(meta) {
  return `${meta.date}T${normalizeTimeForSort(meta.time)}|${meta.file}`;
}

/**
 * Compare two report metadata objects: newest first.
 * @param {{ date: string; time: string; file: string }} a - First report
 * @param {{ date: string; time: string; file: string }} b - Second report
 * @returns {number} Comparator result
 */
function compareReportsNewestFirst(a, b) {
  return chronologicalSortKey(b).localeCompare(chronologicalSortKey(a));
}

/**
 * Escape text for safe HTML insertion.
 * @param {string} s - Raw string
 * @returns {string} Escaped string
 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Map color token to CSS `var(--token)`.
 * @param {string|undefined} token - Theme token name
 * @param {string} fallback - Default token
 * @returns {string} CSS `var(...)` value
 */
function cssColorVar(token, fallback) {
  const t = typeof token === "string" && ALLOWED_COLOR_TOKENS.has(token.toLowerCase()) ? token.toLowerCase() : fallback;
  return `var(--${t})`;
}

/**
 * Basename of a report path (`reports/TICKER_....html` → `TICKER_....html`).
 * @param {string} filePath - Manifest `file` field
 * @returns {string} Filename only
 */
function reportBasename(filePath) {
  return path.basename(filePath);
}

/**
 * Build SVG polyline chart for risk score over time (oldest → newest).
 * @param {Array<{ date: string; time: string; riskScore: number }>} ascending - Chronological rows
 * @returns {string} SVG markup
 */
function buildRiskScoreChartSvg(ascending) {
  const W = 880;
  const H = 240;
  const padL = 52;
  const padR = 28;
  const padT = 32;
  const padB = 52;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const n = ascending.length;
  if (n === 0) {
    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><text x="50%" y="50%" text-anchor="middle" fill="var(--text-muted)" font-family="var(--sans)" font-size="14">No chart data</text></svg>`;
  }
  const xAt = (i) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const yAt = (score) => padT + (1 - Math.min(100, Math.max(0, score)) / 100) * innerH;
  const pts = ascending.map((r, i) => `${xAt(i).toFixed(1)},${yAt(r.riskScore).toFixed(1)}`).join(" ");
  const circles = ascending
    .map((r, i) => {
      const cx = xAt(i).toFixed(1);
      const cy = yAt(r.riskScore).toFixed(1);
      return `<circle cx="${cx}" cy="${cy}" r="5" fill="var(--surface3)" stroke="var(--blue)" stroke-width="2"/>`;
    })
    .join("");
  const labels = ascending
    .map((r, i) => {
      const short = r.date.slice(5).replace("-", "/");
      const x = xAt(i);
      return `<text x="${x.toFixed(1)}" y="${H - 14}" text-anchor="middle" fill="var(--text-muted)" font-family="var(--mono)" font-size="11">${escapeHtml(short)}</text>`;
    })
    .join("");
  const line =
    n > 1
      ? `<polyline fill="none" stroke="var(--blue)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" points="${pts}"/>`
      : "";
  const yTicks = [0, 25, 50, 75, 100].map((v) => {
    const y = yAt(v).toFixed(1);
    return `<text x="${padL - 10}" y="${y}" text-anchor="end" dominant-baseline="middle" fill="var(--text-muted)" font-family="var(--mono)" font-size="11">${v}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Risk score over time"><rect x="${padL}" y="${padT}" width="${innerW}" height="${innerH}" fill="var(--surface2)" rx="6"/>${yTicks.join("")}${line}${circles}${labels}</svg>`;
}

/**
 * Render verdict dot strip (same idea as dashboard tiles).
 * @param {number} score - Risk score 0–100
 * @returns {string} HTML
 */
function verdictDotsHtml(score) {
  const filled = Math.round(score / 10);
  let html = '<div class="rh-verdict-dots">';
  for (let i = 0; i < 10; i++) {
    let cls = "";
    if (i < filled) {
      if (i < 4) cls = "r";
      else if (i < 7) cls = "a";
      else cls = "g";
    }
    html += `<span class="rh-verdict-dot ${cls}"></span>`;
  }
  html += "</div>";
  return html;
}

/**
 * Build a single tile (dashboard-style) for the latest report.
 * @param {object} r - Report metadata
 * @param {string} currentBasename - Filename of the page being built
 * @returns {string} HTML
 */
function buildLatestTileHtml(r, currentBasename) {
  const href = reportBasename(r.file);
  const numColor = cssColorVar(r.gaugeNumColor, "amber");
  const verdictTone = cssColorVar(r.verdictColor ?? r.gaugeNumColor, "amber");
  const changeClass = r.changeDir === "pos" ? "pos" : "neg";
  const isCurrent = href === currentBasename;
  const inner = `
    <div class="rh-tile-header">
      <span class="rh-tile-ticker">${escapeHtml(r.ticker)}</span>
      <span class="rh-tile-company">${escapeHtml(r.company)}</span>
      <span class="rh-tile-date">${escapeHtml(r.date)} ${escapeHtml(r.time)}</span>
    </div>
    <div class="rh-tile-body">
      <div class="rh-tile-gauge"><span class="rh-gauge-val" style="color:${numColor}">${r.riskScore}</span></div>
      <div class="rh-tile-metrics">
        <div class="rh-tile-row"><span class="rh-label">Price</span><span class="rh-value">${escapeHtml(r.price)}</span></div>
        <div class="rh-tile-row"><span class="rh-label">Change</span><span class="rh-value ${changeClass}">${escapeHtml(r.change)}</span></div>
      </div>
    </div>
    <div class="rh-tile-verdict">
      ${verdictDotsHtml(r.riskScore)}
      <span class="rh-verdict-text" style="color:${verdictTone}">${escapeHtml(r.verdict)}</span>
    </div>`;
  if (isCurrent) {
    return `<div class="rh-tile rh-tile-current" aria-current="page">${inner}</div>`;
  }
  return `<a class="rh-tile" href="${escapeHtml(href)}">${inner}</a>`;
}

/**
 * Build list rows for older reports (excludes the first / newest row).
 * @param {object[]} olderNewestFirst - Reports after the latest
 * @param {string} currentBasename - Active report filename
 * @returns {string} HTML
 */
function buildOlderReportsListHtml(olderNewestFirst, currentBasename) {
  if (olderNewestFirst.length === 0) {
    return `<p class="rh-empty">No older reports for this ticker.</p>`;
  }
  const rows = olderNewestFirst
    .map((r) => {
      const href = reportBasename(r.file);
      const active = href === currentBasename ? " rh-row-current" : "";
      const numColor = cssColorVar(r.gaugeNumColor, "amber");
      return `<a class="rh-row${active}" href="${escapeHtml(href)}">
        <span class="rh-row-date">${escapeHtml(r.date)} ${escapeHtml(r.time)}</span>
        <span class="rh-row-score" style="color:${numColor}">${r.riskScore}</span>
        <span class="rh-row-verdict">${escapeHtml(r.verdict)}</span>
      </a>`;
    })
    .join("");
  return `<div class="rh-list">${rows}</div>`;
}

/**
 * CSS block for injected history + chart sections.
 * @returns {string} HTML style element
 */
function historySectionStyles() {
  return `<style id="report-history-injected">
  .report-history{margin-top:40px;padding-top:28px;border-top:1px solid var(--border)}
  .report-history h3.rh-title{font-size:.82rem;text-transform:uppercase;letter-spacing:.12em;color:var(--text-muted);margin-bottom:14px}
  .rh-chart-box{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px 24px 12px;margin-bottom:28px;overflow:hidden}
  .rh-chart-box svg{width:100%;height:auto;display:block;max-height:280px}
  .rh-subtitle{font-size:.78rem;color:var(--text-muted);margin:-8px 0 16px}
  .rh-tile{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:22px 24px;margin-bottom:20px;text-decoration:none;color:inherit;display:block;position:relative;overflow:hidden;transition:border-color .2s,transform .2s}
  .rh-tile:hover{border-color:var(--border-light);transform:translateY(-2px)}
  .rh-tile-current{border-color:var(--blue);cursor:default;transform:none}
  .rh-tile-current::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--blue),transparent)}
  .rh-tile-header{display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap}
  .rh-tile-ticker{font-family:var(--mono);font-size:1.3rem;font-weight:700;letter-spacing:-.02em}
  .rh-tile-company{font-size:.82rem;color:var(--text-muted);flex:1;min-width:120px}
  .rh-tile-date{font-family:var(--mono);font-size:.75rem;color:var(--text-muted);white-space:nowrap}
  .rh-tile-body{display:flex;align-items:center;gap:20px}
  .rh-tile-gauge{min-width:52px;flex-shrink:0;display:flex;align-items:center;justify-content:center}
  .rh-gauge-val{font-family:var(--mono);font-size:1.45rem;font-weight:700;line-height:1}
  .rh-tile-metrics{flex:1;display:flex;flex-direction:column;gap:8px}
  .rh-tile-row{display:flex;justify-content:space-between;align-items:center;gap:12px}
  .rh-label{font-size:.78rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em}
  .rh-value{font-family:var(--mono);font-size:.88rem;font-weight:500}
  .rh-value.neg{color:var(--red)}.rh-value.pos{color:var(--green)}
  .rh-tile-verdict{margin-top:14px;padding-top:12px;border-top:1px solid var(--border);display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .rh-verdict-dots{display:flex;gap:2px}
  .rh-verdict-dot{width:6px;height:6px;border-radius:50%;background:var(--surface2)}
  .rh-verdict-dot.r{background:var(--red)}.rh-verdict-dot.a{background:var(--amber)}.rh-verdict-dot.g{background:var(--green)}
  .rh-verdict-text{font-family:var(--mono);font-size:.78rem;font-weight:600;letter-spacing:.04em}
  .rh-list{display:flex;flex-direction:column;gap:8px}
  .rh-row{display:grid;grid-template-columns:160px 52px 1fr;gap:14px;align-items:center;padding:12px 16px;background:var(--surface);border:1px solid var(--border);border-radius:10px;text-decoration:none;color:inherit;transition:border-color .15s}
  .rh-row:hover{border-color:var(--border-light)}
  .rh-row-current{border-color:var(--blue);background:var(--surface2)}
  .rh-row-date{font-family:var(--mono);font-size:.78rem;color:var(--text-dim)}
  .rh-row-score{font-family:var(--mono);font-size:.9rem;font-weight:700;text-align:right}
  .rh-row-verdict{font-size:.82rem;color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .rh-empty{font-size:.88rem;color:var(--text-muted);padding:12px 0}
  @media(max-width:800px){.rh-row{grid-template-columns:1fr;gap:6px}}
  </style>`;
}

/**
 * Inject chart + history into report HTML for dist output.
 * @param {string} html - Source report HTML
 * @param {string} filename - Report filename
 * @param {object[]} allReports - Parsed manifest rows
 * @returns {string} Transformed HTML
 */
function injectReportHistory(html, filename, allReports) {
  const ticker = extractTickerFromFilename(filename);
  const currentBasename = filename;
  const sameTicker = allReports.filter((r) => r.ticker === ticker).sort(compareReportsNewestFirst);
  const ascending = [...sameTicker].sort((a, b) => chronologicalSortKey(a).localeCompare(chronologicalSortKey(b)));
  const latest = sameTicker[0];
  const older = sameTicker.slice(1);
  const chartSvg = buildRiskScoreChartSvg(ascending);
  const tileBlock = latest ? buildLatestTileHtml(latest, currentBasename) : `<p class="rh-empty">No reports for ${escapeHtml(ticker)} in the manifest.</p>`;
  const listBlock = latest ? buildOlderReportsListHtml(older, currentBasename) : "";
  const block = `${historySectionStyles()}
<div class="report-history" data-ticker="${escapeHtml(ticker)}">
  <h3 class="rh-title">Risk score over time</h3>
  <p class="rh-subtitle">Based on all reports for ${escapeHtml(ticker)} in this deployment, oldest to newest left to right.</p>
  <div class="rh-chart-box">${chartSvg}</div>
  <h3 class="rh-title">Report history</h3>
  <p class="rh-subtitle">Latest report (by report timestamp) is highlighted as a tile. Open older snapshots below.</p>
  ${tileBlock}
  ${listBlock}
</div>`;
  const anchorRe = /<button[^>]*\bclass="copy-btn"[^>]*>/i;
  if (anchorRe.test(html)) {
    return html.replace(anchorRe, `${block}\n$&`);
  }
  return html.replace("</body>", `${block}\n</body>`);
}

/**
 * Bump root font size in report HTML.
 * @param {string} html - Report HTML
 * @returns {string} Updated HTML
 */
function bumpReportRootFont(html) {
  return html.replace(/html\{font-size:\s*14px\}/g, `html{font-size:${REPORT_ROOT_FONT_PX}px}`);
}

/**
 * Add a fixed tray with a link to the dashboard next to the copy button.
 * @param {string} html - Report HTML
 * @returns {string} Updated HTML
 */
function injectReportRootNav(html) {
  if (html.includes("report-actions-fixed")) {
    return html;
  }
  const trayCss = `<style id="report-root-nav-injected">
  .report-actions-fixed{position:fixed;bottom:24px;right:24px;display:flex;flex-direction:row;flex-wrap:wrap;gap:10px;justify-content:flex-end;align-items:center;z-index:100}
  .report-actions-fixed .copy-btn{position:static}
  .report-root-btn{background:var(--surface2);border:1px solid var(--border-light);color:var(--text-dim);font-family:var(--mono);font-size:.75rem;padding:10px 18px;border-radius:8px;text-decoration:none;transition:background .2s,border-color .2s,color .2s;cursor:pointer}
  .report-root-btn:hover{background:var(--blue);color:#fff;border-color:var(--blue)}
  </style>`;
  const copyBtnRe = /<button([^>]*\bclass="copy-btn"[^>]*)>([\s\S]*?)<\/button>/i;
  if (!copyBtnRe.test(html)) {
    return html;
  }
  const replaced = html.replace(
    copyBtnRe,
    `<div class="report-actions-fixed"><a class="report-root-btn" href="../index.html" title="Back to all reports">All reports</a><button$1>$2</button></div>`
  );
  if (replaced.includes("report-root-nav-injected")) {
    return replaced;
  }
  return replaced.replace("</head>", `${trayCss}\n</head>`);
}

function build() {
  const files = fs.readdirSync(REPORTS_DIR).filter((f) => f.endsWith(".html"));
  const reports = [];

  for (const file of files) {
    const html = fs.readFileSync(path.join(REPORTS_DIR, file), "utf-8");
    const meta = parseReport(file, html);
    if (meta) reports.push(meta);
  }

  reports.sort(compareReportsNewestFirst);

  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.mkdirSync(path.join(DIST_DIR, "reports"), { recursive: true });

  fs.writeFileSync(path.join(DIST_DIR, "reports.json"), JSON.stringify(reports, null, 2));
  fs.copyFileSync(path.join(__dirname, "index.html"), path.join(DIST_DIR, "index.html"));

  for (const file of files) {
    const srcPath = path.join(REPORTS_DIR, file);
    const raw = fs.readFileSync(srcPath, "utf-8");
    const transformed = injectReportRootNav(injectReportHistory(bumpReportRootFont(raw), file, reports));
    fs.writeFileSync(path.join(DIST_DIR, "reports", file), transformed, "utf-8");
  }

  console.log(`Built dist/ — ${reports.length} report(s)`);
}

build();
