'use strict';
/**
 * Parser cho đầu ra của các lệnh quét Wi-Fi gốc của từng hệ điều hành.
 * Mỗi parser trả về mảng đối tượng thô:
 *   { ssid, bssid, rssi, channel, frequency, width, security, band }
 * (trường nào không có thì để null; bước `finalize` trong scanner.js sẽ bổ sung).
 */
const { normalizeMac, percentToDbm, freqToChannel } = require('./rf');

/* ----------------------------- Bảo mật ----------------------------- */

/** Chuẩn hoá chuỗi bảo mật từ mọi nguồn về dạng ngắn gọn dễ đọc. */
function normSecurity(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (!s || s === '--' || /^(none|open|không có|keine|aucun)$/i.test(s)) return 'Open';

  // Dạng macOS: WPA2(PSK/AES/AES), WPA3(SAE/AES/AES), WPA2(802.1X/AES/AES), WEP
  const mac = s.match(/^(WPA3|WPA2|WPA|WEP|RSN)\s*\(([^)]*)\)/i);
  if (mac) {
    const proto = mac[1].toUpperCase() === 'RSN' ? 'WPA2' : mac[1].toUpperCase();
    const auth = mac[2].split('/')[0].toUpperCase();
    if (auth.includes('802.1X') || auth.includes('EAP')) return `${proto}-Enterprise`;
    if (auth === 'SAE') return 'WPA3-SAE';
    if (auth === 'PSK') return `${proto}-PSK`;
    return proto;
  }
  return s.replace(/\s+/g, ' ');
}

const isOpenSecurity = (sec) => normSecurity(sec) === 'Open';

/* ----------------------------- Windows ----------------------------- */
/**
 * `netsh wlan show networks mode=bssid`
 * Nhãn (key) bị dịch theo ngôn ngữ Windows (vd. tiếng Việt, Đức, Pháp), nên parser dựa vào CẤU TRÚC thay vì tên nhãn:
 *   - "SSID n" / "BSSID n" thì giống nhau ở mọi ngôn ngữ.
 *   - Dòng có giá trị dạng "NN%" là độ mạnh tín hiệu.
 *   - Dòng giá trị là một số nguyên thuần đầu tiên sau tín hiệu là kênh.
 *   - Ba dòng đầu dưới SSID là: loại mạng, xác thực, mã hoá.
 */
function parseNetsh(text) {
  const aps = [];
  let info = null; // { name, kv: [] } cho SSID hiện tại
  let cur = null; // AP hiện tại
  let gotSignal = false;

  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*([^:]+?)\s*:\s?(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].trim();

    if (/^SSID\s+\d+$/i.test(key)) {
      info = { name: val, kv: [] };
      cur = null;
      continue;
    }
    if (/^BSSID\s+\d+$/i.test(key)) {
      cur = { ssid: info ? info.name : '', bssid: normalizeMac(val), rssi: null, channel: null, frequency: null, width: null, band: null, _info: info };
      gotSignal = false;
      aps.push(cur);
      continue;
    }
    if (!cur) {
      if (info) info.kv.push(val);
      continue;
    }

    if (/^\d{1,3}\s?%$/.test(val)) {
      cur.rssi = percentToDbm(parseInt(val, 10));
      gotSignal = true;
    } else if (gotSignal && cur.channel == null && /^\d{1,3}$/.test(val)) {
      cur.channel = parseInt(val, 10);
    } else {
      const band = val.match(/^(2\.4|5|6)(?:\.\d+)?\s?GHz$/i);
      if (band) cur.band = band[1];
      const bw = val.match(/^(\d{2,3})\s?MHz$/i);
      if (bw && /width|rộng|breite|largeur|ancho|larghezza/i.test(key)) cur.width = parseInt(bw[1], 10);
    }
  }

  return aps
    .filter((a) => a.bssid)
    .map((a) => {
      const [, auth = '', enc = ''] = a._info ? a._info.kv : [];
      const authOpen = /^(open|mở|offen|ouvert[e]?|abiert[ao]|apert[ao])$/i.test(auth);
      const encNone = /^(none|không có|keine|aucun[e]?|ningun[ao]|nessun[ao])$/i.test(enc);
      const security = authOpen ? (encNone ? 'Open' : 'WEP') : auth || 'Unknown';
      delete a._info;
      return { ...a, security: normSecurity(security) };
    });
}

/* ------------------------------- macOS ------------------------------ */
/**
 * `airport -s`
 *                SSID BSSID             RSSI CHANNEL HT CC SECURITY (auth/unicast/group)
 *           MyWifi   aa:bb:cc:dd:ee:ff -52  6       Y  VN WPA2(PSK/AES/AES)
 * CHANNEL có thể là "6", "36,+1" (40 MHz), "100,-1" (40 MHz), "42,80", "50,160".
 */
function parseAirport(text) {
  const out = [];
  const re = /^(.*?)\s+((?:[0-9a-f]{1,2}:){5}[0-9a-f]{1,2})\s+(-?\d+)\s+(\d+)(?:,([+-]?\d+))?\s+[YN]\s+(\S+)\s+(.+?)\s*$/i;
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(re);
    if (!m) continue;
    let width = 20;
    if (m[5]) {
      const w = parseInt(m[5], 10);
      width = Math.abs(w) === 1 ? 40 : w >= 40 ? w : 20;
    }
    out.push({
      ssid: m[1].trim(),
      bssid: normalizeMac(m[2]),
      rssi: parseInt(m[3], 10),
      channel: parseInt(m[4], 10),
      frequency: null,
      width,
      band: null,
      security: normSecurity(m[7]),
    });
  }
  return out;
}

/* ------------------------------- Linux ------------------------------ */
/** Tách một dòng nmcli ở chế độ -t (terse): ':' phân cách, '\:' và '\\' là ký tự escape. */
function splitTerse(line) {
  const fields = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
    } else if (c === ':') {
      fields.push(cur);
      cur = '';
    } else cur += c;
  }
  fields.push(cur);
  return fields;
}

/**
 * `nmcli -t -f BSSID,SSID,CHAN,FREQ,SIGNAL,SECURITY[,BANDWIDTH] dev wifi list`
 * @param {boolean} hasWidth cột cuối là BANDWIDTH (nmcli đời mới)
 */
function parseNmcli(text, hasWidth) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = splitTerse(line);
    const need = hasWidth ? 7 : 6;
    if (f.length < need) continue;
    // BSSID có 6 octet nên khi bị escape vẫn ra đúng 1 trường sau splitTerse
    const [bssid, ssid, chan, freq, signal, security, bandwidth] = f;
    const mac = normalizeMac(bssid);
    if (!mac) continue;
    const frequency = parseInt(freq, 10) || null;
    const width = hasWidth ? parseInt(bandwidth, 10) || null : null;
    out.push({
      ssid,
      bssid: mac,
      rssi: percentToDbm(parseInt(signal, 10) || 0),
      channel: parseInt(chan, 10) || (frequency ? freqToChannel(frequency) : null),
      frequency,
      width,
      band: null,
      security: normSecurity(security),
    });
  }
  return out;
}

module.exports = { parseNetsh, parseAirport, parseNmcli, splitTerse, normSecurity, isOpenSecurity };
