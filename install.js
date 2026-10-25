// 安装 Native Messaging Host（Edge）
// 用法: node install.js <扩展ID>
// 扩展 ID 在 edge://extensions 开启开发者模式后，扩展卡片上可见
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const id = process.argv[2];
if (!id || !/^[a-p]{32}$/i.test(id)) {
  console.error('用法: node install.js <扩展ID>');
  console.error('扩展 ID 在 edge://extensions 开发者模式下可见（32位字母，如 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa）');
  process.exit(1);
}

const hostDir = __dirname;
const hostPath = path.join(hostDir, 'host', 'host.cmd');
const manifestPath = path.join(hostDir, 'com.asmr.downloader.json');
const manifest = {
  name: 'com.asmr.downloader',
  description: 'ASMR One downloader native host (curl)',
  path: hostPath,
  type: 'stdio',
  allowed_origins: ['chrome-extension://' + id.toLowerCase() + '/'],
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
console.log('manifest -> ' + manifestPath);

const regKey = 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.asmr.downloader';
try {
  execFileSync('reg', ['add', regKey, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { stdio: 'inherit' });
  console.log('注册表写入成功: ' + regKey);
} catch (e) {
  console.error('注册表写入失败: ' + e.message);
  process.exit(1);
}

// 顺便注册 Chrome（可选）
try {
  const chromeKey = 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.asmr.downloader';
  execFileSync('reg', ['add', chromeKey, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { stdio: 'inherit' });
  console.log('（已同时注册 Chrome）');
} catch (e) {
  console.log('（Chrome 注册跳过）');
}
console.log('\n安装完成！请到 edge://extensions 点扩展的「重新加载」，然后刷新作品页。');
