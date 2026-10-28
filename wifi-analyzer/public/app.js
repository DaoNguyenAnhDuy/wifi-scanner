'use strict';
/* WiFi Analyzer — frontend (không phụ thuộc thư viện; biểu đồ vẽ bằng Canvas API). */
(() => {
  /* =====================================================================
   * 1. Tiện ích, trạng thái, lưu cài đặt
   * ===================================================================== */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const STORE_KEY = 'wifi-analyzer:v1';
  const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  const HISTORY_MS = 60000;

  // SSID do người lạ phát ra => luôn coi là dữ liệu không tin cậy: thoát HTML + bỏ ký tự điều khiển/đảo chiều chữ.
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clean = (s) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '');
  const nameOf = (ap) => clean(ap.ssid) || `(ẩn) ${(ap.bssid || ap.id).slice(-5)}`;
  const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
  const saved = (() => {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
    } catch (_) {
      return {};
    }
  })();

  const state = {
    tab: pick(saved.tab, ['channel', 'time', 'rating', 'list'], 'channel'),
    band: pick(saved.band, ['2.4', '5'], '2.4'),
    timeBand: pick(saved.timeBand, ['all', '2.4', '5'], 'all'),
    ratingSort: pick(saved.ratingSort, ['channel', 'rating'], 'channel'),
    listBand: pick(saved.listBand, ['all', '2.4', '5', '6'], 'all'),
    listSec: pick(saved.listSec, ['all', 'secure', 'open'], 'all'),
    auto: saved.auto !== false,
    interval: Number(pick(String(saved.interval), ['3000', '5000', '10000'], '3000')),
    demo: Boolean(saved.demo),
    forceDemo: false,
    aps: [],
    source: '',
    scannedAt: 0,
    scanning: false,
    error: null,
    sort: { key: 'rssi', dir: -1 },
    q: '',
    hoverId: null,
    hidden: new Set(), // id các mạng bị ẩn trên Time Graph
  };

  function save() {
    try {
      const { tab, band, timeBand, ratingSort, listBand, listSec, auto, interval, demo } = state;
      localStorage.setItem(STORE_KEY, JSON.stringify({ tab, band, timeBand, ratingSort, listBand, listSec, auto, interval, demo: state.forceDemo ? saved.demo : demo }));
    } catch (_) {
      /* bỏ qua: chỉ là tiện ích */
    }
  }

  /* =====================================================================
   * 2. Màu neon cố định theo BSSID
   * ===================================================================== */
  const hueCache = new Map();
  function hueOf(id) {
    let h = hueCache.get(id);
    if (h === undefined) {
      let x = 2166136261; // FNV-1a
      for (let i = 0; i < id.length; i++) {
        x ^= id.charCodeAt(i);
        x = Math.imul(x, 16777619);
      }
      h = (x >>> 0) % 360;
      hueCache.set(id, h);
    }
    return h;
  }
  // Dải xanh dương trông tối hơn ở cùng độ sáng nên nâng sáng thêm để vẫn "neon".
  const col = (ap, a = 1) => {
    const h = hueOf(ap.id);
    const l = h > 195 && h < 295 ? 68 : 58;
    return `hsl(${h} 100% ${l}% / ${a})`;
  };

  /* =====================================================================
   * 3. Hình học RF phía giao diện
   * ===================================================================== */
  const T24 = Array.from({ length: 14 }, (_, i) => i + 1);
  const T5 = [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149, 153, 157, 161, 165];
  const chToFreq = (ch, band) => (band === '5' ? 5000 + 5 * ch : ch === 14 ? 2484 : 2407 + 5 * ch);

  // Trục 5 GHz: nén khoảng trống 5330–5490 MHz (không có kênh) để các kênh không bị dồn sát.
  const v5 = (f) => (f <= 5330 ? f - 5170 : f <= 5490 ? 160 + (f - 5330) * 0.25 : 200 + (f - 5490));
  const BANDS = {
    '2.4': { ticks: T24, toV: (f) => f, vmin: 2397, vmax: 2499, name: '2.4 GHz' },
    5: { ticks: T5, toV: v5, vmin: -12, vmax: 557, name: '5 GHz' },
  };

  const C5_80 = [[36, 48, 42], [52, 64, 58], [100, 112, 106], [116, 128, 122], [132, 144, 138], [149, 161, 155]];
  const C5_160 = [[36, 64, 50], [100, 128, 114]];
  const C5_40_STARTS = [36, 44, 52, 60, 100, 108, 116, 124, 132, 140, 149, 157];

  /**
   * Hệ điều hành thường chỉ báo kênh chính (primary). Với kênh rộng, tâm thực của tín hiệu nằm ở giữa khối kênh gộp:
   * 5 GHz theo bảng gộp kênh chuẩn; 2.4 GHz (40 MHz) không biết hướng nên giả định phổ biến: kênh ≤7 mở rộng lên, còn lại mở rộng xuống.
   */
  function centerChannel(ap) {
    const ch = ap.channel;
    const w = ap.width || 20;
    if (ap.band === '2.4') return w >= 40 ? (ch <= 7 ? ch + 2 : ch - 2) : ch;
    if (ap.band === '5') {
      if (w >= 160) {
        const b = C5_160.find(([a, z]) => ch >= a && ch <= z);
        if (b) return b[2];
      }
      if (w >= 80) {
        const b = C5_80.find(([a, z]) => ch >= a && ch <= z);
        if (b) return b[2];
      }
      if (w >= 40) {
        const s = C5_40_STARTS.filter((x) => x <= ch).pop();
        if (s != null && ch <= s + 4) return s + 2;
      }
    }
    return ch;
  }
  const centerFreq = (ap) => chToFreq(centerChannel(ap), ap.band);

  /* =====================================================================
   * 4. Vòng quét
   * ===================================================================== */
  const hist = new Map(); // id -> [{t, rssi}]
  const seen = new Map(); // id -> ap (bản ghi mới nhất)
  const shown = new Map(); // id -> rssi đang hiển thị (để làm mượt Channel Graph)
  let timer = 0;

  function resetData() {
    state.aps = [];
    state.scannedAt = 0;
    state.source = '';
    hist.clear();
    seen.clear();
    shown.clear();
    state.hoverId = null;
  }

  function ingest(data) {
    const now = Date.now();
    const isNew = data.scannedAt !== state.lastScanStamp;
    state.lastScanStamp = data.scannedAt;
    state.aps = data.aps;
    state.source = data.source;
    state.scannedAt = data.scannedAt;
    state.error = null;

    const ids = new Set();
    for (const ap of data.aps) {
      ids.add(ap.id);
      seen.set(ap.id, ap);
      if (isNew) {
        let arr = hist.get(ap.id);
        if (!arr) hist.set(ap.id, (arr = []));
        arr.push({ t: now, rssi: ap.rssi });
      }
    }
    for (const id of [...shown.keys()]) if (!ids.has(id)) shown.delete(id);
    for (const [id, arr] of hist) {
      while (arr.length && arr[0].t < now - HISTORY_MS - 5000) arr.shift();
      if (!arr.length) {
        hist.delete(id);
        seen.delete(id);
        state.hidden.delete(id);
      }
    }
  }

  async function scanOnce() {
    if (state.scanning) return;
    state.scanning = true;
    $('#scanNow').disabled = true;
    updateStatus();
    try {
      const res = await fetch('/api/scan' + (state.demo ? '?demo=1' : ''), { cache: 'no-store' });
      let data;
      try {
        data = await res.json();
      } catch (_) {
        throw Object.assign(new Error(`Máy chủ trả về phản hồi không hợp lệ (HTTP ${res.status}).`), {});
      }
      if (!res.ok || !data.ok) throw Object.assign(new Error(data.error || 'Không quét được Wi-Fi.'), { hint: data.hint });
      ingest(data);
      hideBanner();
    } catch (err) {
      state.error = err;
      const offline = err instanceof TypeError; // fetch thất bại: mất kết nối tới server
      showBanner(offline ? 'Mất kết nối tới máy chủ' : 'Không quét được Wi-Fi', offline ? 'Không gọi được /api/scan.' : err.message, offline ? 'Kiểm tra xem lệnh "npm start" còn đang chạy không.' : err.hint);
    } finally {
      state.scanning = false;
      $('#scanNow').disabled = false;
      updateStatus();
      renderActive();
    }
  }

  function schedule() {
    clearTimeout(timer);
    if (!state.auto || document.hidden) return;
    timer = setTimeout(async () => {
      await scanOnce();
      schedule();
    }, state.interval);
  }

  /* =====================================================================
   * 5. Trạng thái, banner, tab, điều khiển
   * ===================================================================== */
  function updateStatus() {
    const box = $('#status');
    const txt = $('#statusText');
    box.className = 'status ' + (state.scanning ? 'busy' : state.error ? 'err' : state.scannedAt ? 'ok' : 'busy');
    txt.textContent = '';
    if (state.error && !state.scannedAt) {
      txt.textContent = 'Chưa có dữ liệu';
    } else if (state.scannedAt) {
      const t = new Date(state.scannedAt).toLocaleTimeString('vi-VN', { hour12: false });
      txt.append(`${state.aps.length} mạng · ${state.source} · ${t}`);
      if (state.source === 'demo') {
        const b = document.createElement('span');
        b.className = 'badge';
        b.textContent = 'DEMO';
        txt.append(' ', b);
      }
    } else {
      txt.textContent = 'Đang quét…';
    }
  }

  function showBanner(title, msg, hint) {
    $('#bannerTitle').textContent = title;
    $('#bannerMsg').textContent = msg || '';
    $('#bannerHint').textContent = hint || '';
    $('#bannerDemo').hidden = state.demo;
    $('#banner').hidden = false;
  }
  const hideBanner = () => ($('#banner').hidden = true);

  function setTab(name, focus) {
    state.tab = name;
    for (const t of $$('.tab')) {
      const on = t.dataset.tab === name;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    }
    for (const p of $$('[role="tabpanel"]')) p.hidden = p.id !== `panel-${name}`;
    hideTips();
    save();
    renderActive();
    if (focus) $(`#tab-${name}`).focus();
  }

  function syncSegs() {
    for (const g of $$('[data-seg]')) {
      const v = state[g.dataset.seg];
      for (const b of $$('button', g)) b.setAttribute('aria-pressed', String(b.dataset.v === v));
    }
  }

  function renderActive() {
    if (state.tab === 'channel') requestDraw();
    else if (state.tab === 'time') {
      renderLegend();
      requestDraw();
    } else if (state.tab === 'rating') renderRating();
    else if (state.tab === 'list') renderList();
  }

  /* =====================================================================
   * 6. Canvas: vòng vẽ và tiện ích chung
   * ===================================================================== */
  let raf = 0;
  function requestDraw() {
    if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
  }
  function frame() {
    raf = 0;
    let again = false;
    if (state.tab === 'channel') again = drawChannel();
    else if (state.tab === 'time') {
      drawTime();
      again = true; // trục thời gian trôi liên tục
    }
    if (again && !document.hidden) raf = requestAnimationFrame(frame);
  }

  const isVisible = (el) => el.offsetParent !== null;
  const M = { l: 52, r: 16, t: 22, b: 34 };

  function prep(cv) {
    const r = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(10, Math.round(r.width));
    const h = Math.max(10, Math.round(r.height));
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h, area: { x: M.l, y: M.t, w: w - M.l - M.r, h: h - M.t - M.b } };
  }

  const yOf = (rssi, area) => area.y + (1 - (clamp(rssi, -100, -20) + 100) / 80) * area.h;

  function drawYGrid(ctx, area) {
    ctx.font = `11px ${MONO}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let d = -100; d <= -20; d += 10) {
      const y = yOf(d, area);
      ctx.strokeStyle = d === -100 ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(area.x, Math.round(y) + 0.5);
      ctx.lineTo(area.x + area.w, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillStyle = '#8396ab';
      ctx.fillText(String(d), area.x - 8, y);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#8396ab';
    ctx.fillText('dBm', 8, 14);
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  }

  function drawLock(ctx, x, y, color) {
    // x,y: góc trên trái; icon 8x11
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(x + 4, y + 3.6, 2.6, Math.PI, 0);
    ctx.stroke();
    ctx.fillRect(x, y + 4, 8, 6);
    ctx.restore();
  }

  function drawEmpty(ctx, w, h, msg) {
    ctx.fillStyle = '#8396ab';
    ctx.font = `14px ${SANS}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(msg, w / 2, h / 2);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  /* ---------- tooltip ---------- */
  function fmtDist(d) {
    if (d == null) return '—';
    if (d >= 1000) return `~${(d / 1000).toFixed(1)} km`;
    return `~${d < 10 ? d.toFixed(1) : Math.round(d)} m`;
  }
  const lockSvg = '<svg class="lock" width="12" height="14" viewBox="0 0 12 14" fill="currentColor" aria-label="Có mật khẩu" role="img"><rect x="1" y="6" width="10" height="7.5" rx="1.6"/><path d="M3.2 6V4.4a2.8 2.8 0 0 1 5.6 0V6" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';

  function apTip(ap, extra) {
    return (
      `<b><span class="sw" style="background:${col(ap)}"></span>${esc(nameOf(ap))}</b><dl>` +
      `<dt>BSSID</dt><dd>${esc(ap.bssid || '—')}</dd>` +
      `<dt>Hãng</dt><dd>${esc(ap.vendor)}</dd>` +
      `<dt>Kênh</dt><dd>${ap.channel} · ${ap.frequency} MHz</dd>` +
      `<dt>Độ rộng</dt><dd>${ap.width} MHz${ap.widthKnown ? '' : '*'}</dd>` +
      `<dt>RSSI</dt><dd>${ap.rssi} dBm</dd>` +
      `<dt>Bảo mật</dt><dd>${esc(ap.security)}</dd>` +
      `<dt>Khoảng cách</dt><dd>${fmtDist(ap.distance)}</dd>${extra || ''}</dl>`
    );
  }

  function placeTip(tip, wrap, x, y) {
    tip.hidden = false;
    let left = x + 16;
    let top = y + 16;
    if (left + tip.offsetWidth > wrap.clientWidth - 4) left = x - tip.offsetWidth - 16;
    if (top + tip.offsetHeight > wrap.clientHeight - 4) top = y - tip.offsetHeight - 16;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${Math.max(4, top)}px`;
  }
  function hideTips() {
    for (const t of $$('.tooltip')) t.hidden = true;
  }

  /* =====================================================================
   * 7. Tab 1 — Channel Graph
   * ===================================================================== */
  let chItems = [];
  let chLayout = null;
  const BELL_N = 48;

  function drawChannel() {
    const cv = $('#cv-channel');
    if (!isVisible(cv)) return false;
    const { ctx, w, h, area } = prep(cv);
    const cfg = BANDS[state.band];
    const xOf = (f) => area.x + ((cfg.toV(f) - cfg.vmin) / (cfg.vmax - cfg.vmin)) * area.w;
    const base = area.y + area.h;
    chLayout = { area, xOf, base };

    drawYGrid(ctx, area);

    // Trục kênh (bỏ bớt nhãn xen kẽ khi màn hình hẹp)
    const spacing = Math.abs(xOf(chToFreq(cfg.ticks[1], state.band)) - xOf(chToFreq(cfg.ticks[0], state.band)));
    const step = spacing < 26 ? 2 : 1;
    ctx.font = `11px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    cfg.ticks.forEach((ch, i) => {
      const x = Math.round(xOf(chToFreq(ch, state.band))) + 0.5;
      const key = state.band === '2.4' && (ch === 1 || ch === 6 || ch === 11);
      ctx.strokeStyle = key ? 'rgba(61,242,200,.16)' : 'rgba(255,255,255,.04)';
      ctx.beginPath();
      ctx.moveTo(x, area.y);
      ctx.lineTo(x, base);
      ctx.stroke();
      if (i % step === 0) {
        ctx.fillStyle = key ? '#3df2c8' : '#8396ab';
        ctx.fillText(String(ch), x, base + 18);
      }
    });
    ctx.fillStyle = '#8396ab';
    ctx.textAlign = 'right';
    ctx.fillText('Kênh', w - 6, h - 6);

    const list = state.aps.filter((a) => a.band === state.band);
    cv.setAttribute('aria-label', list.length ? `Biểu đồ phổ kênh ${cfg.name}: ${list.length} mạng, mạnh nhất là ${nameOf(list[0])} (${list[0].rssi} dBm)` : `Biểu đồ phổ kênh ${cfg.name}: chưa thấy mạng nào`);

    if (!list.length) {
      chItems = [];
      drawEmpty(ctx, w, h, state.scannedAt ? `Không thấy mạng ${cfg.name} nào.` : 'Đang quét…');
      return false;
    }

    // Làm mượt RSSI giữa các lần quét
    let animating = false;
    const items = list.map((ap) => {
      let s = shown.get(ap.id);
      if (s === undefined) s = REDUCED ? ap.rssi : -100;
      const d = ap.rssi - s;
      if (!REDUCED && Math.abs(d) > 0.15) {
        s += d * 0.2;
        animating = true;
      } else s = ap.rssi;
      shown.set(ap.id, s);
      return { ap, rssi: s, fc: centerFreq(ap), hw: (ap.width || 20) / 2, pts: [] };
    });
    items.sort((a, b) => a.rssi - b.rssi); // yếu vẽ trước, mạnh vẽ sau
    if (state.hoverId) {
      const i = items.findIndex((it) => it.ap.id === state.hoverId);
      if (i >= 0) items.push(items.splice(i, 1)[0]);
    }
    chItems = items;

    for (const it of items) {
      const peak = yOf(it.rssi, area);
      const dim = state.hoverId && it.ap.id !== state.hoverId;
      const hot = state.hoverId === it.ap.id;
      for (let i = 0; i <= BELL_N; i++) {
        const t = -1 + (2 * i) / BELL_N;
        it.pts.push({ x: xOf(it.fc + t * it.hw), y: base - (base - peak) * (1 - t * t) });
      }
      ctx.beginPath();
      it.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      const g = ctx.createLinearGradient(0, peak, 0, base);
      g.addColorStop(0, col(it.ap, dim ? 0.1 : hot ? 0.5 : 0.36));
      g.addColorStop(1, col(it.ap, 0.02));
      ctx.fillStyle = g;
      ctx.fill();

      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineWidth = hot ? 3 : 2;
      ctx.strokeStyle = col(it.ap, dim ? 0.35 : 1);
      ctx.shadowColor = col(it.ap, dim ? 0 : 0.9);
      ctx.shadowBlur = dim ? 0 : hot ? 14 : 8;
      ctx.beginPath();
      it.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
      ctx.restore();
    }

    // Nhãn SSID trên đỉnh chuông (tránh chồng nhau bằng cách xếp tầng)
    ctx.font = `600 12px ${SANS}`;
    ctx.textBaseline = 'middle';
    const placed = [];
    for (const it of [...items].sort((a, b) => b.rssi - a.rssi)) {
      const label = trunc(nameOf(it.ap), 22);
      const lock = it.ap.secure ? 14 : 0;
      const tw = ctx.measureText(label).width + lock;
      const bw = tw + 14;
      const bh = 19;
      let bx = clamp(xOf(it.fc) - bw / 2, area.x, area.x + area.w - bw);
      let by = yOf(it.rssi, area) - 9 - bh;
      const hit = (r) => bx < r.x + r.w && bx + bw > r.x && by < r.y + r.h && by + bh > r.y;
      while (placed.some(hit) && by > area.y - 8) by -= bh + 2;
      if (by <= area.y - 8) continue;
      placed.push({ x: bx, y: by, w: bw, h: bh });
      const dim = state.hoverId && it.ap.id !== state.hoverId;
      ctx.globalAlpha = dim ? 0.4 : 1;
      ctx.fillStyle = 'rgba(8,12,17,.78)';
      roundRect(ctx, bx, by, bw, bh, 6);
      ctx.fill();
      ctx.strokeStyle = col(it.ap, 0.55);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = col(it.ap);
      let tx = bx + 7;
      if (lock) {
        drawLock(ctx, tx, by + 4.5, col(it.ap));
        tx += lock;
      }
      ctx.textAlign = 'left';
      ctx.fillText(label, tx, by + bh / 2 + 0.5);
      ctx.globalAlpha = 1;
    }
    ctx.textBaseline = 'alphabetic';
    return animating;
  }

  function hitChannel(mx, my) {
    let best = null;
    let bd = 1e9;
    for (const it of chItems) {
      const p = it.pts;
      if (p.length < 2 || mx < p[0].x || mx > p[p.length - 1].x) continue;
      let y = null;
      for (let i = 1; i < p.length; i++) {
        if (mx <= p[i].x && p[i].x > p[i - 1].x) {
          y = p[i - 1].y + ((p[i].y - p[i - 1].y) * (mx - p[i - 1].x)) / (p[i].x - p[i - 1].x);
          break;
        }
      }
      if (y == null) continue;
      const d = my >= y ? my - y : (y - my) * 2.5; // trong vùng tô: ưu tiên mép gần nhất
      if ((my >= y || y - my < 8) && d < bd) {
        bd = d;
        best = it.ap;
      }
    }
    return best;
  }

  function bindChannelHover() {
    const cv = $('#cv-channel');
    const wrap = $('#wrap-channel');
    const tip = $('#tip-channel');
    const move = (e) => {
      const r = cv.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const ap = hitChannel(x, y);
      const id = ap ? ap.id : null;
      if (id !== state.hoverId) {
        state.hoverId = id;
        requestDraw();
      }
      if (ap) {
        tip.innerHTML = apTip(ap);
        placeTip(tip, wrap, x, y);
      } else tip.hidden = true;
    };
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerdown', move);
    cv.addEventListener('pointerleave', () => {
      state.hoverId = null;
      tip.hidden = true;
      requestDraw();
    });
  }

  /* =====================================================================
   * 8. Tab 2 — Time Graph
   * ===================================================================== */
  let tmLayout = null;

  function timeSeries() {
    const out = [];
    for (const [id, pts] of hist) {
      const ap = seen.get(id);
      if (!ap || state.hidden.has(id)) continue;
      if (state.timeBand !== 'all' && ap.band !== state.timeBand) continue;
      out.push({ id, ap, pts });
    }
    return out;
  }

  function drawTime() {
    const cv = $('#cv-time');
    if (!isVisible(cv)) return;
    const { ctx, w, h, area } = prep(cv);
    const now = Date.now();
    const xOfT = (t) => area.x + area.w - ((now - t) / HISTORY_MS) * area.w;
    const base = area.y + area.h;
    tmLayout = { area, now, xOfT };

    drawYGrid(ctx, area);
    ctx.font = `11px ${MONO}`;
    ctx.textAlign = 'center';
    for (let s = 0; s <= 60; s += 10) {
      const x = Math.round(area.x + area.w - (s / 60) * area.w) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,.05)';
      ctx.beginPath();
      ctx.moveTo(x, area.y);
      ctx.lineTo(x, base);
      ctx.stroke();
      ctx.fillStyle = '#8396ab';
      if (s === 0) {
        // Nhãn ở mép phải: canh phải để không bị cắt khỏi canvas
        ctx.textAlign = 'right';
        ctx.fillText('bây giờ', x + 2, base + 18);
        ctx.textAlign = 'center';
      } else ctx.fillText(`-${s}s`, x, base + 18);
    }
    ctx.textAlign = 'right';
    ctx.fillText('Thời gian (giây)', w - 6, h - 6);
    ctx.textAlign = 'left';

    const series = timeSeries().sort((a, b) => a.ap.rssi - b.ap.rssi);
    if (!series.length) {
      drawEmpty(ctx, w, h, state.scannedAt ? 'Không có mạng nào để hiển thị (kiểm tra bộ lọc).' : 'Đang quét…');
      return;
    }

    const gap = Math.max(state.interval * 2.5, 8000);
    ctx.save();
    ctx.beginPath();
    ctx.rect(area.x, area.y - 4, area.w, area.h + 8);
    ctx.clip();
    for (const s of series) {
      const dim = state.hoverId && s.id !== state.hoverId;
      const hot = state.hoverId === s.id;
      ctx.lineJoin = 'round';
      ctx.lineWidth = hot ? 3.2 : 2;
      ctx.strokeStyle = col(s.ap, dim ? 0.25 : 1);
      ctx.shadowColor = col(s.ap, dim ? 0 : 0.8);
      ctx.shadowBlur = dim ? 0 : hot ? 12 : 6;
      ctx.beginPath();
      let prev = null;
      for (const p of s.pts) {
        const x = xOfT(p.t);
        const y = yOf(p.rssi, area);
        if (!prev || p.t - prev.t > gap) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        prev = p;
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = col(s.ap, dim ? 0.3 : 1);
      for (const p of s.pts) {
        ctx.beginPath();
        ctx.arc(xOfT(p.t), yOf(p.rssi, area), hot ? 3.2 : 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    if (tmHover) {
      ctx.strokeStyle = 'rgba(255,255,255,.28)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(tmHover.x + 0.5, area.y);
      ctx.lineTo(tmHover.x + 0.5, base);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  let tmHover = null;
  function bindTimeHover() {
    const cv = $('#cv-time');
    const wrap = $('#wrap-time');
    const tip = $('#tip-time');
    const leave = () => {
      tmHover = null;
      state.hoverId = null;
      tip.hidden = true;
      syncLegendHover();
    };
    const move = (e) => {
      if (!tmLayout) return;
      const r = cv.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const { area, now } = tmLayout;
      if (x < area.x || x > area.x + area.w) return leave();
      const t = now - ((area.x + area.w - x) / area.w) * HISTORY_MS;
      tmHover = { x };
      let best = null;
      let bd = 16;
      const gap = Math.max(state.interval * 2.5, 8000);
      for (const s of timeSeries()) {
        const pts = s.pts;
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1];
          const b = pts[i];
          if (t < a.t || t > b.t || b.t - a.t > gap) continue;
          const v = a.rssi + ((b.rssi - a.rssi) * (t - a.t)) / (b.t - a.t);
          const d = Math.abs(yOf(v, area) - y);
          if (d < bd) {
            bd = d;
            best = { s, v: Math.round(v) };
          }
        }
      }
      const id = best ? best.s.id : null;
      if (id !== state.hoverId) {
        state.hoverId = id;
        syncLegendHover();
      }
      if (best) {
        const ago = Math.max(0, Math.round((now - t) / 1000));
        tip.innerHTML = apTip(best.s.ap, `<dt>Tại thời điểm</dt><dd>${best.v} dBm · ${ago}s trước</dd>`);
        placeTip(tip, wrap, x, y);
      } else tip.hidden = true;
    };
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerdown', move);
    cv.addEventListener('pointerleave', leave);
  }

  function renderLegend() {
    const box = $('#legend');
    const list = state.aps.filter((a) => state.timeBand === 'all' || a.band === state.timeBand);
    if (!list.length) {
      box.innerHTML = '<span class="hint">Chưa có mạng nào.</span>';
      return;
    }
    box.innerHTML = list
      .map(
        (ap) =>
          `<button type="button" class="chip" data-id="${esc(ap.id)}" aria-pressed="${!state.hidden.has(ap.id)}" title="${esc(ap.bssid || '')} · kênh ${ap.channel}">` +
          `<span class="sw" style="background:${col(ap)}"></span><span>${esc(trunc(nameOf(ap), 24))}</span><span class="v">${ap.rssi}</span></button>`
      )
      .join('');
  }
  function syncLegendHover() {
    for (const c of $$('.chip', $('#legend'))) c.style.outline = c.dataset.id === state.hoverId ? '1px solid var(--accent)' : '';
  }

  /* =====================================================================
   * 9. Tab 3 — Channel Rating
   * ===================================================================== */
  const VERDICT = { 5: 'Khuyên dùng', 4: 'Tốt', 3: 'Trung bình', 2: 'Nhiễu sóng nặng', 1: 'Nhiễu sóng nặng' };

  /**
   * Chấm điểm từng kênh 20 MHz: cộng công suất (mW) của mọi mạng có phổ chồng lên kênh đó, nhân với tỉ lệ chồng lấn
   * (cùng kênh = 100%, lệch 1 kênh 2.4 GHz = 75%, 2 kênh = 50%, 3 kênh = 25%, ≥4 kênh = 0%).
   */
  function rateChannels(band) {
    const aps = state.aps.filter((a) => a.band === band);
    const chans = band === '2.4' ? T24.slice(0, 13) : T5;
    return chans.map((ch) => {
      const fc = chToFreq(ch, band);
      const lo = fc - 10;
      const hi = fc + 10;
      let mw = 0;
      let co = 0;
      let adj = 0;
      for (const ap of aps) {
        const c = centerFreq(ap);
        const half = (ap.width || 20) / 2;
        const frac = Math.max(0, Math.min(hi, c + half) - Math.max(lo, c - half)) / 20;
        if (frac <= 0) continue;
        mw += Math.pow(10, ap.rssi / 10) * frac;
        if (ap.channel === ch) co++;
        else adj++;
      }
      const level = mw > 0 ? 10 * Math.log10(mw) : -100;
      const stars = level <= -92 ? 5 : level <= -85 ? 4 : level <= -75 ? 3 : level <= -65 ? 2 : 1;
      return {
        ch,
        level,
        stars,
        load: clamp((level + 100) / 45, 0, 1),
        co,
        adj,
        clean: band === '2.4' && (ch === 1 || ch === 6 || ch === 11),
        dfs: band === '5' && ch >= 52 && ch <= 144,
      };
    });
  }

  function renderRating() {
    const body = $('#ratingBody');
    const band = state.band;
    const bandName = BANDS[band].name;
    const rows = rateChannels(band);
    const count = state.aps.filter((a) => a.band === band).length;

    const pool = band === '2.4' ? rows.filter((r) => r.clean) : rows; // 2.4 GHz: chỉ khuyên 1/6/11 (không chồng lấn nhau)
    const best = [...pool].sort((a, b) => b.stars - a.stars || a.dfs - b.dfs || a.level - b.level || a.co + a.adj - (b.co + b.adj))[0];

    let headline;
    let sub;
    if (!state.scannedAt) {
      headline = 'Đang chờ dữ liệu quét…';
      sub = '';
    } else if (!count) {
      headline = `Chưa thấy mạng ${bandName} nào`;
      sub = 'Mọi kênh đều thoáng.';
    } else {
      headline = best.stars >= 4 ? `Nên chọn kênh ${best.ch}` : `Băng ${bandName} khá đông — kênh ${best.ch} là ít tệ nhất`;
      sub = `Dựa trên ${count} mạng đang phát ở băng ${bandName}.` + (band === '2.4' ? ' Với 2.4 GHz chỉ nên dùng kênh 1, 6 hoặc 11 vì ba kênh này không chồng lấn nhau.' : best.dfs ? ' Kênh DFS có thể tự đổi khi router phát hiện radar.' : '');
    }

    const stars = (n) => `<span class="stars s${n}" aria-label="${n} trên 5 sao">${'★'.repeat(n)}<span class="off">${'★'.repeat(5 - n)}</span></span>`;
    const ordered = state.ratingSort === 'rating' ? [...rows].sort((a, b) => b.stars - a.stars || a.level - b.level || a.ch - b.ch) : rows;

    body.innerHTML =
      `<div class="summary"><div class="big s${best ? best.stars : 3}" aria-hidden="true">${best && count ? best.ch : '—'}</div>` +
      `<div class="txt"><strong>${esc(headline)}</strong><p>${esc(sub)}</p></div>${best && count ? stars(best.stars) : ''}</div>` +
      `<div class="rows">${ordered
        .map((r) => {
          const tags = (r.clean ? '<span class="tag">không chồng lấn</span> ' : '') + (r.dfs ? '<span class="tag">DFS</span>' : '');
          const warn = r.stars <= 2 ? '⚠ ' : '';
          return (
            `<div class="rrow${best && count && r.ch === best.ch ? ' best' : ''}">` +
            `<div class="ch">${r.ch}<small>${chToFreq(r.ch, band)}</small></div>` +
            `<div>${stars(r.stars)}</div>` +
            `<div class="meter" title="Mức nhiễu ước tính ${r.level <= -100 ? '< -100' : r.level.toFixed(0)} dBm"><i class="f${r.stars}" style="width:${Math.max(3, Math.round(r.load * 100))}%"></i></div>` +
            `<div class="muted mono" style="font-size:12px">${r.co} trùng kênh · ${r.adj} chồng lấn</div>` +
            `<div class="verdict-wrap"><span class="verdict s${r.stars}">${warn}${VERDICT[r.stars]}</span> ${tags}</div></div>`
          );
        })
        .join('')}</div>`;
  }

  /* =====================================================================
   * 10. Tab 4 — AP List
   * ===================================================================== */
  const SORTERS = {
    ssid: (a) => clean(a.ssid).toLowerCase() || '￿',
    bssid: (a) => a.bssid || '',
    vendor: (a) => a.vendor.toLowerCase(),
    channel: (a) => a.channel,
    frequency: (a) => a.frequency,
    width: (a) => a.width,
    rssi: (a) => a.rssi,
    security: (a) => a.security.toLowerCase(),
    distance: (a) => (a.distance == null ? Infinity : a.distance),
  };

  function filteredAps() {
    const q = state.q.trim().toLowerCase();
    let list = state.aps.filter((ap) => {
      if (state.listBand !== 'all' && ap.band !== state.listBand) return false;
      if (state.listSec === 'secure' && !ap.secure) return false;
      if (state.listSec === 'open' && ap.secure) return false;
      if (!q) return true;
      return [clean(ap.ssid), ap.bssid, ap.vendor, ap.security, String(ap.channel), String(ap.frequency)].some((s) => String(s || '').toLowerCase().includes(q));
    });
    const get = SORTERS[state.sort.key];
    list = [...list].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      const c = typeof x === 'string' ? x.localeCompare(y, 'vi') : x - y;
      return (c || a.rssi - b.rssi) * state.sort.dir;
    });
    return list;
  }

  const rssiColor = (r) => (r >= -60 ? 'var(--good)' : r >= -75 ? 'var(--warn)' : 'var(--bad)');

  function renderList() {
    const list = filteredAps();
    $('#listCount').textContent = `${list.length}/${state.aps.length} mạng`;
    for (const th of $$('#apTable th')) {
      const on = th.dataset.key === state.sort.key;
      th.setAttribute('aria-sort', on ? (state.sort.dir > 0 ? 'ascending' : 'descending') : 'none');
      const btn = $('button', th);
      const base = btn.dataset.label || (btn.dataset.label = btn.textContent.replace(/[ ▲▼]+$/, ''));
      btn.textContent = on ? `${base} ${state.sort.dir > 0 ? '▲' : '▼'}` : base;
    }
    const body = $('#apBody');
    if (!list.length) {
      body.innerHTML = `<tr><td colspan="9" class="empty">${state.scannedAt ? 'Không có mạng nào khớp bộ lọc.' : 'Đang quét…'}</td></tr>`;
      return;
    }
    body.innerHTML = list
      .map((ap) => {
        const pct = clamp(((ap.rssi + 100) / 70) * 100, 2, 100);
        const sec = ap.secure ? esc(ap.security) : '<span class="sec-open">Mở (không mật khẩu)</span>';
        return (
          `<tr><td><span class="ssid"><span class="sw" style="background:${col(ap)};box-shadow:0 0 8px ${col(ap, 0.8)}"></span>` +
          (ap.hidden ? '<span class="name muted"><i>' + esc(nameOf(ap)) + '</i></span>' : `<span class="name" title="${esc(clean(ap.ssid))}">${esc(clean(ap.ssid))}</span>`) +
          (ap.secure ? lockSvg : '') +
          '</span></td>' +
          `<td class="mono">${esc(ap.bssid || '—')}</td>` +
          `<td>${esc(ap.vendor)}</td>` +
          `<td class="num mono">${ap.channel}</td>` +
          `<td class="num mono">${ap.frequency} MHz</td>` +
          `<td class="num mono"${ap.widthKnown ? '' : ' title="Hệ điều hành không cung cấp, mặc định 20 MHz"'}>${ap.width} MHz${ap.widthKnown ? '' : '*'}</td>` +
          `<td><span class="rssi"><span class="mono val">${ap.rssi} dBm</span><span class="meter"><i style="width:${pct.toFixed(0)}%;background:${rssiColor(ap.rssi)}"></i></span></span></td>` +
          `<td>${sec}</td>` +
          `<td class="num mono">${fmtDist(ap.distance)}</td></tr>`
        );
      })
      .join('');
  }

  function exportCsv() {
    const cell = (v) => {
      let s = String(v == null ? '' : v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // chặn CSV/formula injection (SSID là dữ liệu từ bên ngoài)
      return `"${s.replace(/"/g, '""')}"`;
    };
    const head = ['SSID', 'BSSID', 'Hãng', 'Băng tần', 'Kênh', 'Tần số (MHz)', 'Độ rộng (MHz)', 'RSSI (dBm)', 'Bảo mật', 'Khoảng cách ước tính (m)'];
    const lines = [head, ...filteredAps().map((a) => [clean(a.ssid), a.bssid, a.vendor, a.band, a.channel, a.frequency, a.width, a.rssi, a.security, a.distance])];
    const csv = '﻿' + lines.map((r) => r.map(cell).join(',')).join('\r\n');
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const name = `wifi-scan-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.csv`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /* =====================================================================
   * 11. Khởi tạo và gắn sự kiện
   * ===================================================================== */
  function bind() {
    // Tabs (hỗ trợ bàn phím: mũi tên, Home, End)
    const tabs = $$('.tab');
    for (const t of tabs) t.addEventListener('click', () => setTab(t.dataset.tab));
    $('.tabs').addEventListener('keydown', (e) => {
      const i = tabs.findIndex((t) => t.dataset.tab === state.tab);
      let n = -1;
      if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = tabs.length - 1;
      if (n >= 0) {
        e.preventDefault();
        setTab(tabs[n].dataset.tab, true);
      }
    });

    // Nhóm nút chọn (băng tần, sắp xếp…)
    for (const g of $$('[data-seg]')) {
      g.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        state[g.dataset.seg] = b.dataset.v;
        save();
        syncSegs();
        renderActive();
      });
    }

    // Điều khiển quét
    const auto = $('#autoToggle');
    const sel = $('#intervalSel');
    const demo = $('#demoToggle');
    auto.checked = state.auto;
    sel.value = String(state.interval);
    demo.checked = state.demo;
    auto.addEventListener('change', () => {
      state.auto = auto.checked;
      save();
      if (state.auto) scanOnce().then(schedule);
      else clearTimeout(timer);
    });
    sel.addEventListener('change', () => {
      state.interval = Number(sel.value);
      save();
      schedule();
    });
    $('#scanNow').addEventListener('click', () => scanOnce().then(schedule));
    const setDemo = (on) => {
      state.demo = on;
      demo.checked = on;
      save();
      resetData();
      hideBanner();
      updateStatus();
      renderActive();
      scanOnce().then(schedule);
    };
    demo.addEventListener('change', () => setDemo(demo.checked));
    $('#bannerDemo').addEventListener('click', () => setDemo(true));

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) clearTimeout(timer);
      else {
        requestDraw();
        if (state.auto) scanOnce().then(schedule);
      }
    });

    // Time Graph
    $('#legend').addEventListener('click', (e) => {
      const c = e.target.closest('.chip');
      if (!c) return;
      const id = c.dataset.id;
      if (state.hidden.has(id)) state.hidden.delete(id);
      else state.hidden.add(id);
      renderLegend();
    });
    $('#legend').addEventListener('pointerover', (e) => {
      const c = e.target.closest('.chip');
      state.hoverId = c ? c.dataset.id : null;
    });
    $('#legend').addEventListener('pointerleave', () => (state.hoverId = null));
    $('#showAllSeries').addEventListener('click', () => {
      state.hidden.clear();
      renderLegend();
    });

    // AP List
    $('#search').addEventListener('input', (e) => {
      state.q = e.target.value;
      renderList();
    });
    const lb = $('#listBand');
    const ls = $('#listSec');
    lb.value = state.listBand;
    ls.value = state.listSec;
    lb.addEventListener('change', () => ((state.listBand = lb.value), save(), renderList()));
    ls.addEventListener('change', () => ((state.listSec = ls.value), save(), renderList()));
    $('#apTable thead').addEventListener('click', (e) => {
      const th = e.target.closest('th');
      if (!th) return;
      const key = th.dataset.key;
      state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: ['rssi'].includes(key) ? -1 : 1 };
      renderList();
    });
    $('#exportCsv').addEventListener('click', exportCsv);

    bindChannelHover();
    bindTimeHover();

    if ('ResizeObserver' in window) {
      const ro = new ResizeObserver(() => requestDraw());
      ro.observe($('#wrap-channel'));
      ro.observe($('#wrap-time'));
    } else window.addEventListener('resize', requestDraw);
  }

  async function init() {
    bind();
    syncSegs();
    setTab(state.tab);
    updateStatus();
    try {
      const info = await (await fetch('/api/info', { cache: 'no-store' })).json();
      if (info.forceDemo) {
        state.forceDemo = true;
        state.demo = true;
        const d = $('#demoToggle');
        d.checked = true;
        d.disabled = true;
        d.closest('label').title = 'Server đang chạy với --demo / WIFI_DEMO=1';
      }
    } catch (_) {
      /* scanOnce sẽ báo lỗi kết nối */
    }
    await scanOnce();
    schedule();
  }

  init();
})();
