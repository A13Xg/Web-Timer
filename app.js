const app = document.getElementById('app');
const settingsPanel = document.getElementById('settingsPanel');
const settingsToggle = document.getElementById('settingsToggle');
const alarmToggle = document.getElementById('alarmToggle');
const keepAwakeToggle = document.getElementById('keepAwakeToggle');
const modeToggle = document.getElementById('modeToggle');
const themeSelect = document.getElementById('themeSelect');

const STORAGE_KEY = 'web_timer_state_v1';
const COOKIE_KEY = 'web_timer_state';

themeSelect.classList.add('theme-select');

const routes = {
  '/': { name: 'Home' },
  '/elapsed-timer': { name: 'Elapsed Timer' },
  '/countdown-timer': { name: 'Countdown Timer' },
  '/world-clock': { name: 'World Clock' },
  '/pomodoro-timer': { name: 'Pomodoro Timer' }
};

const state = {
  base_path: '',
  route: '/',
  timer_name: 'My Timer',
  color: '#276ef1',
  start_time: '',
  stop_time: '',
  timezone: 'UTC',
  focus_min: '25',
  break_min: '5',
  alarm: false,
  keep_awake: false,
  mode: 'light',
  theme: 'default',
  fullscreen: false
};

const serializableKeys = [
  'route', 'timer_name', 'color', 'start_time', 'stop_time', 'timezone',
  'focus_min', 'break_min', 'alarm', 'keep_awake', 'mode', 'theme'
];

let wakeLock = null;
let wakeIntervalId = null;
let ticking = null;
let wakeVisibilityBound = false;
let wakeLockRequestPromise = null;
let audioCtx = null;

function parseDuration(raw) {
  if (!raw) return 0;
  const match = String(raw).trim().match(/^(\d+)([smhd])?$/i);
  if (!match) return Number(raw) || 0;
  const n = Number(match[1]);
  const u = (match[2] || 's').toLowerCase();
  if (u === 'm') return n * 60;
  if (u === 'h') return n * 3600;
  if (u === 'd') return n * 86400;
  return n;
}

