// ASMR One 批量下载器 - 内容脚本 v4
// 文件树（三态勾选/折叠）+ 过滤 + 收藏目录选择器 + 批量下载（native host + curl）

(() => {
  if (window.__asmrOneDownloaderLoaded) return;
  window.__asmrOneDownloaderLoaded = true;

  // ============ API 服务器（对应站点『选择服务器』：latest / original / mirror-*）============
  // 这个站有多个 API 镜像域名，不同网络/时段可用性不同。
  // 2026-10-25 主人定：**平时直连主域，慢了才换台**——所以不再是「谁最快用谁」，
  // 而是「主域活着且不慢就用主域」；主域挂了/慢才退到最快的镜像。
  // 名单要改只动这一处（取自站点『选择服务器』列表与证书缓存）。
  const API_HOSTS = [
    'https://api.asmr.one',      // 主域（站点当前默认）——直连优先
    'https://api.asmr-100.com',  // mirror-100
    'https://api.asmr-200.com',  // mirror-200
    'https://api.asmr-300.com',  // mirror-300
  ];
  const API_PRIMARY = 'https://api.asmr.one';
  const SLOW_PROBE_MS = 1200;       // 主域探活超过这个延迟 → 认为「慢」，让位给最快镜像
  const SLOW_REQUEST_MS = 2500;     // 单次真实请求超过这个 → 记一笔「慢」，下次请求前换台
  const HEALTH_PATH = '/api/health?cache=false';
  const PROBE_TIMEOUT_MS = 6000;
  let API_BASE = '';     // 当前选中的服务器
  let API_TRIED = [];    // 本轮试过且失败的（报错文案用）
  let API_LAST = {};     // host -> ms | 'fail'
  let API_SLOW = false;  // 上一轮真实请求慢过 → 下次 apiGet 前重新择台
  let API_PRIMARY_DOWN_UNTIL = 0;  // 主域被判定「慢」的冷却截止（5 分钟内优先用镜像）
  const PANEL_ID = 'asmr-dl-panel';

  // ============ 工具 ============
  const fmtSize = (b) => {
    if (!b && b !== 0) return '?';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  };
  const getWorkId = () => {
    const m = location.pathname.match(/\/work\/([^/?#]+)/);
    return m ? m[1] : null;
  };
  const TOKEN_KEYS = ['jwt-token', 'token', 'auth_token', 'auth'];
  const getToken = () => {
    try {
      let t = '';
      for (const k of TOKEN_KEYS) {
        t = localStorage.getItem(k) || '';
        if (t) break;
      }
      t = t.trim();
      if (t.startsWith('__q_strn|')) t = t.slice(9);
      if (t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1);
      if (t.startsWith('Bearer ')) t = t.slice(7);
      return t.trim();
    } catch (e) { return ''; }
  };
  // —— 服务器探活 ——
  function probeHost(host) {
    return new Promise((resolve) => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
      const t0 = Date.now();
      fetch(host + HEALTH_PATH, { signal: ctl.signal, cache: 'no-store' })
        .then((res) => resolve(res.ok ? (Date.now() - t0) : null))
        .catch(() => resolve(null))
        .finally(() => clearTimeout(t));
    });
  }
  async function pickServer() {
    const ms = await Promise.all(API_HOSTS.map(probeHost));
    API_LAST = {};
    API_HOSTS.forEach((h, i) => { API_LAST[h] = ms[i] === null ? 'fail' : ms[i]; });
    const alive = API_HOSTS.map((h, i) => ({ host: h, ms: ms[i] }))
      .filter((r) => r.ms !== null).sort((a, b) => a.ms - b.ms);
    // 直连优先：主域活着且不慢就用主域（哪怕镜像更快）；主域慢/挂才退到最快镜像
    const primaryCooling = Date.now() < API_PRIMARY_DOWN_UNTIL;
    const primary = alive.find((r) => r.host === API_PRIMARY);
    const mirrors = alive.filter((r) => r.host !== API_PRIMARY);
    if (!primaryCooling && primary && primary.ms <= SLOW_PROBE_MS) {
      API_BASE = primary.host;
    } else if (primaryCooling && mirrors.length) {
      // 主域刚才真实请求慢过：冷却期内**连探活最快也不选它**，免得反复卡
      API_BASE = mirrors[0].host;
    } else {
      API_BASE = alive.length ? alive[0].host : '';
    }
    await saveServer(API_BASE);
    return alive;
  }
  async function saveServer(host) {
    try { await chrome.storage.local.set({ apiServer: host, apiServerAt: Date.now() }); } catch (e) {}
  }
  async function initServer() {
    if (API_BASE) return;
    try {
      const r = await chrome.storage.local.get(['apiServer', 'apiServerAt']);
      // 只复用「主域」的缓存：墙期的镜像缓存不该长期粘住（直连优先）；主域冷却期内也不复用
      if (r && r.apiServer === API_PRIMARY
          && (Date.now() - (r.apiServerAt || 0)) < 30 * 60 * 1000
          && Date.now() >= API_PRIMARY_DOWN_UNTIL) API_BASE = r.apiServer;
    } catch (e) {}
    if (!API_BASE) await pickServer();
  }
  const apiServerLabel = () => {
    if (!API_BASE) return '无可用服务器';
    const ms = API_LAST[API_BASE];
    const tag = API_BASE === API_PRIMARY ? '主域' : '镜像';
    return API_BASE.replace('https://', '') + (typeof ms === 'number' ? ' (' + ms + 'ms)' : '') + ' · ' + tag;
  };
  const apiServerDiag = () => API_HOSTS
    .map((h) => h.replace('https://', '') + ' ' + (API_LAST[h] === undefined ? '?' : API_LAST[h])).join('，');

  // —— 请求：失败 → 重新探活换一台再试一次；主域慢 → 下次请求前换台 ——
  async function apiGet(path, token) {
    API_TRIED = [];
    let lastErr = null;
    if (API_SLOW) { API_BASE = ''; API_SLOW = false; }   // 上一轮主域慢过：重新择台再发请求
    await initServer();
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!API_BASE) break;
      API_TRIED.push(API_BASE);
      try {
        const headers = {};
        if (token) headers.Authorization = 'Bearer ' + token;
        const t0 = Date.now();
        const res = await fetch(API_BASE + path, { headers });
        const rtt = Date.now() - t0;
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        // 主域慢（比如直连被限速）→ 下次换镜像，不在这儿重发，免得一卡卡两遍
        if (API_BASE === API_PRIMARY && rtt > SLOW_REQUEST_MS) {
          API_SLOW = true;
          API_PRIMARY_DOWN_UNTIL = Date.now() + 5 * 60 * 1000;
        }
        return data;
      } catch (e) {
        lastErr = e;
        API_BASE = '';            // 作废当前服务器，重新择优
        await pickServer();
        if (API_TRIED.includes(API_BASE)) break;   // 还是同一台，别空转
      }
    }
    throw new Error('API 不可达' + (lastErr ? '（' + lastErr.message + '）' : '') + ' ▸ ' + apiServerDiag());
  }
  async function resolveWorkId(raw) {
    if (/^\d+$/.test(raw)) return raw;
    if (/^(RJ|VJ|BJ)\d+$/i.test(raw)) {
      const j = await apiGet('/api/search/' + encodeURIComponent(raw) + '?order=release&sort=desc&page=1&pageSize=5&includeTranslationWorks=true', getToken());
      if (j.works && j.works.length > 0) return String(j.works[0].id);
    }
    throw new Error('无法解析作品 ID: ' + raw);
  }

  const AUDIO_EXT = ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus', 'ape', 'wv', 'tak', 'tta', 'wma', 'dsf', 'aiff'];
  const IMG_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif'];
  const SUB_EXT = ['vtt', 'srt', 'lrc', 'ass', 'ssa'];
  const DOC_EXT = ['txt', 'md', 'pdf', 'doc', 'docx', 'html', 'htm'];
  const VIDEO_EXT = ['mp4', 'mkv', 'webm', 'avi', 'mov', 'wmv', 'flv', 'ts'];
  const extOf = (name) => { const m = name.match(/\.([A-Za-z0-9]+)$/); return m ? m[1].toLowerCase() : ''; };
  const typeOf = (name) => {
    const e = extOf(name);
    if (AUDIO_EXT.includes(e)) return 'audio';
    if (IMG_EXT.includes(e)) return 'image';
    if (SUB_EXT.includes(e)) return 'sub';
    if (DOC_EXT.includes(e)) return 'doc';
    if (VIDEO_EXT.includes(e)) return 'video';
    return 'other';
  };
  const matchFilter = (f, name) => f === 'all' || typeOf(name) === f;
  const baseName = (p) => {
    const s = String(p).replace(/[\\/]+$/, '');
    return s.split(/[\\/]/).pop() || s;
  };

  // ============ 状态 ============
  const state = {
    workId: null,
    workRJ: '',
    workTitle: '',
    files: [],
    filter: 'all',
    selected: new Set(),
    downloading: false,
    collapsed: new Set(),
    closed: false,
    dlRoot: '',      // 上次选择的目录
    dlRoots: [],     // 收藏目录列表
    // —— 下载进度（逐文件）——
    dl: new Map(),          // dest -> {size,total,status,error,speed,lastSize,lastT}
    pathByDest: new Map(),  // dest -> 文件在作品里的相对路径
    destByPath: new Map(),  // 相对路径 -> dest
    rowRefs: new Map(),     // dest -> {wrap,row,prog,bar,txt}
    pollIv: null,
    summaryText: '',        // 收尾后脚注保留的总结（否则会被「已选 N 个」冲掉）
  };

  // ============ 样式 ============
  const CSS = `
  #${PANEL_ID} {
    position: fixed; top: 16px; right: 16px; z-index: 2147483647;
    width: 440px; max-width: calc(100vw - 32px);
    display: flex; flex-direction: column;
    background: #181825; color: #cdd6f4;
    border: 1px solid #313244; border-radius: 14px;
    font: 12.5px/1.6 "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
    box-shadow: 0 10px 40px rgba(0,0,0,.55);
    overflow: hidden;
    user-select: none;
  }
  #${PANEL_ID} * { box-sizing: border-box; margin: 0; padding: 0; }
  #${PANEL_ID} .p-head {
    display: flex; align-items: center; gap: 4px;
    padding: 10px 12px; background: #11111b;
    cursor: move; border-bottom: 1px solid #1e1e2e;
  }
  #${PANEL_ID} .p-title {
    flex: 1; font-weight: 700; font-size: 13px; color: #f5e0dc;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;
  }
  #${PANEL_ID} .p-head button {
    background: none; border: none; color: #9399b2; cursor: pointer;
    width: 26px; height: 26px; border-radius: 7px; font-size: 14px; line-height: 1;
    display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
  }
  #${PANEL_ID} .p-head button:hover { background: #313244; color: #fff; }
  #${PANEL_ID} .p-body {
    flex: 1; overflow-y: auto; padding: 8px 10px 10px;
    min-height: 60px; max-height: calc(100vh - 260px);
  }
  #${PANEL_ID} .p-body::-webkit-scrollbar { width: 8px; }
  #${PANEL_ID} .p-body::-webkit-scrollbar-thumb { background: #313244; border-radius: 4px; }
  #${PANEL_ID} .p-toolbar {
    display: flex; flex-wrap: wrap; gap: 5px; align-items: center;
    padding: 8px 10px; border-top: 1px solid #1e1e2e; background: #11111b;
  }
  #${PANEL_ID} .p-toolbar button {
    border: 1px solid #313244; border-radius: 7px; padding: 4px 9px; cursor: pointer;
    font-size: 11.5px; background: #1e1e2e; color: #a6adc8; line-height: 1.4;
  }
  #${PANEL_ID} .p-toolbar button:hover { background: #313244; color: #fff; }
  #${PANEL_ID} .p-toolbar button.on { background: #89b4fa; color: #11111b; font-weight: 700; border-color: #89b4fa; }
  #${PANEL_ID} .p-toolbar .sep { width: 1px; height: 18px; background: #313244; margin: 0 2px; }
  #${PANEL_ID} .p-dirbar {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 12px; background: #1e1e2e; border-top: 1px solid #11111b;
    font-size: 11px; color: #7f849c;
  }
  #${PANEL_ID} .p-dirbar .dot { width: 6px; height: 6px; border-radius: 50%; background: #a6e3a1; flex-shrink: 0; }
  #${PANEL_ID} .p-dirbar .dot.off { background: #f9e2af; }
  #${PANEL_ID} .p-dirbar .dot.err { background: #f38ba8; }
  #${PANEL_ID} .p-dirbar .dir-path {
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left;
  }
  #${PANEL_ID} .p-dirbar a { color: #89b4fa; text-decoration: none; cursor: pointer; flex-shrink: 0; }
  #${PANEL_ID} .p-dirbar a:hover { text-decoration: underline; }
  #${PANEL_ID} .p-foot {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 12px; border-top: 1px solid #1e1e2e; background: #11111b;
  }
  #${PANEL_ID} .p-stat { font-size: 11.5px; color: #a6adc8; white-space: nowrap; flex-shrink: 0; }
  #${PANEL_ID} .p-foot button {
    border: none; border-radius: 8px; padding: 7px 0; cursor: pointer; font-size: 12.5px; font-weight: 700;
  }
  #${PANEL_ID} #dl-abort { background: #313244; color: #f38ba8; width: 58px; display: none; }
  #${PANEL_ID} #dl-abort:hover { background: #45475a; }
  #${PANEL_ID} #dl-btn { flex: 1; background: #a6e3a1; color: #11111b; }
  #${PANEL_ID} #dl-btn:hover:not(:disabled) { background: #b8f2b0; }
  #${PANEL_ID} #dl-btn:disabled { background: #313244; color: #6c7086; cursor: not-allowed; }
  #${PANEL_ID} .p-progress { height: 6px; background: #11111b; }
  #${PANEL_ID} .p-progress > div { height: 100%; background: linear-gradient(90deg,#89b4fa,#a6e3a1); width: 0; transition: width .25s linear; }
  #${PANEL_ID} .p-progress.stalled > div { background: linear-gradient(90deg,#6c7086,#f9e2af); }
  #${PANEL_ID} .p-progress.failed > div { background: linear-gradient(90deg,#f38ba8,#f9e2af); }
  /* 逐文件进度 */
  #${PANEL_ID} .fwrap { display: flex; flex-direction: column; }
  #${PANEL_ID} .prog { display: none; padding: 0 4px 5px 26px; }
  #${PANEL_ID} .prog.on { display: block; }
  #${PANEL_ID} .prog .track { height: 4px; background: #11111b; border-radius: 3px; overflow: hidden; }
  #${PANEL_ID} .prog .track > i { display: block; height: 100%; width: 0; background: #89b4fa; border-radius: 3px; transition: width .25s linear; }
  #${PANEL_ID} .prog .pt { display: block; margin-top: 1px; font-size: 10.5px; color: #6c7086; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #${PANEL_ID} .prog.run .pt { color: #89b4fa; }
  #${PANEL_ID} .prog.done .track { opacity: .55; }
  #${PANEL_ID} .prog.done .track > i { background: #a6e3a1; }
  #${PANEL_ID} .prog.done .pt { color: #a6e3a1; }
  #${PANEL_ID} .prog.fail .track > i { background: #f38ba8; }
  #${PANEL_ID} .prog.fail .pt { color: #f38ba8; }
  #${PANEL_ID} .row.file.done .nm { color: #a6e3a1; }
  #${PANEL_ID} .row.file.fail .nm { color: #f38ba8; }
  #${PANEL_ID} .p-speed { font-size: 11px; color: #89b4fa; font-variant-numeric: tabular-nums; white-space: nowrap; flex-shrink: 0; }
  #${PANEL_ID} .p-loading, #${PANEL_ID} .p-error { padding: 24px 16px; text-align: center; color: #a6adc8; font-size: 12.5px; }
  #${PANEL_ID} .p-error { color: #f38ba8; }
  #${PANEL_ID} .p-hint { font-size: 11.5px; color: #7f849c; padding: 2px 2px 8px; }
  /* 树 */
  #${PANEL_ID} .tree { display: flex; flex-direction: column; }
  #${PANEL_ID} .row { display: flex; align-items: center; gap: 7px; min-height: 26px; padding: 1px 4px; border-radius: 6px; }
  #${PANEL_ID} .row:hover { background: #1e1e2e; }
  #${PANEL_ID} .row input[type=checkbox] { flex-shrink: 0; width: 15px; height: 15px; accent-color: #89b4fa; cursor: pointer; margin: 0; }
  #${PANEL_ID} .row .nm { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #cdd6f4; }
  #${PANEL_ID} .row .sz { flex-shrink: 0; width: 70px; text-align: right; font-size: 11px; color: #6c7086; font-variant-numeric: tabular-nums; }
  #${PANEL_ID} .row.dir .nm { color: #89b4fa; font-weight: 600; cursor: pointer; }
  #${PANEL_ID} .row.dir .arrow {
    flex-shrink: 0; width: 12px; text-align: center; font-size: 9px; color: #6c7086;
    transition: transform .12s; display: inline-block; cursor: pointer;
  }
  #${PANEL_ID} .row.dir.collapsed .arrow { transform: rotate(-90deg); }
  #${PANEL_ID} .children { padding-left: 22px; display: flex; flex-direction: column; }
  #${PANEL_ID} .row.dir.collapsed + .children { display: none; }
  /* 目录选择器 */
  #${PANEL_ID} .p-picker {
    display: none; position: absolute; inset: 0; z-index: 10;
    background: rgba(17,17,27,.92); padding: 14px;
    flex-direction: column; gap: 8px;
  }
  #${PANEL_ID} .p-picker.show { display: flex; }
  #${PANEL_ID} .p-picker h3 { font-size: 13px; color: #f5e0dc; margin-bottom: 2px; }
  #${PANEL_ID} .p-picker .pk-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; min-height: 60px; }
  #${PANEL_ID} .p-picker .pk-list::-webkit-scrollbar { width: 8px; }
  #${PANEL_ID} .p-picker .pk-list::-webkit-scrollbar-thumb { background: #313244; border-radius: 4px; }
  #${PANEL_ID} .p-picker .pk-item {
    display: flex; align-items: center; gap: 8px;
    padding: 7px 10px; border: 1px solid #313244; border-radius: 9px; cursor: pointer;
    background: #1e1e2e;
  }
  #${PANEL_ID} .p-picker .pk-item:hover { border-color: #45475a; }
  #${PANEL_ID} .p-picker .pk-item.sel { border-color: #89b4fa; background: #1e1e2e; }
  #${PANEL_ID} .p-picker .pk-item .pk-name { font-weight: 600; color: #cdd6f4; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #${PANEL_ID} .p-picker .pk-item .pk-path { font-size: 10.5px; color: #6c7086; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #${PANEL_ID} .p-picker .pk-item .pk-del {
    flex-shrink: 0; background: none; border: none; color: #6c7086; cursor: pointer;
    font-size: 14px; width: 22px; height: 22px; border-radius: 6px; line-height: 1;
  }
  #${PANEL_ID} .p-picker .pk-item .pk-del:hover { background: #313244; color: #f38ba8; }
  #${PANEL_ID} .p-picker .pk-new { display: flex; gap: 6px; }
  #${PANEL_ID} .p-picker .pk-new input {
    flex: 1; min-width: 0; background: #1e1e2e; border: 1px solid #313244; border-radius: 8px;
    color: #cdd6f4; font-size: 12px; padding: 7px 10px; outline: none;
  }
  #${PANEL_ID} .p-picker .pk-new input:focus { border-color: #89b4fa; }
  #${PANEL_ID} .p-picker .pk-new button {
    border: 1px solid #313244; border-radius: 8px; padding: 0 12px; cursor: pointer;
    font-size: 12px; background: #1e1e2e; color: #a6adc8;
  }
  #${PANEL_ID} .p-picker .pk-new button:hover { background: #313244; color: #fff; }
  #${PANEL_ID} .p-picker .pk-foot { display: flex; gap: 8px; }
  #${PANEL_ID} .p-picker .pk-foot button {
    flex: 1; border: none; border-radius: 9px; padding: 9px 0; cursor: pointer;
    font-size: 12.5px; font-weight: 700;
  }
  #${PANEL_ID} .p-picker #pk-ok { background: #a6e3a1; color: #11111b; }
  #${PANEL_ID} .p-picker #pk-ok:hover { background: #b8f2b0; }
  #${PANEL_ID} .p-picker #pk-cancel { background: #313244; color: #a6adc8; }
  #${PANEL_ID} .p-picker #pk-cancel:hover { background: #45475a; }
  #${PANEL_ID} .p-picker .pk-tip { font-size: 10.5px; color: #6c7086; }
  `;

  // ============ 面板 ============
  function createPanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    const style = document.createElement('style');
    style.id = PANEL_ID + '-style';
    style.textContent = CSS;
    document.head.appendChild(style);
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="p-head">
        <span class="p-title" id="dl-title">ASMR One 下载器 v4.3</span>
        <button id="dl-refresh" title="刷新列表">⟳</button>
        <button id="dl-min" title="最小化">–</button>
        <button id="dl-close" title="关闭">×</button>
      </div>
      <div class="p-body">
        <div class="p-loading">正在加载作品文件列表…</div>
      </div>
      <div class="p-toolbar" style="display:none">
        <button data-f="all" class="on">全部</button>
        <button data-f="audio">音频</button>
        <button data-f="image">图片</button>
        <button data-f="sub">字幕</button>
        <button data-f="doc">文档</button>
        <button data-f="video">视频</button>
        <button data-f="other">其他</button>
        <span class="sep"></span>
        <button id="dl-selall">全选</button>
        <button id="dl-selnone">清空</button>
      </div>
      <div class="p-dirbar" id="dl-dirbar" style="display:none">
        <span class="dot" id="dl-dot"></span>
        <span class="dir-path" id="dl-dirpath" title=""></span>
        <a id="dl-server" title="当前 API 服务器（点击重新探活）"></a>
        <a id="dl-setdir">选择目录</a>
      </div>
      <div class="p-picker" id="dl-picker">
        <h3>选择下载目录</h3>
        <div class="pk-list" id="pk-list"></div>
        <div class="pk-new">
          <input id="pk-input" placeholder="输入新目录，如 G:\\H library\\指示型音声（回车添加）" spellcheck="false">
          <button id="pk-add">添加</button>
        </div>
        <div class="pk-tip">下载后将保存到：所选目录 / RJ号 标题 / 网站目录结构</div>
        <div class="pk-foot">
          <button id="pk-ok">开始下载</button>
          <button id="pk-cancel">取消</button>
        </div>
      </div>
      <div class="p-progress"><div id="dl-progress-bar"></div></div>
      <div class="p-foot" style="display:none">
        <span class="p-stat" id="dl-stat">0 个</span>
        <span class="p-speed" id="dl-speed"></span>
        <button id="dl-abort">取消</button>
        <button id="dl-btn">下载选中</button>
      </div>
    `;
    document.body.appendChild(panel);
    bindPanel(panel);
    return panel;
  }

  const removePanel = () => { const p = document.getElementById(PANEL_ID); if (p) p.remove(); };

  // ============ 设置读写 ============
  async function readSettings() {
    try {
      const r = await chrome.storage.local.get(['dlRoot', 'dlRoots']);
      state.dlRoot = (r && r.dlRoot) || '';
      state.dlRoots = Array.isArray(r && r.dlRoots) ? r.dlRoots : [];
    } catch (e) {
      state.dlRoot = '';
      state.dlRoots = [];
    }
  }
  async function saveSettings() {
    try {
      await chrome.storage.local.set({ dlRoot: state.dlRoot, dlRoots: state.dlRoots });
    } catch (e) {}
  }

  // ============ 数据加载 ============
  async function load() {
    const panel = createPanel();
    const body = panel.querySelector('.p-body');
    body.innerHTML = '<div class="p-loading">正在加载作品文件列表…</div>';
    const titleEl = panel.querySelector('#dl-title');
    try {
      const raw = getWorkId();
      if (!raw) throw new Error('无法从 URL 识别作品 ID');
      const token = getToken();
      const id = await resolveWorkId(raw);
      const work = await apiGet('/api/work/' + id, token);
      const tracks = await apiGet('/api/tracks/' + id + '?v=2', token);
      state.workId = id;
      state.workRJ = (work && work.source_id) || '';
      state.workTitle = (work && (work.title || work.name)) || '';
      const files = [];
      const walk = (nodes, prefix) => {
        for (const n of nodes) {
          if (!n) continue;
          if ((n.type === 'folder' || (n.children && n.children.length)) && n.children) walk(n.children, prefix + (n.title || '') + '/');
          else if (n.type === 'file' || n.hash) {
            const path = prefix + (n.title || '');
            const url = n.mediaDownloadUrl || n.mediaStreamUrl || '';
            if (url) files.push({ path, size: n.size || 0, url, type: typeOf(n.title || '') });
          } else {
            // 未知节点：记一笔，便于排查接口变更
            console.warn('[asmr-dl] unknown node', n && n.type, n && n.title);
          }
        }
      };
      walk(Array.isArray(tracks) ? tracks : (tracks.tracks || []), '');
      state.files = files;
      state.selected = new Set(files.map(f => f.path));
      state.collapsed = new Set();
      if (titleEl) titleEl.textContent = (state.workRJ || state.workId) + (state.workTitle ? ' ' + state.workTitle : '');
      updateDirBar(panel);
      panel.querySelector('.p-toolbar').style.display = 'flex';
      panel.querySelector('.p-foot').style.display = 'flex';
      renderTree();
    } catch (e) {
      body.innerHTML = `<div class="p-error">加载失败：${escapeHtml(e.message)}<br><small>已试域名：${escapeHtml(API_TRIED.join(' / ') || '-')}<br>请确认已登录 asmr.one 且代理已开启，然后点左上角 ⟳ 刷新。</small></div>`;
      if (titleEl) titleEl.textContent = '加载失败';
      const tk = getToken();
      console.log('[asmr-dl] load error:', e.message, '| token len=' + tk.length, '| token head=' + tk.slice(0, 15));
    }
  }

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ============ 目录栏 ============
  function updateDirBar(panel) {
    const bar = panel.querySelector('#dl-dirbar');
    const dot = panel.querySelector('#dl-dot');
    const pathEl = panel.querySelector('#dl-dirpath');
    const srvEl = panel.querySelector('#dl-server');
    if (srvEl) {
      srvEl.textContent = apiServerLabel();
      srvEl.title = '当前 API 服务器（点击重新探活）\n' + apiServerDiag();
    }
    const token = getToken();
    bar.style.display = 'flex';
    if (!token) {
      dot.className = 'dot off';
      pathEl.textContent = '未登录：请登录后点 ⟳ 刷新';
      pathEl.title = '';
    } else if (state.dlRoot) {
      dot.className = 'dot';
      pathEl.textContent = state.dlRoot + '\\' + (state.workRJ || '作品') + ' ' + (state.workTitle || '').slice(0, 25) + '\\…';
      pathEl.title = state.dlRoot + '\\' + state.workRJ + ' ' + state.workTitle;
    } else {
      dot.className = 'dot err';
      pathEl.textContent = '未选择下载目录（下载时选择）';
      pathEl.title = '';
    }
  }

  // ============ 目录选择器 ============
  let pickerResolve = null; // 当前选择器的回调
  let pickerPromise = null; // 本次选择的承诺（重渲染时复用，否则 await 会永远挂住）

  function openPicker(confirmText) {
    const panel = createPanel();
    // 同一轮选择（比如在里面「添加」新目录后重渲染）必须复用同一个 promise，
    // 否则 await 的是旧 promise、按钮 resolve 的是新的 → 点「开始下载」毫无反应（2026-10-25 修）
    if (!pickerPromise) pickerPromise = new Promise((res) => { pickerResolve = res; });
    const picker = panel.querySelector('#dl-picker');
    const list = panel.querySelector('#pk-list');
    const input = panel.querySelector('#pk-input');
    list.innerHTML = '';
    // 列表：收藏目录
    if (state.dlRoots.length === 0) {
      list.innerHTML = '<div class="pk-tip" style="padding:10px">还没有收藏目录，在下方输入一个目录开始吧</div>';
    }
    state.dlRoots.forEach((p, i) => {
      const item = document.createElement('div');
      item.className = 'pk-item' + (p === state.dlRoot ? ' sel' : '');
      item.dataset.idx = i;
      const info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column';
      const name = document.createElement('span');
      name.className = 'pk-name';
      name.textContent = baseName(p);
      const path = document.createElement('span');
      path.className = 'pk-path';
      path.textContent = p;
      info.appendChild(name); info.appendChild(path);
      const del = document.createElement('button');
      del.className = 'pk-del';
      del.textContent = '✕';
      del.title = '从收藏中移除';
      item.appendChild(info); item.appendChild(del);
      item.addEventListener('click', (e) => {
        if (e.target === del) return;
        list.querySelectorAll('.pk-item').forEach(x => x.classList.remove('sel'));
        item.classList.add('sel');
        state.dlRoot = p;
      });
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        state.dlRoots.splice(i, 1);
        if (state.dlRoot === p) state.dlRoot = state.dlRoots[0] || '';
        saveSettings();
        openPicker(confirmText);
      });
      list.appendChild(item);
    });
    // 确认/取消
    const ok = panel.querySelector('#pk-ok');
    ok.textContent = confirmText || '开始下载';
    const finish = (val) => {
      picker.classList.remove('show');
      const r = pickerResolve;
      pickerResolve = null;
      pickerPromise = null;
      if (r) r(val);
    };
    ok.onclick = () => finish(state.dlRoot || null);
    const cancel = panel.querySelector('#pk-cancel');
    cancel.onclick = () => finish(null);
    // 输入添加
    const add = panel.querySelector('#pk-add');
    const doAdd = () => {
      const v = input.value.trim().replace(/[\\/]+$/, '');
      if (!v) return;
      if (!state.dlRoots.includes(v)) state.dlRoots.push(v);
      state.dlRoot = v;
      input.value = '';
      saveSettings();
      openPicker(confirmText);      // 只重画列表；promise 复用，不会把 await 弄丢
    };
    add.onclick = doAdd;
    input.onkeydown = (e) => { if (e.key === 'Enter') doAdd(); if (e.key === 'Escape') cancel.onclick(); };
    picker.classList.add('show');
    input.focus();
    return pickerPromise;
  }

  // ============ 树渲染 ============
  function visibleFiles() {
    return state.files.filter(f => matchFilter(state.filter, f.path.split('/').pop()));
  }

  function buildTree() {
    const vf = new Set(visibleFiles().map(f => f.path));
    const root = [];
    for (const f of state.files) {
      if (!vf.has(f.path)) continue;
      const segs = f.path.split('/');
      let cur = root, acc = '';
      for (let i = 0; i < segs.length - 1; i++) {
        acc = acc ? acc + '/' + segs[i] : segs[i];
        let dir = cur.find(d => d.path === acc);
        if (!dir) { dir = { path: acc, name: segs[i], children: [], file: null }; cur.push(dir); }
        cur = dir.children;
      }
      cur.push({ path: f.path, name: segs[segs.length - 1], file: f, children: null });
    }
    return root;
  }

  function dirFilePaths(dir) {
    const out = [];
    const walk = (n) => {
      if (n.file) out.push(n.file.path);
      if (n.children) n.children.forEach(walk);
    };
    walk(dir);
    return out;
  }

  function dirState(dir) {
    const paths = dirFilePaths(dir);
    const sel = paths.filter(p => state.selected.has(p)).length;
    if (sel === 0) return 0;
    if (sel === paths.length) return 2;
    return 1;
  }

  function renderTree() {
    const panel = createPanel();
    const body = panel.querySelector('.p-body');
    const tree = buildTree();
    const root = document.createElement('div');
    root.className = 'tree';
    body.innerHTML = '';
    state.rowRefs.clear();
    body.appendChild(root);

    const renderNodes = (nodes, container) => {
      for (const n of nodes) {
        if (n.file) {
          const wrap = document.createElement('div');
          wrap.className = 'fwrap';
          const row = document.createElement('div');
          row.className = 'row file';
          const chk = document.createElement('input');
          chk.type = 'checkbox';
          chk.checked = state.selected.has(n.path);
          chk.title = n.path;
          chk.addEventListener('change', () => {
            if (chk.checked) state.selected.add(n.path); else state.selected.delete(n.path);
            renderTree();
          });
          const nm = document.createElement('span');
          nm.className = 'nm';
          nm.textContent = n.name;
          nm.title = n.path;
          const sz = document.createElement('span');
          sz.className = 'sz';
          sz.textContent = fmtSize(n.file.size);
          row.appendChild(chk); row.appendChild(nm); row.appendChild(sz);
          // 逐文件进度条（未下载时不显示）
          const prog = document.createElement('div');
          prog.className = 'prog';
          const track = document.createElement('div');
          track.className = 'track';
          const bar = document.createElement('i');
          track.appendChild(bar);
          const txt = document.createElement('span');
          txt.className = 'pt';
          prog.appendChild(track); prog.appendChild(txt);
          wrap.appendChild(row); wrap.appendChild(prog);
          container.appendChild(wrap);
          const dest = state.destByPath.get(n.path);
          if (dest) {
            state.rowRefs.set(dest, { wrap, row, prog, bar, txt });
            const rec = state.dl.get(dest);
            if (rec) paintRow(dest, rec);
          }
        } else {
          const ds = dirState(n);
          const row = document.createElement('div');
          row.className = 'row dir' + (state.collapsed.has(n.path) ? ' collapsed' : '');
          const chk = document.createElement('input');
          chk.type = 'checkbox';
          chk.checked = ds === 2;
          chk.indeterminate = ds === 1;
          chk.title = n.path;
          chk.addEventListener('change', () => {
            const paths = dirFilePaths(n);
            if (chk.checked) paths.forEach(p => state.selected.add(p));
            else paths.forEach(p => state.selected.delete(p));
            renderTree();
          });
          const arrow = document.createElement('span');
          arrow.className = 'arrow';
          arrow.textContent = '▼';
          const nm = document.createElement('span');
          nm.className = 'nm';
          nm.textContent = n.name;
          nm.title = n.path;
          const toggle = () => {
            if (state.collapsed.has(n.path)) state.collapsed.delete(n.path);
            else state.collapsed.add(n.path);
            row.classList.toggle('collapsed');
          };
          arrow.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
          nm.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
          const children = document.createElement('div');
          children.className = 'children';
          renderNodes(n.children, children);
          row.appendChild(chk); row.appendChild(arrow); row.appendChild(nm);
          container.appendChild(row);
          container.appendChild(children);
        }
      }
    };
    renderNodes(tree, root);
    updateStat();
  }

  function updateStat() {
    const panel = createPanel();
    const sel = state.files.filter(f => state.selected.has(f.path));
    const totalSize = sel.reduce((a, f) => a + (f.size || 0), 0);
    const statEl = panel.querySelector('#dl-stat');
    const btn = panel.querySelector('#dl-btn');
    if (statEl) statEl.textContent = (!state.downloading && state.summaryText)
      ? state.summaryText
      : `已选 ${sel.length} 个 · ${fmtSize(totalSize)}`;
    if (btn) {
      btn.disabled = state.downloading || sel.length === 0;
      btn.textContent = state.downloading ? '下载中…' : `下载选中 (${sel.length})`;
    }
  }

  // ============ 下载 ============
  const fmtSpeed = (bps) => {
    if (!bps || bps < 1) return '0 B/s';
    return fmtSize(Math.round(bps)) + '/s';
  };
  const fmtEta = (sec) => {
    if (!sec || !isFinite(sec) || sec < 0) return '';
    if (sec < 60) return Math.ceil(sec) + 's';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ' + Math.round(sec % 60) + 's';
    return Math.floor(sec / 3600) + 'h ' + Math.round((sec % 3600) / 60) + 'm';
  };
  const STATUS_TEXT = { wait: '排队中', run: '下载中', done: '已下载', fail: '失败' };

  // 单个文件行：进度条 + 文字 + 行配色
  function paintRow(dest, rec) {
    const ref = state.rowRefs.get(dest);
    if (!ref) return;
    const { row, prog, bar, txt } = ref;
    const total = rec.total || 0;
    const pct = rec.status === 'done' ? 100 : (total > 0 ? Math.min(100, rec.size / total * 100) : 0);
    prog.classList.add('on');
    prog.classList.toggle('run', rec.status === 'run');
    prog.classList.toggle('done', rec.status === 'done');
    prog.classList.toggle('fail', rec.status === 'fail');
    row.classList.toggle('done', rec.status === 'done');
    row.classList.toggle('fail', rec.status === 'fail');
    bar.style.width = (rec.status === 'fail' ? Math.max(4, pct) : pct) + '%';
    let t;
    if (rec.status === 'done') {
      t = '✓ 已下载 ' + fmtSize(rec.size) + (rec.via ? ' · ' + (rec.via === 'direct' ? '直连' : '代理') : '');
    } else if (rec.status === 'fail') {
      t = '✗ 失败 · ' + (rec.error || '未知原因');
    } else if (rec.status === 'wait') {
      t = '⏳ 排队中' + (total ? ' · ' + fmtSize(total) : '');
    } else {
      const parts = [fmtSize(rec.size) + (total ? ' / ' + fmtSize(total) : '') + (total ? ' · ' + pct.toFixed(0) + '%' : '')];
      parts.push(rec.speed > 0 ? fmtSpeed(rec.speed) : '…');
      t = parts.join(' · ');
    }
    txt.textContent = t;
    txt.title = t;
  }

  // 汇总：总进度条 + 脚注（文件数 / 字节 / 速度 / 剩余）
  function updateAggregate(panel) {
    panel = panel || createPanel();
    const recs = Array.from(state.dl.values());
    if (recs.length === 0) return;
    let totalBytes = 0, doneBytes = 0, speed = 0;
    let done = 0, failed = 0, running = 0, waiting = 0;
    for (const r of recs) {
      totalBytes += r.total || 0;
      doneBytes += r.size || 0;
      speed += r.status === 'run' ? (r.speed || 0) : 0;
      if (r.status === 'done') done++;
      else if (r.status === 'fail') failed++;
      else if (r.status === 'run') running++;
      else waiting++;
    }
    const pct = totalBytes > 0 ? Math.min(100, doneBytes / totalBytes * 100)
      : ((done + failed) / recs.length * 100);
    const bar = panel.querySelector('#dl-progress-bar');
    if (bar) bar.style.width = pct.toFixed(1) + '%';
    const wrapBar = panel.querySelector('.p-progress');
    if (wrapBar) wrapBar.classList.toggle('stalled', running > 0 && speed < 1024);
    const stat = panel.querySelector('#dl-stat');
    if (stat) {
      stat.textContent = `${done}/${recs.length} 个` + (failed ? ` · 失败 ${failed}` : '')
        + ` · ${fmtSize(doneBytes)}${totalBytes ? ' / ' + fmtSize(totalBytes) : ''}`;
    }
    const sp = panel.querySelector('#dl-speed');
    if (sp) {
      const eta = speed > 0 && totalBytes > doneBytes ? (totalBytes - doneBytes) / speed : 0;
      sp.textContent = (running ? fmtSpeed(speed) : '') + (eta ? ' · 剩 ' + fmtEta(eta) : '');
    }
  }

  async function startDownload() {
    const sel = state.files.filter(f => state.selected.has(f.path));
    if (sel.length === 0 || state.downloading) return;
    await readSettings();
    // 弹目录选择器
    const root = await openPicker('开始下载 (' + sel.length + ' 个)');
    if (!root) return; // 取消
    state.dlRoot = root;
    await saveSettings();
    const panel = createPanel();
    updateDirBar(panel);
    const folder = ((state.workRJ ? state.workRJ + ' ' : '') + (state.workTitle || 'work'))
      .replace(/[\\/:*?"<>|]/g, '_').replace(/\s+$/, '').slice(0, 100);
    const r = root.replace(/[\\/]+$/, '');
    const items = sel.map(f => {
      const dest = r + '\\' + folder + '\\' + f.path.split('/').join('\\');
      return { url: f.url, dest, expectSize: f.size };
    });
    // 逐文件状态账（dest 两边一致：content 生成、host/background 只回传原样 dest）
    state.summaryText = '';
    state.dl.clear();
    state.pathByDest.clear();
    state.destByPath.clear();
    for (const it of items) {
      state.dl.set(it.dest, { size: 0, total: it.expectSize || 0, status: 'wait', error: '', speed: 0, lastSize: 0, lastT: 0, via: '' });
      const rel = it.dest.slice((r + '\\' + folder + '\\').length).split('\\').join('/');
      state.pathByDest.set(it.dest, rel);
      state.destByPath.set(rel, it.dest);
    }
    state.downloading = true;
    panel.querySelector('#dl-abort').style.display = 'inline-block';
    updateStat();
    renderTree();                 // 让每个被选文件立刻长出进度位
    updateAggregate(panel);
    chrome.runtime.sendMessage({ type: 'START_DOWNLOADS', items }, () => pollStatus());
  }

  // 轮询后台状态：合并进 state.dl、算速度（500ms 采样 + 停滞衰减）
  function pollStatus() {
    const panel = createPanel();
    const abortBtn = panel.querySelector('#dl-abort');
    if (state.pollIv) clearInterval(state.pollIv);
    const iv = setInterval(() => {
      chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (r) => {
        if (!r) { clearInterval(iv); state.pollIv = null; return; }
        const now = Date.now();
        if (Array.isArray(r.files)) {
          for (const f of r.files) {
            const prev = state.dl.get(f.dest);
            if (!prev) continue;                 // 不是本次任务的
            const rec = { ...prev, total: f.total || prev.total, status: f.status || prev.status, error: f.error || '', via: f.via || prev.via };
            if (rec.status === 'done') { rec.size = f.size || rec.size; rec.speed = 0; }
            else if (rec.status === 'fail') { rec.speed = 0; }
            else {
              const dt = prev.lastT ? (now - prev.lastT) / 1000 : 0;
              const ds = (f.size || 0) - (prev.lastSize || 0);
              if (dt > 0.05 && ds >= 0) {
                const inst = ds / dt;
                rec.speed = prev.speed > 0 ? prev.speed * 0.55 + inst * 0.45 : inst;
              } else if (prev.lastT && now - prev.lastT > 1500) {
                rec.speed = 0;                   // 停住了：速度归零，进度条转黄
              }
              rec.size = f.size || 0;
            }
            rec.lastSize = f.size || 0;
            rec.lastT = now;
            state.dl.set(f.dest, rec);
            paintRow(f.dest, rec);
          }
        }
        updateAggregate(panel);
        if (r.active === 0 && r.queue === 0) {
          clearInterval(iv);
          state.pollIv = null;
          state.downloading = false;
          if (abortBtn) abortBtn.style.display = 'none';
          // 收尾：把没收到终态的都标失败，别让行永远转圈
          for (const [dest, rec] of state.dl) {
            if (rec.status !== 'done' && rec.status !== 'fail') {
              const nrec = { ...rec, status: 'fail', error: '未开始就被取消', speed: 0 };
              state.dl.set(dest, nrec);
              paintRow(dest, nrec);
            }
          }
          let failed = 0, done = 0, bytes = 0;
          for (const rec of state.dl.values()) {
            bytes += rec.size || 0;
            if (rec.status === 'done') done++;
            else if (rec.status === 'fail') failed++;
          }
          const total = state.dl.size;
          state.summaryText = `${done}/${total} 完成` + (failed ? ` · ${failed} 失败` : '')
            + ` · ${fmtSize(bytes)}` + (failed ? '' : ' ✓');
          const wrapBar = panel.querySelector('.p-progress');
          if (wrapBar) {
            wrapBar.classList.remove('stalled');
            wrapBar.classList.toggle('failed', failed > 0);
          }
          updateAggregate(panel);
          updateStat();
          // 收尾横幅放**顶部**：body 有滚动，放末尾会被挤到看不见
          const body = panel.querySelector('.p-body');
          const old = body.querySelector('.p-final-box');
          if (old) old.remove();
          const box = document.createElement('div');
          box.className = 'p-final-box ' + (failed > 0 ? 'p-error' : 'p-hint');
          box.style.cssText = 'padding:6px 4px 8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap';
          const txt = document.createElement('span');
          txt.style.flex = '1;min-width:0';
          txt.textContent = failed > 0
            ? `⚠️ ${done} 个完成，${failed} 个失败（自动重试过；原因见红色行）`
            : `✅ 全部 ${done} 个文件已下载完成`;
          box.appendChild(txt);
          if (failed > 0) {
            const retry = document.createElement('button');
            retry.textContent = `只重试失败的 ${failed} 个`;
            retry.style.cssText = 'border:none;border-radius:7px;padding:4px 9px;cursor:pointer;font-size:11.5px;font-weight:700;background:#f9e2af;color:#11111b;flex-shrink:0';
            retry.addEventListener('click', () => retryFailed(panel, box));
            box.appendChild(retry);
          }
          body.insertBefore(box, body.firstChild);
        }
      });
    }, 500);
    state.pollIv = iv;
  }

  // 只重试失败项（不重新下载已完成的文件）
  function retryFailed(panel, box) {
    const items = [];
    for (const [dest, rec] of state.dl) {
      if (rec.status !== 'fail') continue;
      const rel = state.pathByDest.get(dest);
      const f = state.files.find(x => x.path === rel);
      if (!f) continue;
      items.push({ url: f.url, dest, expectSize: f.size });
      state.dl.set(dest, { ...rec, size: 0, total: f.size || 0, status: 'wait', error: '', speed: 0, lastSize: 0, lastT: 0, via: '' });
    }
    if (items.length === 0) return;
    if (box) box.remove();
    state.summaryText = '';
    state.downloading = true;
    const abortBtn = panel.querySelector('#dl-abort');
    if (abortBtn) abortBtn.style.display = 'inline-block';
    const wrapBar = panel.querySelector('.p-progress');
    if (wrapBar) wrapBar.classList.remove('failed');
    renderTree();
    updateAggregate(panel);
    updateStat();
    chrome.runtime.sendMessage({ type: 'START_DOWNLOADS', items }, () => pollStatus());
  }

  // ============ 面板事件 ============
  function bindPanel(panel) {
    panel.querySelector('#dl-close').addEventListener('click', () => { state.closed = true; removePanel(); });
    panel.querySelector('#dl-min').addEventListener('click', () => {
      const parts = ['.p-body', '.p-toolbar', '.p-foot', '#dl-dirbar', '#dl-picker'];
      const hidden = panel.querySelector('.p-body').style.display === 'none';
      parts.forEach(sel => { panel.querySelector(sel).style.display = hidden ? '' : 'none'; });
    });
    panel.querySelector('#dl-refresh').addEventListener('click', async () => {
      API_BASE = '';                 // 手动刷新 = 重新探活
      await pickServer();
      load();
    });
    panel.querySelector('#dl-server').addEventListener('click', async () => {
      API_BASE = '';
      await pickServer();
      load();
    });
    panel.querySelector('#dl-setdir').addEventListener('click', async () => {
      await readSettings();
      openPicker('使用此目录');
    });
    // 拖拽
    const head = panel.querySelector('.p-head');
    let sx = 0, sy = 0, ox = 0, oy = 0, drag = false;
    head.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      drag = true; sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect(); ox = r.left; oy = r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!drag) return;
      panel.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
      panel.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
      panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { drag = false; });
    // 过滤
    panel.querySelectorAll('.p-toolbar button[data-f]').forEach((b) => {
      b.addEventListener('click', () => {
        panel.querySelectorAll('.p-toolbar button[data-f]').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        state.filter = b.dataset.f;
        renderTree();
      });
    });
    panel.querySelector('#dl-selall').addEventListener('click', () => {
      visibleFiles().forEach(f => state.selected.add(f.path));
      renderTree();
    });
    panel.querySelector('#dl-selnone').addEventListener('click', () => {
      visibleFiles().forEach(f => state.selected.delete(f.path));
      renderTree();
    });
    panel.querySelector('#dl-btn').addEventListener('click', startDownload);
    panel.querySelector('#dl-abort').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'ABORT_ALL' });
    });
  }

  // ============ 路由监听（SPA） ============
  function watchRoute() {
    let last = getWorkId();
    const check = () => {
      const id = getWorkId();
      if (id && id !== last) {
        last = id;
        const panel = document.getElementById(PANEL_ID);
        if (panel) load();
      }
    };
    const origPush = history.pushState;
    history.pushState = function (...args) {
      const r = origPush.apply(this, args);
      setTimeout(check, 300);
      return r;
    };
    window.addEventListener('popstate', () => setTimeout(check, 300));
    window.addEventListener('hashchange', () => setTimeout(check, 300));
  }

  // ============ 消息 ============
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'SHOW_PANEL') {
      state.closed = false;
      const panel = createPanel();
      if (!panel.dataset.loaded) {
        panel.dataset.loaded = '1';
        readSettings().then(load);
      } else {
        updateDirBar(panel);
      }
    }
  });

  // ============ 初始化 ============
  function init() {
    watchRoute();
    const panel = createPanel();
    panel.dataset.loaded = '1';
    readSettings().then(load);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
