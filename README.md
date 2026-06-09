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
