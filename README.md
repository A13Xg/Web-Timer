# Web-Timer

Dead-simple static timer app for GitHub Pages.

Routes:
- `/` home launcher
- `/elapsed-timer`
- `/countdown-timer`
- `/world-clock`
- `/pomodoro-timer`

Each route supports URL query params (for example: `/countdown-timer?start_time=10m&alarm=true`).

Notes:
- Fully static (HTML/CSS/JS only), suitable for GitHub Pages hosting.
- All timer settings/preferences are computed client-side and persisted in browser storage (`localStorage`) with a cookie fallback.

## Deploy to GitHub Pages

This repository includes a workflow at `.github/workflows/deploy-pages.yml` that deploys the site on every push to `main`.

To enable deployment:
1. In GitHub, open **Settings → Pages**.
2. Set **Source** to **GitHub Actions**.
3. Push to `main` (or run the workflow manually from the Actions tab).
