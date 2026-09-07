// CLI：node src/server/cli/index.js <init|unlock|backup|restore>
// init 创建管理员账号（用户名+密码+恢复码）；TOTP 不再强制，可在网页「安全」页自行开启。
import readline from 'node:readline';
import fs from 'node:fs/promises';
import { Store, audit } from '../store/index.js';
import { openExportEnvelope, createEnvelope } from '../crypto/index.js';

const DATA_DIR = process.env.DATA_DIR ?? './data';
const MIN_PASSWORD_LEN = 8;
const USERNAME_RE = /^[A-Za-z0-9._-]{3,20}$/;

const isTTY = Boolean(process.stdin.isTTY);
let rl = null;

function getRl() {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: isTTY });
    if (isTTY) {
      rl._writeToOutput = function (s) {
        if (!rl.stdoutMuted) rl.output.write(s);
      };
    }
  }
  return rl;
}

let lineIter = null;

async function ask(prompt, { hidden = false } = {}) {
  const r = getRl();
  lineIter ??= r[Symbol.asyncIterator]();
  if (hidden && isTTY) r.stdoutMuted = true;
  process.stdout.write(prompt);
  const { value } = await lineIter.next();
  if (hidden && isTTY) {
    r.stdoutMuted = false;
    process.stdout.write('\n');
  }
  if (value === undefined) throw new Error('输入已结束');
  return value;
}

async function askPassword(prompt = '密码: ') {
  return ask(prompt, { hidden: true });
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : null;
}

async function cmdInit(store) {
  if (await store.exists()) {
    console.error('store 已存在，如需重置请先删除数据文件');
    process.exit(1);
  }
  const username = (await ask('管理员用户名（默认 admin）: ')).trim() || 'admin';
  if (!USERNAME_RE.test(username)) {
    console.error('用户名格式不正确（3-20 位字母、数字、. _ -）');
    process.exit(1);
  }
  const pw1 = await askPassword(`设置密码（≥${MIN_PASSWORD_LEN} 位）: `);
  if (pw1.length < MIN_PASSWORD_LEN) {
    console.error('密码太短');
    process.exit(1);
  }
  const pw2 = await askPassword('再次输入密码: ');
  if (pw1 !== pw2) {
    console.error('两次输入不一致');
    process.exit(1);
  }
  console.log('正在校准 KDF 并生成密钥（约需 1 秒）…');
  const { recoveryCode } = await store.init(username, pw1);
  console.log('\n初始化完成。以下恢复码仅展示一次，请立即妥善保存（忘记密码时的唯一找回途径）：\n');
  console.log(`恢复码:\n${recoveryCode}\n`);
  console.log('提示：两步验证（TOTP）为可选项，登录后在「安全」页可自行开启。');
}

async function cmdUnlock(store) {
  if (!(await store.exists())) {
    console.error('store 不存在，请先运行 init');
    process.exit(1);
  }
  await store.load();
  const username = (await ask('用户名（默认 admin）: ')).trim() || 'admin';
  const pw = await askPassword();
  if (await store.unlockWithPassword(username, pw)) {
    console.log('解锁成功（密码校验通过）。提示：HTTP 登录成功即自动解锁运行中的服务。');
  } else {
    console.error('用户名或密码错误');
    process.exit(1);
  }
}

async function cmdBackup(store) {
  const out = argValue('--out');
  if (!out) {
    console.error('用法: backup --out <path>');
    process.exit(1);
  }
  if (!(await store.exists())) {
    console.error('store 不存在，请先运行 init');
    process.exit(1);
  }
  await store.load();
  const username = (await ask('用户名（默认 admin）: ')).trim() || 'admin';
  const pw = await askPassword();
  if (!(await store.unlockWithPassword(username, pw))) {
    console.error('用户名或密码错误');
    process.exit(1);
  }
  const exportPw = await askPassword('设置导出密码（≥8 位）: ');
  if (exportPw.length < 8) {
    console.error('导出密码太短');
    process.exit(1);
  }
  const backup = await store.exportBackup(username, exportPw);
  await fs.writeFile(out, backup, { mode: 0o600 });
  await audit(DATA_DIR, 'cli_backup', { username });
  console.log(`备份已写入 ${out}（仅含该用户自己的数据）`);
}

async function cmdRestore(store) {
  const input = argValue('--in');
  if (!input) {
    console.error('用法: restore --in <path>');
    process.exit(1);
  }
  if ((await store.exists()) && !process.argv.includes('--force')) {
    console.error('store 已存在，加 --force 覆盖');
    process.exit(1);
  }
  const text = await fs.readFile(input, 'utf8');
  const exportPw = await askPassword('导出密码: ');
  let r;
  try {
    r = await openExportEnvelope(JSON.parse(text), exportPw);
  } catch {
    console.error('导出密码错误或备份文件损坏');
    process.exit(1);
  }
  // 备份里只有导出密码包装的 DEK：重建 store，导出密码成为新密码，并生成新恢复码
  const { envelope, recoveryCode, dek } = await createEnvelope(exportPw, r.payload);
  const username = 'admin';
  store.users = [
    {
      username,
      usernameLower: username,
      role: 'admin',
      status: 'active',
      createdAt: Date.now(),
      lastLoginAt: 0,
      envelope,
    },
  ];
  store.sessions = [];
  store.adoptUnlock(username, { dek, payload: r.payload });
  await store.save();
  await audit(DATA_DIR, 'cli_restore', { username });
  console.log('恢复完成。注意：管理员密码已重置为导出密码，store 已重置为单管理员。');
  console.log(`新恢复码（仅展示一次）:\n${recoveryCode}`);
}

async function main() {
  const cmd = process.argv[2];
  const store = new Store(DATA_DIR);
  try {
    switch (cmd) {
      case 'init':
        await cmdInit(store);
        break;
      case 'unlock':
        await cmdUnlock(store);
        break;
      case 'backup':
        await cmdBackup(store);
        break;
      case 'restore':
        await cmdRestore(store);
        break;
      default:
        console.error('用法: node src/server/cli/index.js <init|unlock|backup --out <path>|restore --in <path>>');
        process.exit(1);
    }
  } finally {
    rl?.close();
  }
}

main().catch((e) => {
  console.error(`错误: ${e.message}`);
  process.exit(1);
});
