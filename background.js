// ASMR One 批量下载器 - 后台
// 下载通过 Native Messaging Host + curl 直写磁盘（可指定绝对路径，不弹窗，不影响 Edge 全局设置）

const HOST_NAME = 'com.asmr.downloader';
const CONCURRENCY = 3;
const MAX_RETRY = 3;

let port = null;
let portPending = [];       // 连接前缓存的消息
let queue = [];             // 待发送任务
let active = 0;
let stats = { total: 0, done: 0, failed: 0 };
let running = new Map();    // taskId -> {url, dest, retries}
let files = new Map();      // dest -> {size,total,status,error,via}  逐文件状态（面板据此画进度）
let keepAliveAlarm = null;

function setFile(dest, patch) {
  if (!dest) return;
  const cur = files.get(dest) || { size: 0, total: 0, status: 'wait', error: '', via: '' };
  files.set(dest, { ...cur, ...patch });
}

// ---------- Native 连接管理 ----------
function ensurePort() {
  if (port) return port;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    console.error('connectNative failed', e);
    return null;
  }
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => {
    // 断开：可能 SW 休眠或 host 崩溃；标记进行中任务为失败待重试
    const msg = chrome.runtime.lastError;
    const failedTasks = Array.from(running.values());
    running.clear();
    active = 0;
    port = null;
    for (const t of failedTasks) {
      t.retries++;
      if (t.retries <= MAX_RETRY) queue.unshift(t);
      else {
        stats.failed++;
        setFile(t.dest, { status: 'fail', error: msg ? msg.message : 'host disconnected' });
        broadcast({ event: 'fail', dest: t.dest, reason: msg ? msg.message : 'host disconnected' });
      }
    }
    // 重连并同步
    setTimeout(() => {
      const p = ensurePort();
      if (p) {
        sendToHost({ cmd: 'sync', id: 'sync-' + Date.now() });
        pump();
      }
    }, 500);
    pump();
  });
  return port;
}

function sendToHost(msg) {
  const p = ensurePort();
  if (!p) { portPending.push(msg); return; }
  try { p.postMessage(msg); } catch (e) { portPending.push(msg); }
}

function onHostMessage(msg) {
  if (!msg || !msg.event) return;
  if (msg.event === 'pong' || msg.event === 'sync') {
    // 重连后同步：清理不存在的任务
    if (msg.event === 'sync' && msg.tasks) {
      const live = new Set(msg.tasks.map(t => t.id));
      for (const id of running.keys()) {
        if (!live.has(id)) {
          const t = running.get(id);
          running.delete(id);
          active = Math.max(0, active - 1);
          t.retries++;
          if (t.retries <= MAX_RETRY) queue.unshift(t);
          else {
            stats.failed++;
            setFile(t.dest, { status: 'fail', error: 'host restarted' });
            broadcast({ event: 'fail', dest: t.dest, reason: 'host restarted' });
          }
        }
      }
      pump();
    }
    return;
  }
  if (msg.event === 'start') { /* 已发出 */ return; }
  if (msg.event === 'progress') {
    setFile(msg.dest, { size: msg.size || 0, total: msg.total || (files.get(msg.dest) || {}).total || 0, status: 'run' });
    broadcast({ event: 'progress', dest: msg.dest, size: msg.size });
    return;
  }
  if (msg.event === 'done') {
    const t = running.get(msg.id);
    if (t) { running.delete(msg.id); active = Math.max(0, active - 1); stats.done++; }
    setFile(msg.dest, { size: msg.size || 0, status: 'done', error: '', via: msg.via || '' });
    broadcast({ event: 'done', dest: msg.dest, size: msg.size });
    pump();
    return;
  }
  if (msg.event === 'error') {
    const t = running.get(msg.id);
    if (t) {
      running.delete(msg.id);
      active = Math.max(0, active - 1);
      t.retries++;
      if (t.retries <= MAX_RETRY) {
        queue.unshift(t);                       // 重试中：状态仍是 run，别让面板判失败
        setFile(t.dest, { status: 'run', error: '' });
      } else {
        stats.failed++;
        setFile(t.dest, { status: 'fail', error: msg.error || ('curl code ' + msg.code) });
        broadcast({ event: 'fail', dest: t.dest, reason: msg.error || ('curl code ' + msg.code) });
      }
    }
    pump();
    return;
  }
  if (msg.event === 'aborted' || msg.event === 'aborted_all') {
    running.clear();
    active = 0;
    pump();
    return;
  }
}

// ---------- 下载调度 ----------
function pump() {
  while (active < CONCURRENCY && queue.length > 0) {
    const t = queue.shift();
    const id = 't' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    running.set(id, t);
    active++;
    sendToHost({ id, cmd: 'download', url: t.url, dest: t.dest, expectSize: t.expectSize, proxy: t.proxy });
  }
  broadcast();
  if (active === 0 && queue.length === 0) {
    stopKeepAlive();
    setTimeout(() => broadcast(), 400);
  } else {
    startKeepAlive();
  }
}

// ---------- 消息入口 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SHOW_PANEL') { sendResponse({ ok: true }); return true; }
  if (msg.type === 'START_DOWNLOADS') {
    const items = msg.items;
    if (!items || items.length === 0) return;
    queue = items.map(it => ({ url: it.url, dest: it.dest, expectSize: it.expectSize || 0, proxy: it.proxy, retries: 0 }));
    stats = { total: items.length, done: 0, failed: 0 };
    active = 0;
    running.clear();
    files.clear();
    for (const it of items) files.set(it.dest, { size: 0, total: it.expectSize || 0, status: 'wait', error: '', via: '' });
    // 冲刷 pending
    while (portPending.length > 0) sendToHost(portPending.shift());
    pump();
    sendResponse({ ok: true, total: items.length });
    return true;
  }
  if (msg.type === 'GET_STATUS') {
    sendResponse({
      ...stats, queue: queue.length, active,
      files: Array.from(files, ([dest, v]) => ({ dest, ...v })),
    });
    return true;
  }
  if (msg.type === 'ABORT_ALL') {
    sendToHost({ cmd: 'abort_all', id: 'abort-' + Date.now() });
    queue = [];
    running.clear();
    active = 0;
    for (const [dest, v] of files) {
      if (v.status === 'wait' || v.status === 'run') files.set(dest, { ...v, status: 'fail', error: '已取消' });
    }
    sendResponse({ ok: true });
    return true;
  }
});

// ---------- 工具栏图标 ----------
chrome.action.onClicked.addListener((tab) => {
  if (!tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'SHOW_PANEL' }).catch(() => {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});
  });
});

// ---------- SW 保活（下载期间每 30s 唤醒一次） ----------
function startKeepAlive() {
  if (keepAliveAlarm) return;
  chrome.alarms.create('asmr-dl-keepalive', { periodInMinutes: 0.5 });
  keepAliveAlarm = true;
}
function stopKeepAlive() {
  if (!keepAliveAlarm) return;
  chrome.alarms.clear('asmr-dl-keepalive');
  keepAliveAlarm = false;
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'asmr-dl-keepalive') {
    // 保持 SW 活跃；同时 ping host 确认存活
    const p = ensurePort();
    if (p) sendToHost({ cmd: 'ping', id: 'ping-' + Date.now() });
  }
});

// ---------- 广播 ----------
function broadcast(extra) {
  chrome.runtime.sendMessage({ type: 'DL_STATUS', ...stats, queue: queue.length, active, extra: extra || null }).catch(() => {});
}
