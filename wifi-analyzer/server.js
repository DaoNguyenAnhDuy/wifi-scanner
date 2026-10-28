'use strict';
const path = require('path');
const express = require('express');
const { getScan, info } = require('./lib/scanner');

const PORT = Number(process.env.PORT) || 3000;
// Mặc định chỉ lắng nghe trên máy bạn: danh sách Wi-Fi xung quanh là thông tin nhạy cảm, đừng mở ra LAN nếu không cần.
const HOST = process.env.HOST || '127.0.0.1';
const FORCE_DEMO = process.env.WIFI_DEMO === '1' || process.argv.includes('--demo');

const app = express();
app.disable('x-powered-by');

app.get('/api/info', (_req, res) => {
  res.json({ ...info(), forceDemo: FORCE_DEMO });
});

app.get('/api/scan', async (req, res) => {
  const demo = FORCE_DEMO || req.query.demo === '1';
  res.set('Cache-Control', 'no-store');
  try {
    res.json(await getScan({ demo }));
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message, hint: err.hint || '' });
  }
});

app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0 }));

const server = app.listen(PORT, HOST, () => {
  const i = info();
  console.log(`\n  Wi-Fi Analyzer đang chạy:  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  Hệ điều hành: ${i.platform} | node-wifi: ${i.nodeWifi ? 'có' : 'không'} | lệnh gốc: ${i.nativeMethod || 'không có'}`);
  if (FORCE_DEMO) console.log('  Chế độ DEMO đang bật (dữ liệu giả lập).');
  console.log('  Nhấn Ctrl+C để dừng.\n');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Cổng ${PORT} đang bận. Thử: PORT=3001 npm start`);
  else console.error(e);
  process.exit(1);
});
