'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseNetsh, parseAirport, parseNmcli, splitTerse, normSecurity } = require('../lib/parsers');
const { estimateDistance, channelToFreq, freqToChannel, normalizeMac } = require('../lib/rf');
const { vendorOf } = require('../lib/oui');
const { normalizeAll } = require('../lib/scanner');

const NETSH_EN = `
Interface name : Wi-Fi
There are 3 networks currently visible.

SSID 1 : Nha_Cua_Em
    Network type            : Infrastructure
    Authentication          : WPA2-Personal
    Encryption              : CCMP
    BSSID 1                 : f4:f2:6d:11:22:33
         Signal             : 94%
         Radio type         : 802.11n
         Channel            : 6
         Basic rates (Mbps) : 1 2 5.5 11
         Other rates (Mbps) : 6 9 12 18 24 36 48 54
    BSSID 2                 : f4:f2:6d:11:22:34
         Signal             : 80%
         Radio type         : 802.11ac
         Band               : 5 GHz
         Channel            : 36
         Basic rates (Mbps) : 6 12 24
         Other rates (Mbps) : 9 18 36 48 54

SSID 2 :
    Network type            : Infrastructure
    Authentication          : Open
    Encryption              : None
    BSSID 1                 : aa:bb:cc:dd:ee:ff
         Signal             : 40%
         Radio type         : 802.11g
         Channel            : 11
         Basic rates (Mbps) : 1 2 5.5 11

SSID 3 : Cafe WPA3
    Network type            : Infrastructure
    Authentication          : WPA3-Personal
    Encryption              : CCMP
    BSSID 1                 : 10:57:25:77:88:99
         Signal             : 66%
         Radio type         : 802.11ax
         Channel            : 149
`;

// Windows tiếng Việt: nhãn bị dịch, parser phải vẫn hiểu được
const NETSH_VI = `
Tên giao diện : Wi-Fi
Có 1 mạng hiện đang hiển thị.

SSID 1 : Quán Cà Phê
    Loại mạng               : Cơ sở hạ tầng
    Xác thực                : WPA2-Personal
    Mã hóa                  : CCMP
    BSSID 1                 : 34:08:04:1a:2b:3c
         Tín hiệu           : 70%
         Loại radio         : 802.11n
         Kênh               : 1
         Tốc độ cơ bản (Mbps) : 1 2 5.5 11
`;

const AIRPORT = `                            SSID BSSID             RSSI CHANNEL HT CC SECURITY (auth/unicast/group)
                      Nha Cua Em f4:f2:6d:11:22:33 -48  6       Y  VN WPA2(PSK/AES/AES)
                   Nha_Cua_Em_5G f4:f2:6d:11:22:34 -55  36,+1   Y  VN WPA2(PSK/AES/AES)
                        CafeFree 34:8:4:1a:2b:3c -80  1       Y  -- NONE
                          Office 10:57:25:77:88:99 -70  149,80  Y  VN WPA2(802.1X/AES/AES)
                                 aa:bb:cc:dd:ee:01 -85  11      Y  VN WPA3(SAE/AES/AES)
`;

const NMCLI_W = [
  'F4\\:F2\\:6D\\:11\\:22\\:33:Nha_Cua_Em:6:2437 MHz:92:WPA2:20 MHz',
  'F4\\:F2\\:6D\\:11\\:22\\:34:Nha_Cua_Em_5G:36:5180 MHz:75:WPA2 WPA3:80 MHz',
  '34\\:08\\:04\\:1A\\:2B\\:3C:My\\:Wifi\\\\Net:1:2412 MHz:40:--:20 MHz',
  '10\\:57\\:25\\:77\\:88\\:99::100:5500 MHz:55:WPA2 802.1X:40 MHz',
].join('\n');

test('normalizeMac xử lý octet thiếu số 0', () => {
  assert.equal(normalizeMac('34:8:4:1a:2b:3c'), '34:08:04:1A:2B:3C');
  assert.equal(normalizeMac('aa-bb-cc-dd-ee-ff'), 'AA:BB:CC:DD:EE:FF');
  assert.equal(normalizeMac('garbage'), null);
});

test('đổi kênh <-> tần số', () => {
  assert.equal(channelToFreq(1), 2412);
  assert.equal(channelToFreq(6), 2437);
  assert.equal(channelToFreq(14), 2484);
  assert.equal(channelToFreq(36), 5180);
  assert.equal(channelToFreq(165), 5825);
  assert.equal(freqToChannel(2462), 11);
  assert.equal(freqToChannel(5745), 149);
  assert.equal(freqToChannel(2484), 14);
});

test('khoảng cách theo công thức của đề bài', () => {
  // f=2437 MHz, RSSI=-50  =>  10^((27.55 - 20*log10(2437) + 50)/20)
  const expected = Math.pow(10, (27.55 - 20 * Math.log10(2437) + 50) / 20);
  assert.equal(estimateDistance(2437, -50), Math.round(expected * 10) / 10);
  assert.ok(estimateDistance(2437, -50) > 2 && estimateDistance(2437, -50) < 5); // ~3.1 m
  assert.ok(estimateDistance(5180, -50) < estimateDistance(2437, -50)); // 5 GHz suy hao nhiều hơn -> khoảng cách nhỏ hơn
  assert.ok(estimateDistance(2437, -80) > estimateDistance(2437, -50));
  assert.equal(estimateDistance(null, -50), null);
});

