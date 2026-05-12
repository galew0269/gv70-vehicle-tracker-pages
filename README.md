# GV70 Lease Tracker — GitHub Pages

A fully static, mobile-friendly dashboard that tracks 2026 Genesis Electrified GV70 lease offers across public sources (Genesis, KBB, TrueCar, Edmunds). The site is built to be served directly from GitHub Pages and refreshed daily by a GitHub Actions workflow.

- **Stack:** plain HTML/CSS/JS, [Chart.js](https://www.chartjs.org/) via CDN, [Satoshi](https://www.fontshare.com/fonts/satoshi) via Fontshare.
- **Data source:** a single JSON file at `feed/gv70_lease_feed.json` consumed by the page over `fetch()`.
- **No build step.** No server. No secrets.
- **Mobile-first:** card-based layout, 48px tap targets, responsive grid via `@media`, and tables that scroll horizontally on small screens and collapse to stacked rows below 480px.

---

## Project layout

```
.
├── index.html                          # Single-page dashboard, loads feed JSON at runtime
├── assets/
│   ├── styles.css                      # Mobile-first responsive CSS (light + dark themes)
│   ├── app.js                          # Feed loader, KPI/chart/table rendering, planner
│   └── favicon.svg                     # Inline SVG favicon
├── feed/
│   └── gv70_lease_feed.json            # Sample/fallback data; updated daily by Actions
├── scripts/
│   └── update_gv70_lease_feed.py       # Updater — robust, stdlib only, never fails the build
├── .github/workflows/
│   └── update-dashboard.yml            # Daily cron + manual dispatch + Pages deploy
├── .nojekyll                           # Tells GitHub Pages not to process via Jekyll
├── .gitignore
└── README.md
```

All asset paths in `index.html` are relative (`./assets/...`, `./feed/...`), so the site works at the repo's root URL **and** under a project subpath (e.g. `https://USER.github.io/REPO/`).

---

## Local preview

GitHub Pages serves static files only — no special tooling required to preview locally. From the project root:

```bash
python3 -m http.server 8000
# then open http://localhost:8000/
```

Tested in Chrome (desktop and Android). The page loads `feed/gv70_lease_feed.json` over `fetch()`, which requires an HTTP origin — opening `index.html` directly via `file://` will not work in Chrome.

---

## Deployment to GitHub Pages

1. **Push the repository to GitHub.** Default branch should be `main`.
2. **Enable Pages.** In *Settings → Pages*, set *Source* to **"GitHub Actions"** (not "Deploy from a branch"). The included workflow uses `actions/deploy-pages@v4` and ships its own artifact.
3. **Push or run the workflow.** Every push to `main`, every daily run, and every manual `workflow_dispatch` will redeploy.

The site URL will be `https://<user>.github.io/<repo>/` (or the configured custom domain).

### Required repository permissions

The workflow is already configured with the minimum scopes it needs:

```yaml
permissions:
  contents: write      # commit refreshed feed back to main
  pages: write         # publish to GitHub Pages
  id-token: write      # OIDC for actions/deploy-pages
```

You only need to verify *Settings → Actions → General → Workflow permissions* allows "Read and write permissions" so the bot commit can be pushed.

**No secrets are required.**

---

## How the daily refresh works

`.github/workflows/update-dashboard.yml`:

1. **Runs daily at 13:30 UTC** via `schedule:` and on-demand via `workflow_dispatch:`. It also runs on pushes to `main` to deploy site changes.
2. **Refreshes the feed** with `python scripts/update_gv70_lease_feed.py`. The step uses `set +e` and `exit 0`, so a partial parser failure cannot fail the workflow.
3. **Commits only if the JSON changed**, using `git diff --quiet`. If a source page shifted and we kept the last-known values, no commit is produced.
4. **Deploys to Pages** using the official `actions/configure-pages`, `actions/upload-pages-artifact`, and `actions/deploy-pages` actions.

### Updater robustness

`scripts/update_gv70_lease_feed.py`:

- Uses only the Python standard library (`urllib`, `re`, `json`) so it works on a vanilla `ubuntu-latest` runner without `pip install`.
- Each source is wrapped in its own `try/except`. A failure in one source never affects the others.
- Validates parsed values against sane bounds (`200–3000 /mo`, `12–60 months`, `0–25000` due) before overwriting the feed.
- If a value is missing, out of range, or unparsable, the script keeps the previous record and flags the source `status: "stale (…)"` so the dashboard surfaces it.
- Writes a `meta.last_run_summary` array into the feed so you can see exactly what happened on the most recent run.
- **Always exits 0**, so the workflow continues to the deploy step regardless of source-page churn.

Run locally:

```bash
python3 scripts/update_gv70_lease_feed.py            # writes feed/gv70_lease_feed.json
python3 scripts/update_gv70_lease_feed.py --dry-run  # prints what would change
```

---

## Customising the feed

`feed/gv70_lease_feed.json` is the source of truth for the dashboard. Hand-edit it any time:

```json
{
  "meta": { "updated_at": "2026-05-12T13:00:00Z", "vehicle": "2026 Genesis Electrified GV70" },
  "offers": [
    { "source": "Genesis", "trim": "Advanced AWD", "type": "Official lease",
      "monthly_payment": 699, "term_months": 24, "due_at_signing": 5999,
      "miles_per_year": 10000, "apr_offer": "Featured factory lease",
      "url": "https://www.genesis.com/us/en/offers/electrified-gv70",
      "status": "active" }
  ],
  "sources": [ /* … */ ]
}
```

To add a new source to the **automated** refresh, edit `SOURCES` near the top of `scripts/update_gv70_lease_feed.py` with `register_source(key, label, url)`. The default parser is regex-based and best-effort; you can pass a custom `parser=` callable that returns `(monthly_payment, term_months, due_at_signing)` for fragile pages.

---

## Mobile and accessibility notes

- `meta viewport` includes `viewport-fit=cover` and the layout respects `env(safe-area-inset-*)` so it works under the Android Chrome URL bar and iPhone safe areas.
- All buttons, inputs, links, and footer-nav items meet a 44–48 px minimum hit target.
- Data tables use horizontal scroll above 480 px and collapse to per-row stacked cards below it, with `data-label` attributes generated in JS for screen readers.
- Theme toggles between light and Nexus-style dark and is seeded from `prefers-color-scheme`. Persistence is intentionally not used because GitHub Pages serves static files without storage requirements and storage APIs are not always available in embedded contexts.
- `prefers-reduced-motion` disables transitions globally.

---

## Things to know / gotchas

- **First load when serving from `file://` will fail** the feed fetch (CORS). Always open over `http://localhost` or the deployed Pages URL.
- **Source pages are scraped via plain HTTP without JavaScript execution.** If a page is fully client-rendered (Edmunds in particular can be), the parser may not find a monthly payment and the previous value will be kept. This is intentional: it keeps the site useful even when a source goes dark.
- The updater **never deletes** offers from the feed — it only updates existing rows. Add/remove rows by hand if needed.
- The workflow commits as `github-actions[bot]` using the runner-provided `GITHUB_TOKEN`. No PAT is needed.
- The cron expression `30 13 * * *` is in UTC. Adjust if you want a different local time.
