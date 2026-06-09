const app = document.getElementById('app');
const settingsPanel = document.getElementById('settingsPanel');
const settingsToggle = document.getElementById('settingsToggle');
const settingsClose = document.getElementById('settingsClose');
const alarmToggle = document.getElementById('alarmToggle');
const keepAwakeToggle = document.getElementById('keepAwakeToggle');
const modeToggle = document.getElementById('modeToggle');
const themeSelect = document.getElementById('themeSelect');

const STORAGE_KEY = 'web_timer_state_v1';
const COOKIE_KEY = 'web_timer_state';

const routes = {
  '/': { name: 'Home' },
  '/elapsed-timer': {
    name: 'Elapsed Timer',
    icon: '⏱️',
    description: 'Track time elapsed since a start point. Perfect for measuring how long tasks take.'
  },
  '/countdown-timer': {
    name: 'Countdown Timer',
    icon: '⏳',
    description: 'Count down to zero from a set duration. Great for time-boxing work sessions.'
  },
  '/world-clock': {
    name: 'World Clock',
    icon: '🌍',
    description: 'Display the current time in any timezone. Useful for remote team coordination.'
  },
  '/pomodoro-timer': {
    name: 'Pomodoro Timer',
    icon: '🍅',
    description: 'Alternate between focus and break intervals using the Pomodoro technique.'
  }
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
  fullscreen: false,
  controls_expanded: true
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

// ===== Utility Functions =====

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

// ===== State Persistence =====

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

// ===== Routing =====

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

// ===== Rendering =====

function renderNav() {
  const timerRoutes = Object.entries(routes).filter(([k]) => k !== '/');
  return `
    <div class="home-screen">
      <h1 class="home-title">Web Timer</h1>
      <p class="home-subtitle">Choose a timer mode to get started</p>
      <div class="home-grid">
        ${timerRoutes.map(([route, info]) => `
          <div class="home-card" data-route="${route}" role="button" tabindex="0" aria-label="${info.name}">
            <span class="card-icon">${info.icon}</span>
            <h3>${info.name}</h3>
            <p>${info.description}</p>
          </div>
        `).join('')}
      </div>
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
      <label><span>Start Time</span><input data-key="start_time" type="datetime-local" value="${esc(state.start_time)}" /></label>
      <label><span>Stop Time</span><input data-key="stop_time" type="datetime-local" value="${esc(state.stop_time)}" /></label>`;
  } else if (isCountdown) {
    extra = `
      <label><span>Duration</span><input data-key="start_time" type="text" placeholder="e.g. 10m, 1h, 90s" value="${esc(state.start_time || '10m')}" /></label>
      <label><span>End At</span><input data-key="stop_time" type="datetime-local" value="${esc(state.stop_time)}" /></label>`;
  } else if (isWorld) {
    extra = `
      <label><span>Timezone</span>
        <select data-key="timezone">
          ${['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Kolkata', 'Australia/Sydney', 'Pacific/Auckland'].map((tz) => `<option ${state.timezone === tz ? 'selected' : ''} value="${tz}">${tz.replace(/_/g, ' ')}</option>`).join('')}
        </select>
      </label>
      <label><span>Format</span><input disabled type="text" value="24h" /></label>`;
  } else if (isPomodoro) {
    extra = `
      <label><span>Focus (min)</span><input data-key="focus_min" type="number" min="1" max="120" value="${esc(state.focus_min)}" /></label>
      <label><span>Break (min)</span><input data-key="break_min" type="number" min="1" max="60" value="${esc(state.break_min)}" /></label>`;
  }

  const expandedClass = state.controls_expanded ? 'expanded' : '';
  const chevronClass = state.controls_expanded ? 'open' : '';

  return `
    <section class="top-controls">
      <div class="controls-card">
        <div class="controls-toggle" id="controlsToggle" role="button" tabindex="0" aria-expanded="${state.controls_expanded}">
          <h3>Configuration</h3>
          <span class="chevron ${chevronClass}">▼</span>
        </div>
        <div class="controls-body ${expandedClass}">
          <label><span>Name</span><input data-key="timer_name" type="text" value="${esc(state.timer_name)}" /></label>
          <label><span>Color</span><input data-key="color" type="color" value="${esc(state.color)}" /></label>
          ${extra}
        </div>
      </div>
    </section>`;
}

