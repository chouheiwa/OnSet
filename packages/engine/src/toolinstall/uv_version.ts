/**
 * uv-tool 已安装版本的本地离线探测与 PEP 440 比较。
 *
 * 只读文件、不拉起 Python 子进程：找不到版本或解析失败时返回 null（由调用方按兼容放行），
 * 确保自定义包装脚本、测试桩与离线环境不会误报或崩溃。
 */
import fs from 'node:fs';
import path from 'node:path';
import { binDir, dataDir } from '../toolpath';

interface ParsedVersion {
  epoch: number;
  release: number[];
  /** 0=a/alpha, 1=b/beta, 2=rc/c, 3=final */
  preRank: number;
  preNum: number;
  /** 0=无 post, 1=有 post */
  postRank: number;
  postNum: number;
  /** 0=有 dev（早于对应正式/pre/post）, 1=无 dev */
  devRank: number;
  devNum: number;
}

const PEP440_PATTERN =
  /^(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-._]?(a|alpha|b|beta|rc|c)(\d*))?(?:[-._]?post(\d*))?(?:[-._]?dev(\d*))?(?:\+[^ \t\r\n]+)?$/i;

function parseVersion(raw: string): ParsedVersion | null {
  const trimmed = raw.trim();
  const match = PEP440_PATTERN.exec(trimmed);
  if (!match) return null;
  const epoch = match[1] ? Number(match[1]) : 0;
  const release = match[2].split('.').map((part) => Number(part));
  if (release.some((n) => !Number.isFinite(n))) return null;
  const preKind = match[3]?.toLowerCase();
  const preRank = !preKind
    ? 3
    : preKind === 'a' || preKind === 'alpha'
      ? 0
      : preKind === 'b' || preKind === 'beta'
        ? 1
        : 2;
  const preNum = match[4] ? Number(match[4]) : 0;
  const postRank = match[5] !== undefined ? 1 : 0;
  const postNum = match[5] ? Number(match[5]) : 0;
  const devRank = match[6] !== undefined ? 0 : 1;
  const devNum = match[6] ? Number(match[6]) : 0;
  return { epoch, release, preRank, preNum, postRank, postNum, devRank, devNum };
}

/** 比较两个 PEP 440 版本号：a < b 返回负数，a === b 返回 0，a > b 返回正数；无法解析返回 null。 */
export function compareToolVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  if (pa.epoch !== pb.epoch) return pa.epoch - pb.epoch;
  const len = Math.max(pa.release.length, pb.release.length);
  for (let i = 0; i < len; i++) {
    const da = pa.release[i] ?? 0;
    const db = pb.release[i] ?? 0;
    if (da !== db) return da - db;
  }
  // 无 pre 且无 post 的 .devN 早于同版本号的 a/b/rc（PEP 440: 1.0.dev0 < 1.0a1 < 1.0 < 1.0.post1.dev0 < 1.0.post1）。
  const aTopDev = pa.preRank === 3 && pa.postRank === 0 && pa.devRank === 0 ? 0 : 1;
  const bTopDev = pb.preRank === 3 && pb.postRank === 0 && pb.devRank === 0 ? 0 : 1;
  if (aTopDev !== bTopDev) return aTopDev - bTopDev;
  if (pa.preRank !== pb.preRank) return pa.preRank - pb.preRank;
  if (pa.preNum !== pb.preNum) return pa.preNum - pb.preNum;
  if (pa.postRank !== pb.postRank) return pa.postRank - pb.postRank;
  if (pa.postNum !== pb.postNum) return pa.postNum - pb.postNum;
  if (pa.devRank !== pb.devRank) return pa.devRank - pb.devRank;
  return pa.devNum - pb.devNum;
}

function normalizeDistName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '_');
}

function venvFromPython(pythonPath: string): string {
  const parent = path.dirname(pythonPath);
  const base = path.basename(parent).toLowerCase();
  if (base === 'bin' || base === 'scripts') return path.dirname(parent);
  return '';
}

type LauncherKind = { kind: 'script'; venv: string } | { kind: 'binary' } | { kind: 'unreadable' };