function formatSeconds(total) {
  if (typeof total !== 'number' || !isFinite(total)) return '00:00:00';
  const s = Math.max(0, Math.floor(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((v) => String(v).padStart(2, '0')).join(':');
}

function esc(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function parseCookieState() {
  const raw = document.cookie
    .split('; ')
    .find((row) => row.startsWith(`${COOKIE_KEY}=`));
  if (!raw) return null;
  try {
    return JSON.parse(decodeURIComponent(raw.split('=').slice(1).join('=')));
  } catch {
    return null;
  }
}

function readStateFromStorage() {
  let persisted = null;
  try {
    const fromStorage = localStorage.getItem(STORAGE_KEY);
    persisted = fromStorage ? JSON.parse(fromStorage) : null;
  } catch {
    persisted = null;
  }
  if (!persisted) persisted = parseCookieState();
  if (!persisted) return;

  serializableKeys.forEach((k) => {
    if (persisted[k] !== undefined) state[k] = persisted[k];
  });
}

function persistState() {
  const payload = {};
  serializableKeys.forEach((k) => {
    payload[k] = state[k];
  });

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // ignore quota/privacy mode limitations
  }

  document.cookie = `${COOKIE_KEY}=${encodeURIComponent(JSON.stringify(payload))}; Max-Age=31536000; Path=/; SameSite=Lax`;
}

function extractRouteFromPath(pathname) {
  const clean = pathname.replace(/\/index\.html$/, '').replace(/\/$/, '') || '/';
  const namedRoutes = Object.keys(routes).filter((r) => r !== '/').sort((a, b) => b.length - a.length);

  for (const route of namedRoutes) {
    if (clean === route || clean.endsWith(route)) {
      const basePath = clean === route ? '' : clean.slice(0, -route.length);
      return { route, basePath };
    }
  }

  return { route: '/', basePath: clean === '/' ? '' : clean };
}

function routeAndParams() {
  const search = new URLSearchParams(location.search);
  const fromRouteParam = search.get('route');
  const pathInfo = extractRouteFromPath(location.pathname);
  const path = routes[fromRouteParam] ? fromRouteParam : pathInfo.route;

  const amp = location.pathname.includes('&') ? location.pathname.split('&').slice(1).join('&') : '';
  const inlineParams = new URLSearchParams(amp);
  for (const [k, v] of inlineParams.entries()) {
    if (!search.has(k)) search.set(k, v);
  }

  return { path, params: search, basePath: pathInfo.basePath };
}

function buildPath(route) {
  const base = state.base_path || '';
  if (route === '/') return `${base}/`.replace(/\/\/+/, '/');
  return `${base}${route}`.replace(/\/\/+/, '/');
}

function syncUrl() {
  const url = new URL(location.href);
  url.pathname = buildPath(state.route);
  url.search = '';

  serializableKeys.forEach((k) => {
    const v = state[k];
    if (k === 'route') return;
    if (v !== '' && v !== false && v !== 'default' && !(k === 'mode' && v === 'light')) {
      url.searchParams.set(k, v);
    }
  });

  history.replaceState(null, '', url);
  persistState();
}

function readStateFromUrl() {
  const { path, params, basePath } = routeAndParams();
  state.route = routes[path] ? path : '/';
  state.base_path = basePath;

  serializableKeys.forEach((k) => {
    if (params.has(k)) {
      state[k] = params.get(k);
    }
  });

  state.alarm = String(state.alarm) === 'true';
  state.keep_awake = String(state.keep_awake) === 'true';
  state.mode = state.mode === 'dark' ? 'dark' : 'light';
  state.theme = themeSelect.querySelector(`option[value="${state.theme}"]`) ? state.theme : 'default';
}

function renderNav() {
  return `
    <div class="home-list card">
      <h1>Web Timer</h1>
      <button data-route="/elapsed-timer">Elapsed Timer</button>
      <button data-route="/countdown-timer">Countdown Timer</button>
      <button data-route="/world-clock">World Clock</button>
      <button data-route="/pomodoro-timer">Pomodoro Timer</button>
    </div>`;
}

function renderControls() {
  const isCountdown = state.route === '/countdown-timer';
  const isElapsed = state.route === '/elapsed-timer';
  const isWorld = state.route === '/world-clock';
  const isPomodoro = state.route === '/pomodoro-timer';

  let extra = '';
  if (isElapsed) {
    extra = `
      <label>Start Time<input data-key="start_time" type="datetime-local" value="${esc(state.start_time)}" /></label>
      <label>Stop Time<input data-key="stop_time" type="datetime-local" value="${esc(state.stop_time)}" /></label>`;
  } else if (isCountdown) {
    extra = `
      <label>Start Time<input data-key="start_time" type="text" placeholder="10m" value="${esc(state.start_time || '10m')}" /></label>
      <label>Stop Time<input data-key="stop_time" type="datetime-local" value="${esc(state.stop_time)}" /></label>`;
  } else if (isWorld) {
    extra = `
      <label>Timezone
        <select data-key="timezone">
          ${['UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo', 'Australia/Sydney'].map((tz) => `<option ${state.timezone === tz ? 'selected' : ''} value="${tz}">${tz}</option>`).join('')}
        </select>
      </label>
      <label>Start Time<input disabled type="text" value="N/A" /></label>`;
  } else if (isPomodoro) {
    extra = `
      <label>Start Time<input data-key="focus_min" type="number" min="1" value="${esc(state.focus_min)}" /></label>
      <label>Stop Time<input data-key="break_min" type="number" min="1" value="${esc(state.break_min)}" /></label>`;
  }

  return `
    <section class="top-controls">
      <div class="card controls-grid">
        <label>Timer Name<input data-key="timer_name" type="text" value="${esc(state.timer_name)}" /></label>
        <label>Color<input data-key="color" type="color" value="${esc(state.color)}" /></label>
        ${extra}
      </div>
    </section>`;
}

function isAlarmAllowed() {
  return state.route === '/countdown-timer';
}

function beepPattern() {
  if (!state.alarm || !isAlarmAllowed()) return;
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  let i = 0;
  const play = () => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.value = 0.08;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 1);
    i += 1;
    if (i < 3) setTimeout(play, 1100);
  };
  play();
}