// ===== Audio =====

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

// ===== Wake Lock =====

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

// ===== Clock Screen =====

function screenTemplate(content, subtext) {
  return `
    <div class="clock-container">
      <h2 class="clock-title">${esc(state.timer_name)}</h2>
      ${content}
      <div class="clock-subtext">${subtext || ''}</div>
      <div class="clock-actions">
        <button data-route="/" aria-label="Go home">← Home</button>
        <button id="fullBtn" aria-label="Toggle fullscreen">⛶ Fullscreen</button>
      </div>
    </div>`;
}

function tick(calc) {
  if (ticking) clearInterval(ticking);
  const out = document.getElementById('clockOut');
  if (!out) return;
  out.style.color = state.color;
  const run = () => {
    const result = calc();
    if (typeof result === 'string') {
      out.textContent = result;
    }
  };
  run();
  ticking = setInterval(run, 250);
}

// ===== Route Rendering =====

function renderRoute() {
  if (state.route === '/') {
    app.innerHTML = renderNav();
    document.title = 'Web Timer';
    return;
  }

  const routeInfo = routes[state.route];
  document.title = `${state.timer_name} - ${routeInfo ? routeInfo.name : 'Timer'}`;

  app.innerHTML = renderControls();

  if (state.route === '/elapsed-timer') {
    app.innerHTML += screenTemplate(
      '<div id="clockOut" class="clock-output" aria-live="polite" aria-atomic="true"></div>',
      'Elapsed since start time'
    );
    const startMs = state.start_time ? new Date(state.start_time).getTime() : Date.now();
    const stopMs = state.stop_time ? new Date(state.stop_time).getTime() : null;
    tick(() => {
      const now = Date.now();
      const end = stopMs && now > stopMs ? stopMs : now;
      return formatSeconds((end - startMs) / 1000);
    });
  }

  if (state.route === '/countdown-timer') {
    app.innerHTML += screenTemplate(
      '<div id="clockOut" class="clock-output" aria-live="polite" aria-atomic="true"></div>',
      'Countdown to zero'
    );
    const start = parseDuration(state.start_time || '10m');
    const from = state.stop_time ? new Date(state.stop_time).getTime() : Date.now() + start * 1000;
    let alarmed = false;
    tick(() => {
      const left = Math.max(0, Math.floor((from - Date.now()) / 1000));
      const out = document.getElementById('clockOut');
      if (out) {
        if (left <= 10 && left > 0) {
          out.classList.add('ending');
        } else {
          out.classList.remove('ending');
        }
      }
      if (left === 0 && !alarmed) {
        alarmed = true;
        beepPattern();
      }
      return formatSeconds(left);
    });
  }

  if (state.route === '/world-clock') {
    app.innerHTML += screenTemplate(
      '<div id="clockOut" class="clock-output" aria-live="polite" aria-atomic="true"></div><div class="clock-subtext" id="dateOut"></div>',
      ''
    );
    tick(() => {
      const now = new Date();
      const time = new Intl.DateTimeFormat('en-GB', {
        timeZone: state.timezone,
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      }).format(now);
      const date = new Intl.DateTimeFormat('en-GB', {
        timeZone: state.timezone,
        weekday: 'long', day: '2-digit', month: 'short', year: 'numeric'
      }).format(now);
      const d = document.getElementById('dateOut');
      if (d) d.textContent = `${state.timezone.replace(/_/g, ' ')} · ${date}`;
      return time;
    });
  }

  if (state.route === '/pomodoro-timer') {
    app.innerHTML += screenTemplate(
      '<div id="clockOut" class="clock-output" aria-live="polite" aria-atomic="true"></div><div class="clock-subtext" id="phaseOut"></div>',
      ''
    );
    const focusNum = Number(state.focus_min);
    const breakNum = Number(state.break_min);
    if (!isFinite(focusNum) || !isFinite(breakNum) || focusNum <= 0 || breakNum <= 0) {
      const d = document.getElementById('clockOut');
      if (d) d.textContent = '00:00:00';
      const sub = document.getElementById('phaseOut');
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
      const d = document.getElementById('phaseOut');
      if (d) {
        d.textContent = inFocus ? '🎯 Focus Phase' : '☕ Break Phase';
        d.style.color = inFocus ? 'var(--accent)' : 'var(--fg)';
      }
      return formatSeconds(left);
    });
  }

  // Bind controls toggle
  const controlsToggle = document.getElementById('controlsToggle');
  if (controlsToggle) {
    controlsToggle.addEventListener('click', () => {
      state.controls_expanded = !state.controls_expanded;
      const body = controlsToggle.nextElementSibling;
      const chevron = controlsToggle.querySelector('.chevron');
      body.classList.toggle('expanded', state.controls_expanded);
      chevron.classList.toggle('open', state.controls_expanded);
      controlsToggle.setAttribute('aria-expanded', state.controls_expanded);
    });
  }

  // Bind data-key inputs
  document.querySelectorAll('[data-key]').forEach((el) => {
    el.addEventListener('input', (e) => {
      const key = e.target.dataset.key;
      state[key] = e.target.value;

      const timerParams = ['start_time', 'stop_time', 'focus_min', 'break_min', 'timezone'];
      if (timerParams.includes(key)) {
        renderRoute();
        applySettingsState();
        return;
      }

      if (key === 'timer_name') {
        const title = document.querySelector('.clock-title');
        if (title) title.textContent = state.timer_name;
        document.title = `${state.timer_name} - ${routes[state.route]?.name || 'Timer'}`;
      }
      if (key === 'color') {
        const out = document.getElementById('clockOut');
        if (out) out.style.color = state.color;
      }
      syncUrl();
    });
  });

  // Fullscreen button
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

