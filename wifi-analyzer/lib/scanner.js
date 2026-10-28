'use strict';
/**
 * Bộ quét Wi-Fi đa nền tảng.
 *   1) Thử `node-wifi` trước.
 *   2) Nếu lỗi/không có kết quả -> dùng lệnh gốc của hệ điều hành:
 *        Windows: netsh wlan show networks mode=bssid
 *        macOS  : airport -s
 *        Linux  : nmcli dev wifi list
 *   3) Nếu node-wifi chạy được nhưng thiếu độ rộng kênh (Channel Width), chạy thêm lệnh gốc để bổ sung theo BSSID.
 * Kết quả được chuẩn hoá, tra hãng sản xuất (OUI), tính khoảng cách ước tính.
 */
const os = require('os');
const { execFile } = require('child_process');
const { channelToFreq, freqToChannel, bandOf, estimateDistance, normalizeMac } = require('./rf');
const { parseNetsh, parseAirport, parseNmcli, normSecurity, isOpenSecurity } = require('./parsers');
const { vendorOf } = require('./oui');
const { demoScan } = require('./demo');

const PLATFORM = os.platform();
const AIRPORT = '/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport';
const MIN_INTERVAL_MS = 1500; // không quét dồn dập dù có nhiều client
const CMD_TIMEOUT_MS = 12000;

let nodeWifi = null;
try {
  nodeWifi = require('node-wifi');
  nodeWifi.init({ iface: null });
} catch (_) {
  nodeWifi = null;
}

class ScanError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint || '';
  }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: CMD_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: 'utf8', ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

/* -------------------------- Quét bằng lệnh gốc -------------------------- */

async function nativeScan() {
  if (PLATFORM === 'win32') {
    // chcp 65001 để SSID có dấu (tiếng Việt, v.v.) không bị lỗi mã hoá
    const out = await run('cmd.exe', ['/d', '/s', '/c', 'chcp 65001>nul && netsh wlan show networks mode=bssid']);
    return { source: 'netsh', aps: parseNetsh(out) };
  }
  if (PLATFORM === 'darwin') {
    const out = await run(AIRPORT, ['-s']);
    return { source: 'airport', aps: parseAirport(out) };
  }
  if (PLATFORM === 'linux') {
    const base = ['-t', '-f'];
    const tail = ['dev', 'wifi', 'list', '--rescan', 'auto'];
    try {
      const out = await run('nmcli', [...base, 'BSSID,SSID,CHAN,FREQ,SIGNAL,SECURITY,BANDWIDTH', ...tail]);
      return { source: 'nmcli', aps: parseNmcli(out, true) };
    } catch (e) {
      // nmcli cũ không có cột BANDWIDTH
      if (!/invalid field|BANDWIDTH/i.test(`${e.stderr || ''}${e.message}`)) throw e;
      const out = await run('nmcli', [...base, 'BSSID,SSID,CHAN,FREQ,SIGNAL,SECURITY', ...tail]);
      return { source: 'nmcli', aps: parseNmcli(out, false) };
    }
  }
  throw new ScanError(`Hệ điều hành "${PLATFORM}" chưa được hỗ trợ.`);
}

/* ---------------------------- Quét bằng node-wifi ---------------------------- */

async function nodeWifiScan() {
  if (!nodeWifi) throw new Error('node-wifi chưa được cài');
  const list = await nodeWifi.scan();
  const aps = (list || []).map((n) => ({
    ssid: n.ssid || '',
    bssid: normalizeMac(n.bssid || n.mac),
    rssi: Number.isFinite(Number(n.signal_level)) ? Number(n.signal_level) : null,
    channel: Number(n.channel) || null,
    frequency: Number(n.frequency) || null,
    width: null,
    band: null,
    security: normSecurity(n.security),
  }));
  return { source: 'node-wifi', aps };
}

/* ------------------------------ Chuẩn hoá ------------------------------ */

function finalize(r) {
  let channel = r.channel;
  let frequency = r.frequency;
  if (!frequency && channel) frequency = channelToFreq(channel, r.band === '6' ? '6' : undefined);
  if (!channel && frequency) channel = freqToChannel(frequency);
  if (!channel || !frequency) return null;

  const rssi = Math.max(-100, Math.min(-10, Math.round(Number(r.rssi))));
  if (!Number.isFinite(rssi)) return null;

  const bssid = r.bssid || null;
  const ssid = r.ssid || '';
  return {
    id: bssid || `${ssid}@${channel}`,
    ssid,
    hidden: !ssid,
    bssid,
    rssi,
    channel,
    frequency,
    band: r.band || bandOf(frequency),
    width: r.width || 20,
    widthKnown: Boolean(r.width),
    security: r.security || 'Unknown',
    secure: !isOpenSecurity(r.security),
    vendor: bssid ? vendorOf(bssid) : 'Không rõ',
    distance: estimateDistance(frequency, rssi),
  };
}