test('netsh (tiếng Anh): SSID, BSSID, RSSI, kênh, băng tần, bảo mật', () => {
  const aps = parseNetsh(NETSH_EN);
  assert.equal(aps.length, 4);
  assert.deepEqual(
    aps.map((a) => [a.ssid, a.bssid, a.rssi, a.channel, a.security]),
    [
      ['Nha_Cua_Em', 'F4:F2:6D:11:22:33', -53, 6, 'WPA2-Personal'],
      ['Nha_Cua_Em', 'F4:F2:6D:11:22:34', -60, 36, 'WPA2-Personal'],
      ['', 'AA:BB:CC:DD:EE:FF', -80, 11, 'Open'],
      ['Cafe WPA3', '10:57:25:77:88:99', -67, 149, 'WPA3-Personal'],
    ]
  );
  assert.equal(aps[1].band, '5');
});

test('netsh (tiếng Việt): vẫn đọc đúng dù nhãn bị dịch', () => {
  const [ap] = parseNetsh(NETSH_VI);
  assert.equal(ap.ssid, 'Quán Cà Phê');
  assert.equal(ap.channel, 1);
  assert.equal(ap.rssi, -65);
  assert.equal(ap.security, 'WPA2-Personal');
});

test('airport -s: SSID có dấu cách, độ rộng kênh, BSSID thiếu số 0', () => {
  const aps = parseAirport(AIRPORT);
  assert.equal(aps.length, 5);
  assert.equal(aps[0].ssid, 'Nha Cua Em');
  assert.equal(aps[0].width, 20);
  assert.equal(aps[1].channel, 36);
  assert.equal(aps[1].width, 40);
  assert.equal(aps[2].bssid, '34:08:04:1A:2B:3C');
  assert.equal(aps[2].security, 'Open');
  assert.equal(aps[3].width, 80);
  assert.equal(aps[3].security, 'WPA2-Enterprise');
  assert.equal(aps[4].ssid, '');
  assert.equal(aps[4].security, 'WPA3-SAE');
});

test('nmcli terse: tách ký tự escape đúng', () => {
  assert.deepEqual(splitTerse('a\\:b:c\\\\d:e'), ['a:b', 'c\\d', 'e']);
  const aps = parseNmcli(NMCLI_W, true);
  assert.equal(aps.length, 4);
  assert.equal(aps[0].bssid, 'F4:F2:6D:11:22:33');
  assert.equal(aps[0].rssi, -54); // 92% -> 92/2-100
  assert.equal(aps[0].width, 20);
  assert.equal(aps[1].width, 80);
  assert.equal(aps[2].ssid, 'My:Wifi\\Net');
  assert.equal(aps[2].security, 'Open');
  assert.equal(aps[3].ssid, '');
  assert.equal(aps[3].frequency, 5500);
});

test('normSecurity', () => {
  assert.equal(normSecurity('--'), 'Open');
  assert.equal(normSecurity(''), 'Open');
  assert.equal(normSecurity('WPA2(PSK/AES/AES)'), 'WPA2-PSK');
  assert.equal(normSecurity('WPA1 WPA2'), 'WPA1 WPA2');
});

test('OUI: tra hãng, kể cả BSSID ảo (locally administered)', () => {
  assert.equal(vendorOf('F4:F2:6D:11:22:33'), 'TP-Link');
  assert.equal(vendorOf('00:0C:6E:44:55:66'), 'ASUS');
  assert.equal(vendorOf('18:59:36:12:34:56'), 'Xiaomi');
  assert.equal(vendorOf('F6:F2:6D:11:22:33'), 'TP-Link'); // bit local đã bị bật -> khôi phục
  assert.equal(vendorOf('DA:A1:19:00:00:01'), 'Địa chỉ ảo (Local)'); // bit local bật, hãng gốc không có trong IEEE
  assert.equal(vendorOf(null), 'Không rõ');
});

test('normalizeAll: loại trùng BSSID (giữ tín hiệu mạnh nhất), sắp theo RSSI, bỏ bản ghi hỏng', () => {
  const list = normalizeAll([
    { ssid: 'A', bssid: 'F4:F2:6D:00:00:01', rssi: -70, channel: 6, frequency: null, width: null, band: null, security: 'WPA2-PSK' },
    { ssid: 'A', bssid: 'F4:F2:6D:00:00:01', rssi: -50, channel: 6, frequency: null, width: 40, band: null, security: 'WPA2-PSK' },
    { ssid: 'B', bssid: 'F4:F2:6D:00:00:02', rssi: -60, channel: 44, frequency: null, width: null, band: null, security: 'Open' },
    { ssid: 'bad', bssid: 'F4:F2:6D:00:00:03', rssi: NaN, channel: 6, frequency: null, width: null, band: null, security: 'Open' },
    { ssid: 'bad2', bssid: 'F4:F2:6D:00:00:04', rssi: -60, channel: null, frequency: null, width: null, band: null, security: 'Open' },
  ]);
  assert.equal(list.length, 2);
  assert.equal(list[0].rssi, -50);
  assert.equal(list[0].width, 40);
  assert.equal(list[0].band, '2.4');
  assert.equal(list[1].band, '5');
  assert.equal(list[1].secure, false);
  assert.equal(list[0].vendor, 'TP-Link');
});
