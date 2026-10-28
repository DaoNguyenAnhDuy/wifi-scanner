'use strict';
/**
 * Tiện ích RF: đổi kênh <-> tần số, phân loại băng tần, ước tính khoảng cách.
 */

/** Kênh -> tần số trung tâm (MHz). band: '2.4' | '5' | '6' (cần khi kênh 1-14 bị trùng giữa 2.4 và 6 GHz). */
function channelToFreq(ch, band) {
  ch = Number(ch);
  if (!Number.isFinite(ch) || ch <= 0) return null;
  if (band === '6') return 5950 + 5 * ch;
  if (ch === 14) return 2484;
  if (ch >= 1 && ch <= 13) return 2407 + 5 * ch;
  if (ch >= 32 && ch <= 177) return 5000 + 5 * ch;
  return null;
}

/** Tần số (MHz) -> kênh. */
function freqToChannel(freq) {
  freq = Number(freq);
  if (!Number.isFinite(freq)) return null;
  if (freq === 2484) return 14;
  if (freq >= 2412 && freq <= 2472) return Math.round((freq - 2407) / 5);
  if (freq >= 5160 && freq <= 5895) return Math.round((freq - 5000) / 5);
  if (freq >= 5955 && freq <= 7115) return Math.round((freq - 5950) / 5);
  return null;
}

/** Tần số (MHz) -> băng tần. */
function bandOf(freq) {
  if (!freq) return null;
  if (freq < 3000) return '2.4';
  if (freq < 5900) return '5';
  return '6';
}

/** Phần trăm tín hiệu (0-100) -> dBm xấp xỉ (cách quy đổi thông dụng của Windows/NetworkManager). */
function percentToDbm(pct) {
  pct = Math.max(0, Math.min(100, Number(pct)));
  return Math.round(pct / 2 - 100);
}

/**
 * Khoảng cách ước tính (mét) theo mô hình suy hao không gian tự do:
 *   d = 10 ^ ((27.55 - 20*log10(f_MHz) + |RSSI|) / 20)
 * Đây chỉ là ước lượng thô: tường, vật cản và công suất phát thực tế sẽ làm sai lệch kết quả.
 */
function estimateDistance(freqMHz, rssi) {
  if (!freqMHz || !Number.isFinite(rssi)) return null;
  const d = Math.pow(10, (27.55 - 20 * Math.log10(freqMHz) + Math.abs(rssi)) / 20);
  return Number.isFinite(d) ? Math.round(d * 10) / 10 : null;
}

/** Chuẩn hoá MAC: 'a:b:c:d:e:f' / 'AA-BB-...' -> 'AA:BB:CC:DD:EE:FF'. */
function normalizeMac(mac) {
  if (!mac) return null;
  const parts = String(mac).trim().split(/[:\-]/);
  if (parts.length !== 6 || parts.some((p) => !/^[0-9a-fA-F]{1,2}$/.test(p))) return null;
  return parts.map((p) => p.padStart(2, '0').toUpperCase()).join(':');
}

module.exports = { channelToFreq, freqToChannel, bandOf, percentToDbm, estimateDistance, normalizeMac };