// ===== Event Bindings =====

function bindSharedEvents() {
  settingsToggle.addEventListener('click', () => {
    settingsPanel.classList.toggle('hidden');
  });

  settingsClose.addEventListener('click', () => {
    settingsPanel.classList.add('hidden');
  });

  // Close settings on clicking outside
  document.addEventListener('click', (e) => {
    if (!settingsPanel.classList.contains('hidden') &&
        !settingsPanel.contains(e.target) &&
        !settingsToggle.contains(e.target)) {
      settingsPanel.classList.add('hidden');
    }
  });

  // Keyboard support for home cards
  app.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      const card = e.target.closest('[data-route]');
      if (card) {
        e.preventDefault();
        card.click();
      }
    }
  });

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
    // Re-render to apply theme-specific styles
    if (state.route !== '/') {
      renderRoute();
      applySettingsState();
    }
  });

  // Escape to close settings
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !settingsPanel.classList.contains('hidden')) {
      settingsPanel.classList.add('hidden');
    }
  });

  // Handle browser back/forward
  window.addEventListener('popstate', () => {
    readStateFromUrl();
    start();
  });

  window.addEventListener('beforeunload', persistState);

  // Handle window resize - update dynamic font sizing
  window.addEventListener('resize', debounce(() => {
    const out = document.getElementById('clockOut');
    if (out) {
      // Force reflow for dynamic sizing
      out.style.fontSize = '';
    }
  }, 150));
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ===== Theme Application =====

function applyTheme() {
  document.body.className = `theme-${state.theme} ${state.mode}`;
  
  // Only allow dark/light toggle on default theme
  const isDefault = state.theme === 'default';
  modeToggle.disabled = !isDefault;
  modeToggle.parentElement.closest('.setting-row').classList.toggle('disabled', !isDefault);
  
  themeSelect.value = state.theme;
  modeToggle.checked = state.mode === 'dark';
}

function applySettingsState() {
  const alarmAllowed = isAlarmAllowed();
  alarmToggle.checked = state.alarm;
  alarmToggle.disabled = !alarmAllowed;
  alarmToggle.parentElement.closest('.setting-row').classList.toggle('disabled', !alarmAllowed);
  keepAwakeToggle.checked = state.keep_awake;
  applyTheme();
}

// ===== Start =====

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