async function enableWakeLock(on) {
  if (!on) {
    if (wakeIntervalId) clearInterval(wakeIntervalId);
    wakeIntervalId = null;
    if (wakeLock) await wakeLock.release().catch(() => {});
    wakeLock = null;
    return;
  }

  async function requestLock() {
    if (!('wakeLock' in navigator)) return;
    if (wakeLock && !wakeLock.released) return;
    if (wakeLockRequestPromise) return wakeLockRequestPromise;
    wakeLockRequestPromise = navigator.wakeLock.request('screen');
    try {
      const lock = await wakeLockRequestPromise;
      wakeLock = lock;
      lock.addEventListener('release', () => {
        wakeLock = null;
        if (state.keep_awake) requestLock().catch(() => {});
      });
    } finally {
      wakeLockRequestPromise = null;
    }
  }

  requestLock().catch(() => {});
  if (!wakeVisibilityBound) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.keep_awake) requestLock().catch(() => {});
    });
    wakeVisibilityBound = true;
  }
  wakeIntervalId = setInterval(() => {
    if (state.keep_awake && !wakeLock) requestLock().catch(() => {});
  }, 15000);
}

function screenTemplate(content) {
  const cls = state.theme === 'default' ? '' : state.theme;
  return `<section class="card ${cls}">
    <h2 class="typo-h">${esc(state.timer_name)}</h2>
    ${content}
    <div class="row">
      <button data-route="/">Home</button>
      <button id="fullBtn">Fullscreen</button>
    </div>
  </section>`;
}

function tick(calc) {
  if (ticking) clearInterval(ticking);
  const out = document.getElementById('clockOut');
  out.style.color = state.color;
  const run = () => { out.textContent = calc(); };
  run();
  ticking = setInterval(run, 250);
}