function inspectLauncher(binaryPath: string): LauncherKind {
  let head: string;
  try {
    const fd = fs.openSync(binaryPath, 'r');
    try {
      const buf = Buffer.alloc(512);
      const n = fs.readSync(fd, buf, 0, 512, 0);
      if (buf.subarray(0, n).includes(0)) return { kind: 'binary' };
      head = buf.subarray(0, n).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { kind: 'unreadable' };
  }
  if (!head.startsWith('#!')) return { kind: 'script', venv: '' };
  const firstLineEnd = head.indexOf('\n');
  const firstLine = (firstLineEnd >= 0 ? head.slice(2, firstLineEnd) : head.slice(2)).trim();
  // uv 在路径含空格时写出 `#!/bin/sh\n'''exec' '/path/to/python' "$0" "$@"`
  if (firstLine === '/bin/sh' || firstLine.endsWith('/sh')) {
    const execMatch = /'''exec'[ \t]+(?:'([^'\r\n]+)'|"([^"\r\n]+)"|([^ \t\r\n]+))/.exec(head);
    const py = execMatch?.[1] ?? execMatch?.[2] ?? execMatch?.[3] ?? '';
    return { kind: 'script', venv: py ? venvFromPython(py) : '' };
  }
  const token = firstLine.split(/[ \t]+/)[0] ?? '';
  if (!token || token.endsWith('/env')) return { kind: 'script', venv: '' };
  return { kind: 'script', venv: venvFromPython(token) };
}

function sitePackagesDirs(venvDir: string): string[] {
  const dirs: string[] = [];
  const winSite = path.join(venvDir, 'Lib', 'site-packages');
  if (fs.existsSync(winSite)) dirs.push(winSite);
  for (const libName of ['lib', 'lib64']) {
    const libDir = path.join(venvDir, libName);
    let entries: string[];
    try {
      entries = fs.readdirSync(libDir).sort();
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.startsWith('python')) continue;
      const site = path.join(libDir, entry, 'site-packages');
      if (fs.existsSync(site)) dirs.push(site);
    }
  }
  return dirs;
}

function readPackageVersion(venvDir: string, packageName: string): string | null {
  const target = normalizeDistName(packageName);
  for (const site of sitePackagesDirs(venvDir)) {
    let entries: string[];
    try {
      entries = fs.readdirSync(site).sort();
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.dist-info')) continue;
      const stem = entry.slice(0, -'.dist-info'.length);
      const dash = stem.indexOf('-');
      if (dash <= 0) continue;
      if (normalizeDistName(stem.slice(0, dash)) !== target) continue;
      try {
        const meta = fs.readFileSync(path.join(site, entry, 'METADATA'), 'utf8');
        const m = /^Version:[ \t]*(\S+)/m.exec(meta);
        if (m) return m[1];
      } catch {
        // METADATA 缺失时退回目录名里的版本段。
      }
      const fromDir = stem.slice(dash + 1);
      if (fromDir) return fromDir;
    }
  }
  return null;
}

/** 探测 uv-tool 可执行文件对应环境里该包的已安装版本；无法确定时返回 null。 */
export function uvToolInstalledVersion(
  spec: { package: string },
  binaryPath: string,
  env: Record<string, string | undefined>,
): string | null {
  const launcher = inspectLauncher(binaryPath);
  if (launcher.kind === 'unreadable') return null;

  const candidates: string[] = [];
  const add = (dir: string) => {
    if (dir && !candidates.includes(dir)) candidates.push(dir);
  };
  if (launcher.kind === 'script') add(launcher.venv);
  try {
    const real = fs.realpathSync(binaryPath);
    const parentVenv = venvFromPython(real);
    if (parentVenv && fs.existsSync(path.join(parentVenv, 'pyvenv.cfg'))) add(parentVenv);
  } catch {
    // 忽略符号链接解析失败。
  }
  // 只有二进制启动器（如 Windows uv .exe）无法读 shebang，才回退到受管目录；
  // 无法识别的自定义文本包装脚本按兼容契约返回 null，避免误读残留在受管目录里的旧版本。
  if (launcher.kind === 'binary') {
    const managedBin = binDir(env);
    const data = dataDir(env);
    if (managedBin && data) {
      const sameDir =
        process.platform === 'win32'
          ? path.dirname(path.resolve(binaryPath)).toLowerCase() === path.resolve(managedBin).toLowerCase()
          : path.dirname(path.resolve(binaryPath)) === path.resolve(managedBin);
      if (sameDir) {
        add(path.join(data, 'tools', 'uv', spec.package));
        add(path.join(data, 'tools', 'uv', spec.package.toLowerCase().replace(/[-_.]+/g, '-')));
      }
    }
  }
  for (const venv of candidates) {
    const version = readPackageVersion(venv, spec.package);
    if (version !== null) return version;
  }
  return null;
}
