// ASMR One 下载器 - Native Messaging Host
// 接收插件的下载任务，用 curl 直接下载到目标绝对路径（走 socks5 代理）
// 注意：目录由 node mkdirSync 预创建（curl --create-dirs 在 Windows 中文路径下有 bug，不用）
// 协议：stdin/stdout 4字节小端长度前缀 + JSON
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const DEFAULT_PROXY = 'socks5h://127.0.0.1:7892';
const tasks = new Map(); // id -> {child, timer, dest, expectSize}

// curl 退出码里「换条路可能还救得回来」的那几个（连不上/超时/TLS/空回包/传输中断）
const TRANSPORT_CODES = new Set([6, 7, 16, 18, 28, 35, 52, 55, 56, 92]);

// 直连优先的域名：媒体 CDN 本机不被墙，走代理反而更慢、还多一处故障点
const DIRECT_FIRST_HOSTS = new Set(['raw.kiko-play-niptan.one']);

// 代理端口是否真的在听：没开就别拿 curl 去撞它（否则每个文件都秒失败 exit 7）
function proxyReachable(proxyUrl, timeout = 700) {
  return new Promise((resolve) => {
    let host, port;
    try {
      const u = new URL(proxyUrl);
      host = u.hostname;
      const isSocks = /^socks/.test(u.protocol);
      port = Number(u.port) || (isSocks ? 1080 : 8080);
    } catch (e) { return resolve(false); }
    const s = net.connect({ host, port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { s.destroy(); } catch (e) {}
      resolve(ok);
    };
    s.setTimeout(timeout, () => finish(false));
    s.on('connect', () => finish(true));
    s.on('error', () => finish(false));
  });
}

// ---------- 通信 ----------
let buf = Buffer.alloc(0);
function send(obj) {
  const data = Buffer.from(JSON.stringify(obj), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(data.length, 0);
  process.stdout.write(Buffer.concat([len, data]));
}
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const raw = buf.subarray(4, 4 + len).toString('utf8');
    buf = buf.subarray(4 + len);
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { send({ id: null, event: 'error', error: 'bad message' }); continue; }
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));

// ---------- 命令 ----------
function handle(msg) {
  if (!msg || !msg.cmd) return;
  if (msg.cmd === 'ping') { send({ id: msg.id, event: 'pong' }); return; }
  if (msg.cmd === 'sync') {
    const list = [];
    for (const [id, t] of tasks) {
      list.push({ id, dest: t.dest, running: t.child !== null, size: t.size || 0 });
    }
    send({ id: msg.id, event: 'sync', tasks: list });
    return;
  }
  if (msg.cmd === 'download') { startDownload(msg); return; }
  if (msg.cmd === 'abort') {
    const t = tasks.get(msg.id);
    if (t && t.child) { try { t.child.kill(); } catch (e) {} }
    send({ id: msg.id, event: 'aborted' });
    return;
  }
  if (msg.cmd === 'abort_all') {
    for (const [, t] of tasks) { if (t.child) { try { t.child.kill(); } catch (e) {} } }
    send({ id: msg.id, event: 'aborted_all' });
    return;
  }
}

async function startDownload(msg) {
  const dest = String(msg.dest || '');
  if (!/^[A-Za-z]:[\\/]/.test(dest)) {
    send({ id: msg.id, event: 'error', dest, error: 'dest must be absolute path' });
    return;
  }
  try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch (e) {
    send({ id: msg.id, event: 'error', dest, error: 'mkdir failed: ' + e.message });
    return;
  }
  const proxy = msg.proxy === undefined ? DEFAULT_PROXY : msg.proxy;
  const expectSize = msg.expectSize || 0;
  // 路线：媒体 CDN 直连优先、失败再上代理；其它域名代理优先、失败再直连
  // 理由：墙的只是站点与 API 域，媒体域 raw.kiko-play-niptan.one 本机可直连，
  //       不该让一个没起来的 7892 把所有下载判死刑。
  const directFirst = DIRECT_FIRST_HOSTS.has(hostOf(msg.url));
  const proxyOk = proxy ? await proxyReachable(proxy) : false;
  const routes = directFirst
    ? (proxyOk ? [null, proxy] : [null])
    : (proxyOk ? [proxy, null] : [null]);
  attempt(msg, dest, expectSize, routes, 0);
}

function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch (e) { return ''; }
}

function attempt(msg, dest, expectSize, routes, idx, noResume) {
  const proxy = routes[idx];
  let written = 0;
  try { written = fs.existsSync(dest) ? fs.statSync(dest).size : 0; } catch (e) {}
  const resume = written > 0 && !noResume;
  const args = ['-sS', '-f', '-L', '--retry', '3', '--retry-delay', '2', '--connect-timeout', '20'];
  if (resume) args.push('-C', '-');
  if (proxy) args.push('-x', proxy);
  args.push('-o', dest, msg.url);
  const child = spawn('curl.exe', args, { windowsHide: true });
  let stderr = '';
  const rec = { child, dest, expectSize, size: 0, stderr: '' };
  child.stderr.on('data', d => { rec.stderr += d.toString(); });
  // 进度：每 500ms 报一次当前落盘大小（**不管有没有变化**——面板要能算出速度、也能看出卡住）
  rec.timer = setInterval(() => {
    let s = 0;
    try { if (fs.existsSync(dest)) s = fs.statSync(dest).size; } catch (e) {}
    rec.size = s;
    send({ id: msg.id, event: 'progress', dest, size: s, total: expectSize, via: proxy ? 'proxy' : 'direct', ts: Date.now() });
  }, 500);
  child.on('error', (err) => {
    clearInterval(rec.timer);
    tasks.delete(msg.id);
    send({ id: msg.id, event: 'error', dest, error: err.message });
  });
  child.on('close', (code) => {
    clearInterval(rec.timer);
    tasks.delete(msg.id);
    if (code === 0) {
      let size = 0;
      try { size = fs.statSync(dest).size; } catch (e) {}
      if (expectSize && size !== expectSize) {
        send({ id: msg.id, event: 'error', dest, code: 'SIZE_MISMATCH', error: 'expected ' + expectSize + ' got ' + size, stderr: rec.stderr.slice(0, 500) });
      } else {
        send({ id: msg.id, event: 'done', dest, size, via: proxy ? 'proxy' : 'direct' });
      }
      return;
    }
    // 服务器不吃 Range（33）→ 删残件、从头再来一次
    if (code === 33 && !noResume) {
      try { fs.unlinkSync(dest); } catch (e) {}
      attempt(msg, dest, expectSize, routes, idx, true);
      return;
    }
    // 这一路是传输类失败 → 还有下一路（直连）就换过去再试
    if (idx + 1 < routes.length && TRANSPORT_CODES.has(code)) {
      process.stderr.write('[native-host] via=' + (proxy || 'direct') + ' curl exit ' + code + ' → 换 ' + (routes[idx + 1] || 'direct') + '\n');
      attempt(msg, dest, expectSize, routes, idx + 1, false);
      return;
    }
    send({ id: msg.id, event: 'error', dest, code, error: rec.stderr.slice(0, 500) || ('curl exit ' + code) });
  });
  tasks.set(msg.id, rec);
  if (idx === 0) send({ id: msg.id, event: 'start', dest, via: proxy ? 'proxy' : 'direct' });
}
