# Ticker Tracker

Static dashboard for stock risk analysis reports, deployed on Cloudflare Pages.

## Usage

1. Drop a report HTML file into `reports/` using the naming convention `TICKER_YYYY-MM-DDTHHMM.html`
2. Run `npm run build` to generate the manifest
3. Open `index.html` to browse reports

## Deploy

Connect the repo to Cloudflare Pages with:

- **Build command:** `npm run build`
- **Output directory:** `/`

Every push auto-deploys.
