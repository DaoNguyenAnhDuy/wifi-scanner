'use strict';
/**
 * Tra cứu nhà sản xuất từ địa chỉ MAC bằng cơ sở dữ liệu IEEE OUI (package `oui-data`).
 * - Ưu tiên khớp dài nhất (MA-S 36 bit -> MA-M 28 bit -> MA-L 24 bit).
 * - BSSID của SSID ảo (guest, mesh...) thường đặt bit "locally administered" nên không có trong IEEE;
 *   khi đó thử lại với bit này đã tắt để ra hãng của thiết bị gốc.
 */
let db = null;
try {
  db = require('oui-data');
} catch (_) {
  db = null; // không có package -> chỉ dùng bảng rút gọn bên dưới
}

// Bảng dự phòng nhỏ khi thiếu `oui-data` (chỉ vài tiền tố phổ biến đã kiểm chứng).
const FALLBACK = {
  F4F26D: 'TP-Link',
  '147590': 'TP-Link',
  '000C6E': 'ASUS',
  '185936': 'Xiaomi',
  '102407': 'Huawei',
  '105725': 'Cisco',
  '288088': 'Netgear',
  '340804': 'D-Link',
  '602232': 'Ubiquiti',
  '0495E6': 'Tenda',
  A06518: 'VNPT Technology',
  '240B2A': 'Viettel',
};

// Rút gọn tên pháp lý dài của IEEE thành tên thương hiệu dễ đọc.
const BRAND_RULES = [
  [/^TP-?LINK/i, 'TP-Link'],
  [/^Apple/i, 'Apple'],
  [/^ASUS/i, 'ASUS'],
  [/Xiaomi/i, 'Xiaomi'],
  [/^HUAWEI/i, 'Huawei'],
  [/^Cisco/i, 'Cisco'],
  [/^NETGEAR/i, 'Netgear'],
  [/^D-Link/i, 'D-Link'],
  [/Ubiquiti/i, 'Ubiquiti'],
  [/^Tenda/i, 'Tenda'],
  [/^Samsung/i, 'Samsung'],
  [/^Intel/i, 'Intel'],
  [/^Google/i, 'Google'],
  [/^Ruckus/i, 'Ruckus'],
  [/^ZTE/i, 'ZTE'],
  [/^Zyxel/i, 'Zyxel'],
  [/^Sagemcom/i, 'Sagemcom'],
  [/^Technicolor/i, 'Technicolor'],
  [/^Linksys/i, 'Linksys'],
  [/^Belkin/i, 'Belkin'],
  [/^MikroTik|^Routerboard/i, 'MikroTik'],
  [/^Aruba/i, 'Aruba'],
  [/^Espressif/i, 'Espressif'],
  [/^Realtek/i, 'Realtek'],
  [/^MediaTek/i, 'MediaTek'],
  [/^Amazon/i, 'Amazon'],
  [/^Microsoft/i, 'Microsoft'],
  [/^Sony/i, 'Sony'],
  [/^LG Electronics/i, 'LG'],
  [/^OPPO/i, 'OPPO'],
  [/^vivo/i, 'vivo'],
  [/^Honor|^Hihonor/i, 'Honor'],
  [/^VNPT/i, 'VNPT Technology'],
  [/^Viettel/i, 'Viettel'],
];

function shortName(raw) {
  let name = String(raw).split('\n')[0].trim();
  for (const [re, brand] of BRAND_RULES) if (re.test(name)) return brand;
  // Cắt hậu tố pháp lý: ", Inc." / "CO.,LTD" / "Technologies"...
  const suffix = /[,\s]+(co\.?\s*,?\s*ltd\.?|ltd\.?|inc\.?|corp(oration)?\.?|llc|gmbh|s\.?a\.?|limited|company|technologies|technology|electronics)\b.*$/i;
  for (let i = 0; i < 3; i++) name = name.replace(suffix, '').trim();
  return name || String(raw).split('\n')[0].trim();
}

function lookupHex(hex) {
  if (db) {
    for (const len of [9, 7, 6]) {
      const hit = db[hex.slice(0, len)];
      if (hit) return shortName(hit);
    }
    return null;
  }
  return FALLBACK[hex.slice(0, 6)] || null;
}

/** @returns {string} tên hãng, hoặc 'Không rõ' / 'Địa chỉ ảo (Local)'. */
function vendorOf(mac) {
  if (!mac) return 'Không rõ';
  const hex = String(mac).replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (hex.length < 6) return 'Không rõ';
  const firstByte = parseInt(hex.slice(0, 2), 16);
  if (firstByte & 0x02) {
    // Locally administered (SSID ảo/guest/mesh): IEEE không cấp OUI có bit này (trừ vài mã cổ điển như 02:xx),
    // nên bỏ bit đi để tìm hãng của thiết bị gốc.
    const base = (firstByte & ~0x02).toString(16).toUpperCase().padStart(2, '0') + hex.slice(2);
    const parent = lookupHex(base);
    if (parent && parent !== 'Private') return parent;
    return 'Địa chỉ ảo (Local)';
  }
  const found = lookupHex(hex);
  if (!found) return 'Không rõ';
  return found;
}

module.exports = { vendorOf, shortName };
