# WiFi Analyzer

Ứng dụng web phân tích Wi-Fi xung quanh (lấy cảm hứng từ WiFi Analyzer): Channel Graph, Time Graph, Channel Rating, AP List.

## Chạy

Cần Node.js >= 18, và **phải chạy trên máy có card Wi-Fi** (không quét được trên máy chủ/cloud).

    npm install
    npm start          # quét Wi-Fi thật  ->  http://127.0.0.1:3000
    npm run demo       # dữ liệu giả lập để xem thử giao diện
    npm test           # chạy test cho các parser

Đổi cổng: `PORT=3001 npm start` (Windows PowerShell: `$env:PORT=3001; npm start`).

## Quét bằng gì

1. `node-wifi` trước, nếu lỗi thì dùng lệnh gốc: `netsh wlan show networks mode=bssid` (Windows), `airport -s` (macOS), `nmcli` (Linux).
2. Mặc định server chỉ lắng nghe `127.0.0.1` vì danh sách Wi-Fi xung quanh là thông tin nhạy cảm. Chỉ đặt `HOST=0.0.0.0` khi thật sự cần.

## Lưu ý theo hệ điều hành

- **Windows 11 24H2+**: bật Cài đặt > Quyền riêng tư > Vị trí, nếu không `netsh` không trả về mạng nào.
- **Windows**: `netsh` không cho biết Channel Width, nên mọi mạng hiển thị 20 MHz (có dấu `*`).
- **macOS 14.4+**: Apple đã gỡ lệnh `airport`, nên không quét được bằng cách này.
- **Linux**: cần NetworkManager (`nmcli`).

## Khoảng cách ước tính

`d = 10^((27.55 - 20·log10(f_MHz) + |RSSI|) / 20)` — chỉ là ước lượng thô, tường và công suất phát thực tế làm sai lệch đáng kể.
