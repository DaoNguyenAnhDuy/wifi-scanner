'use strict';
/**
 * Dữ liệu giả lập (demo) để xem thử giao diện khi không có card Wi-Fi hoặc khi chạy trên máy chủ không có phần cứng.
 * RSSI dao động theo thời gian để Time Graph và Channel Graph "sống".
 */
const APS = [
  // 2.4 GHz
  { ssid: 'Nha_Cua_Em', bssid: 'F4:F2:6D:11:22:33', channel: 6, width: 20, security: 'WPA2-PSK', base: -41 },
  { ssid: 'Nha_Cua_Em_Guest', bssid: 'F6:F2:6D:11:22:33', channel: 6, width: 20, security: 'WPA2-PSK', base: -44 },
  { ssid: 'VNPT_Fiber_8A2C', bssid: 'A0:65:18:8A:2C:01', channel: 1, width: 20, security: 'WPA2-PSK', base: -58 },
  { ssid: 'Viettel_Home', bssid: '24:0B:2A:5D:90:C4', channel: 11, width: 20, security: 'WPA2-PSK', base: -63 },
  { ssid: 'Tenda_B7E0', bssid: '04:95:E6:B7:E0:10', channel: 9, width: 40, security: 'WPA2-PSK', base: -71 },
  { ssid: 'Quan_Cafe_Free', bssid: '34:08:04:1A:2B:3C', channel: 3, width: 20, security: 'Open', base: -76 },
  { ssid: 'ASUS_Router_2G', bssid: '00:0C:6E:44:55:66', channel: 4, width: 20, security: 'WPA3-SAE', base: -68 },
  { ssid: '', bssid: '10:24:07:AA:BB:CC', channel: 13, width: 20, security: 'WPA2-PSK', base: -82 },
  { ssid: 'Xiaomi_Mesh', bssid: '18:59:36:12:34:56', channel: 7, width: 20, security: 'WPA2-PSK', base: -86 },
  // 5 GHz
  { ssid: 'Nha_Cua_Em_5G', bssid: 'F4:F2:6D:11:22:34', channel: 36, width: 80, security: 'WPA2-PSK', base: -47 },
  { ssid: 'ASUS_Router_5G', bssid: '00:0C:6E:44:55:67', channel: 44, width: 40, security: 'WPA3-SAE', base: -62 },
  { ssid: 'VNPT_Fiber_8A2C_5G', bssid: 'A0:65:18:8A:2C:02', channel: 149, width: 80, security: 'WPA2-PSK', base: -66 },
  { ssid: 'Cisco_Office', bssid: '10:57:25:77:88:99', channel: 100, width: 40, security: 'WPA2-Enterprise', base: -73 },
  { ssid: 'Ubiquiti_Lab', bssid: '60:22:32:0F:0E:0D', channel: 157, width: 20, security: 'WPA2-PSK', base: -79 },
  { ssid: 'Samsung_TV_Direct', bssid: '10:30:47:C0:FF:EE', channel: 161, width: 20, security: 'WPA2-PSK', base: -84 },
];

const { channelToFreq } = require('./rf');

/** Nhiễu giả ngẫu nhiên nhưng có tính xác định theo (seed, thời gian). */
function wobble(seed, t) {
  const x = Math.sin(seed * 12.9898 + t * 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1; // -1..1
}

function demoScan(now = Date.now()) {
  const t = now / 1000;
  // "Người đi bộ": cả nhà cùng yếu/mạnh dần theo chu kỳ ~40 giây để mô phỏng đi vào vùng chết.
  const walk = -9 * (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / 40));
  return APS.map((ap, i) => {
    const slow = 4 * Math.sin(t / (6 + i) + i);
    const jitter = 1.6 * wobble(i + 1, Math.floor(t));
    const rssi = Math.round(Math.max(-97, Math.min(-25, ap.base + slow + jitter + (i < 2 || i === 9 ? walk : walk * 0.4))));
    return {
      ssid: ap.ssid,
      bssid: ap.bssid,
      rssi,
      channel: ap.channel,
      frequency: channelToFreq(ap.channel),
      width: ap.width,
      band: null,
      security: ap.security,
    };
  });
}

module.exports = { demoScan };