function normalizeAll(rawList) {
  const byId = new Map();
  for (const raw of rawList) {
    const ap = finalize(raw);
    if (!ap) continue;
    const prev = byId.get(ap.id);
    if (!prev || ap.rssi > prev.rssi) byId.set(ap.id, ap);
  }
  return [...byId.values()].sort((a, b) => b.rssi - a.rssi);
}

/* ----------------------------- Quét thật ----------------------------- */

function hintFor(err) {
  const msg = `${err && err.stderr ? err.stderr : ''} ${err && err.message ? err.message : ''}`;
  if (PLATFORM === 'win32') {
    if (/location|elevation|vị trí/i.test(msg)) return 'Windows 11 (24H2 trở lên) cần bật Cài đặt > Quyền riêng tư > Vị trí thì mới quét được Wi-Fi.';
    return 'Hãy bật Wi-Fi và kiểm tra dịch vụ WLAN AutoConfig đang chạy. Có thể thử chạy terminal bằng quyền Administrator.';
  }
  if (PLATFORM === 'darwin') {
    return 'macOS 14.4 trở lên đã gỡ lệnh "airport" nên không quét được bằng cách này; macOS cũ hơn cần cấp quyền Vị trí cho Terminal.';
  }
  if (PLATFORM === 'linux') return 'Cần cài NetworkManager (lệnh nmcli) và bật Wi-Fi: "nmcli radio wifi on".';
  return '';
}

async function realScan() {
  const errors = [];
  let primary = null;

  if (nodeWifi) {
    try {
      const res = await nodeWifiScan();
      if (res.aps.length) primary = res;
      else errors.push(new Error('node-wifi không trả về mạng nào'));
    } catch (e) {
      errors.push(e);
    }
  }

  if (primary) {
    // Bổ sung độ rộng kênh từ lệnh gốc (Windows netsh không có thông tin này nên bỏ qua)
    if (PLATFORM !== 'win32') {
      try {
        const native = await nativeScan();
        const widthByBssid = new Map(native.aps.filter((a) => a.bssid && a.width).map((a) => [a.bssid, a.width]));
        for (const ap of primary.aps) if (!ap.width && widthByBssid.has(ap.bssid)) ap.width = widthByBssid.get(ap.bssid);
      } catch (_) {
        /* bỏ qua: chỉ là bước bổ sung */
      }
    }
    return { source: primary.source, aps: normalizeAll(primary.aps) };
  }

  try {
    const native = await nativeScan();
    if (!native.aps.length) throw new ScanError('Không tìm thấy mạng Wi-Fi nào.', hintFor());
    return { source: native.source, aps: normalizeAll(native.aps) };
  } catch (e) {
    errors.push(e);
    const first = [...new Set(errors.map((x) => x && x.message).filter(Boolean))].join(' | ');
    throw new ScanError(`Không quét được Wi-Fi (${first || 'lỗi không rõ'})`, e.hint || hintFor(e));
  }
}

/* --------------------- Cache + gộp các lần quét đồng thời --------------------- */

let inflight = null;
let last = null; // { at, result }

async function getScan({ demo = false } = {}) {
  const now = Date.now();
  if (demo) {
    const aps = normalizeAll(demoScan(now));
    return { ok: true, source: 'demo', platform: PLATFORM, scannedAt: now, count: aps.length, aps };
  }
  if (last && now - last.at < MIN_INTERVAL_MS) return last.result;
  if (!inflight) {
    inflight = realScan()
      .then((res) => {
        const at = Date.now();
        const result = { ok: true, source: res.source, platform: PLATFORM, scannedAt: at, count: res.aps.length, aps: res.aps };
        last = { at, result };
        return result;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function info() {
  return {
    platform: PLATFORM,
    nodeWifi: Boolean(nodeWifi),
    nativeMethod: { win32: 'netsh', darwin: 'airport', linux: 'nmcli' }[PLATFORM] || null,
  };
}

module.exports = { getScan, info, ScanError, normalizeAll };