function renderRoute() {
  if (state.route === '/') {
    app.innerHTML = renderNav();
    return;
  }

  app.innerHTML = renderControls();

  if (state.route === '/elapsed-timer') {
    app.innerHTML += screenTemplate('<div id="clockOut" class="clock-output"></div><div class="subtext">Elapsed since start time</div>');
    const startMs = state.start_time ? new Date(state.start_time).getTime() : Date.now();
    const stopMs = state.stop_time ? new Date(state.stop_time).getTime() : null;
    tick(() => {
      const now = Date.now();
      const end = stopMs && now > stopMs ? stopMs : now;
      return formatSeconds((end - startMs) / 1000);
    });
  }

  if (state.route === '/countdown-timer') {
    app.innerHTML += screenTemplate('<div id="clockOut" class="clock-output"></div><div class="subtext">Countdown to zero</div>');
    const start = parseDuration(state.start_time || '10m');
    const from = state.stop_time ? new Date(state.stop_time).getTime() : Date.now() + start * 1000;
    let alarmed = false;
    tick(() => {
      const left = Math.max(0, Math.floor((from - Date.now()) / 1000));
      if (left === 0 && !alarmed) {
        alarmed = true;
        beepPattern();
      }
      return formatSeconds(left);
    });
  }

  if (state.route === '/world-clock') {
    app.innerHTML += screenTemplate('<div id="clockOut" class="clock-output"></div><div class="subtext" id="dateOut"></div>');
    tick(() => {
      const now = new Date();
      const time = new Intl.DateTimeFormat('en-GB', {
        timeZone: state.timezone,
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      }).format(now);
      const date = new Intl.DateTimeFormat('en-GB', {
        timeZone: state.timezone,
        weekday: 'short', day: '2-digit', month: 'short', year: 'numeric'
      }).format(now);
      const d = document.getElementById('dateOut');
      if (d) d.textContent = `${state.timezone} • ${date}`;
      return time;
    });
  }

  if (state.route === '/pomodoro-timer') {
    app.innerHTML += screenTemplate('<div id="clockOut" class="clock-output"></div><div class="subtext" id="dateOut"></div>');
    const focusNum = Number(state.focus_min);
    const breakNum = Number(state.break_min);
    if (!isFinite(focusNum) || !isFinite(breakNum) || focusNum <= 0 || breakNum <= 0) {
      const d = document.getElementById('clockOut');
      if (d) d.textContent = '00:00:00';
      const sub = document.getElementById('dateOut');
      if (sub) sub.textContent = 'Invalid focus/break values';
      return;
    }
    const focus = focusNum * 60;
    const br = breakNum * 60;
    const cycle = focus + br;
    const base = Date.now();
    tick(() => {
      const elapsed = Math.floor((Date.now() - base) / 1000);
      const pos = elapsed % cycle;
      const inFocus = pos < focus;
      const left = inFocus ? focus - pos : cycle - pos;
      const d = document.getElementById('dateOut');
      if (d) d.textContent = inFocus ? 'Focus phase' : 'Break phase';
      return formatSeconds(left);
    });
  }

  document.querySelectorAll('[data-key]').forEach((el) => {
    el.addEventListener('input', (e) => {
      const key = e.target.dataset.key;
      state[key] = e.target.value;

      // Re-render timer if critical params change
      const timerParams = ['start_time', 'stop_time', 'focus_min', 'break_min', 'timezone'];
      if (timerParams.includes(key)) {
        renderRoute();
        applySettingsState();
        return;
      }

      if (key === 'timer_name') {
        const title = document.querySelector('.typo-h');
        if (title) title.textContent = state.timer_name;
      }
      if (key === 'color') {
        const out = document.getElementById('clockOut');
        if (out) out.style.color = state.color;
      }
      syncUrl();
    });
  });

  const fullBtn = document.getElementById('fullBtn');
  if (fullBtn) {
    fullBtn.addEventListener('click', async () => {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen().catch(() => {});
      } else {
        await document.exitFullscreen().catch(() => {});
      }
    });
  }
}

function bindSharedEvents() {
  settingsToggle.addEventListener('click', () => settingsPanel.classList.toggle('hidden'));

  app.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-route]');
    if (!btn) return;
    state.route = btn.dataset.route;
    syncUrl();
    start();
  });

  alarmToggle.addEventListener('change', () => {
    state.alarm = alarmToggle.checked;
    syncUrl();
  });

  keepAwakeToggle.addEventListener('change', async () => {
    state.keep_awake = keepAwakeToggle.checked;
    await enableWakeLock(state.keep_awake);
    syncUrl();
  });

  modeToggle.addEventListener('change', () => {
    state.mode = modeToggle.checked ? 'dark' : 'light';
    applyTheme();
    syncUrl();
  });

  themeSelect.addEventListener('change', () => {
    state.theme = themeSelect.value;
    applyTheme();
    syncUrl();
  });

  window.addEventListener('beforeunload', persistState);
}

function applyTheme() {
  document.body.className = `theme-${state.theme} ${state.mode}`;
  modeToggle.disabled = state.theme !== 'default';
  modeToggle.parentElement.classList.toggle('disabled', modeToggle.disabled);
  themeSelect.value = state.theme;
  modeToggle.checked = state.mode === 'dark';
}

function applySettingsState() {
  const alarmAllowed = isAlarmAllowed();
  alarmToggle.checked = state.alarm;
  alarmToggle.disabled = !alarmAllowed;
  alarmToggle.parentElement.classList.toggle('disabled', !alarmAllowed);
  keepAwakeToggle.checked = state.keep_awake;
  applyTheme();
}

function start() {
  if (ticking) clearInterval(ticking);
  app.innerHTML = '';
  renderRoute();
  applySettingsState();
}

readStateFromStorage();
readStateFromUrl();
bindSharedEvents();
start();
syncUrl();
