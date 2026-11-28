/**
 * 命令行工具安装：npm 包、uv tool、uv venv 与 Windows 原生 Breeze。
 */
import fs from 'node:fs';
import path from 'node:path';
import { windowsPythonScript } from '../envutil';
import { marshal } from '../gojson';
import { type Writer, watchSize } from '../hyperframes';
import { binDir, dataDir, findOptional, npmCommand, withNode } from '../toolpath';
import { ensureWindowsBreeze, windowsBreezeStatus } from '../windowsruntime/breeze';
import { ensureUV } from './binaries';
import { GitHubMirrorEnv, type InstallOptions, mirrored, platformKey, requireBinDir, runCommandIn } from './download';
import { compareToolVersions, uvToolInstalledVersion } from './uv_version';

/** uv 下载的独立 Python 放在哪：<数据目录>/python，节拍分析环境与 Python 类工具共用。 */
export function pythonInstallDir(env: Record<string, string | undefined>): string {
  const data = dataDir(env);
  return data === '' ? '' : path.join(data, 'python');
}

/** uv 给工具用的 Python 版本：各家工具与 torch 都有预编译包。 */
export const ToolPythonVersion = '3.12';

/**
 * 一个由 onset setup 安装的命令行工具（配音、对齐）。版本都钉死，同一台机器两次安装得到同一个东西。
 * - npm：npm 包，用 onset 自己的运行时执行（客户端用户不必装 Node）。
 * - uv-tool：Python 包的命令行入口，`uv tool install` 装进独立环境，用 uv 带的 Python。
 * - uv-venv：没有命令行入口的 Python 包（funasr），装进专用环境，再写一个调用那份 Python 的小脚本。
 */
export type ToolSpec =
  | { kind: 'native-breeze'; version: string; bins: string[]; platforms: string[] }
  | { kind: 'npm'; package: string; version: string; bins: string[] }
  | { kind: 'uv-tool'; package: string; version: string; bins: string[]; prerelease?: boolean; platforms?: string[] }
  | { kind: 'uv-venv'; name: string; packages: string[]; bin: string; platforms?: string[] };

/** 这份工具要提供的命令名。 */
export function toolBins(spec: ToolSpec): string[] {
  return spec.kind === 'uv-venv' ? [spec.bin] : spec.bins;
}

/** 这台机器能不能装：mlx-audio 只有 Apple Silicon。 */
export function toolSupported(spec: ToolSpec): boolean {
  const platforms = spec.kind === 'npm' ? undefined : spec.platforms;
  return !platforms || platforms.includes(platformKey());
}

/** 工具的命令都能找到且 uv-tool 版本满足下限（onset 装的或用户自己装的）。 */
export function toolStatus(spec: ToolSpec, env: Record<string, string | undefined>): { ok: boolean; where: string } {
  if (spec.kind === 'native-breeze') return windowsBreezeStatus(env);
  const found = toolBins(spec).map((bin) => findOptional(bin, env));
  if (!found.every((f) => f !== '')) return { ok: false, where: binDir(env) };
  if (spec.kind === 'uv-tool') {
    for (const file of found) {
      const installed = uvToolInstalledVersion(spec, file, env);
      if (installed !== null) {
        const cmp = compareToolVersions(installed, spec.version);
        if (cmp !== null && cmp < 0) return { ok: false, where: file };
      }
    }
  }
  return { ok: true, where: found[0] };
}

/** 装好一个工具（命令都能找到且版本达标就不动），返回第一个命令的路径。 */
export async function ensureTool(spec: ToolSpec, opts: InstallOptions): Promise<string> {
  const report = opts.progress ?? (() => {});
  const status = toolStatus(spec, opts.env);
  if (status.ok) {
    report({ stage: '已就绪', percent: 100 });
    return status.where;
  }
  if (!toolSupported(spec)) throw new Error(`这个工具不支持 ${platformKey()}`);
  const bin = requireBinDir(opts.env);
  const data = dataDir(opts.env);
  switch (spec.kind) {
    case 'native-breeze':
      return ensureWindowsBreeze(opts);
    case 'npm':
      await installNpmTool(spec, path.join(data, 'tools', 'npm'), bin, opts);
      break;
    case 'uv-tool':
    case 'uv-venv': {
      const uv = await ensureUV({
        ...opts,
        progress: (p) => report({ ...p, stage: p.stage === 'uv 已就绪' ? '准备 uv' : p.stage }),
      });
      if (spec.kind === 'uv-tool') await installUVTool(spec, uv, data, bin, opts);
      else await installUVVenv(spec, uv, data, bin, opts);
      break;
    }
  }
  const after = toolStatus(spec, opts.env);
  if (!after.ok) {
    if (spec.kind === 'uv-tool') {
      const installed = uvToolInstalledVersion(spec, after.where, opts.env);
      if (installed !== null) {
        throw new Error(
          `装完了但 ${spec.package} 版本仍低于 ${spec.version}（当前 ${installed}，路径 ${after.where}）`,
        );
      }
    }
    throw new Error(`装完了但找不到 ${toolBins(spec).join('、')}：包结构可能已变`);
  }
  report({ stage: '已就绪', percent: 100 });
  return after.where;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function writeExecutable(file: string, body: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o755 });
  fs.renameSync(tmp, file);
}

/**
 * npm 包装进 <数据目录>/tools/npm/<包>@<版本>（先在临时目录装好再改名进位），每个命令写一个小脚本进 bin：
 * 用 onset 的运行时执行包的入口；客户端换了位置导致运行时不在时，退回 PATH 里的 node。
 */
async function installNpmTool(
  spec: Extract<ToolSpec, { kind: 'npm' }>,
  root: string,
  bin: string,
  opts: InstallOptions,
): Promise<void> {
  const report = opts.progress ?? (() => {});
  const dir = path.join(root, `${spec.package.replace('/', '+')}@${spec.version}`);
  fs.mkdirSync(root, { recursive: true });
  if (!fs.existsSync(path.join(dir, '.onset-tool'))) {
    const staging = fs.mkdtempSync(path.join(root, '.staging-'));
    try {
      fs.writeFileSync(path.join(staging, 'package.json'), '{"private":true}\n');
      const stage = `安装 ${spec.package}@${spec.version}`;
      report({ stage, percent: 0, indeterminate: true });
      const npm = npmCommand(opts.env, [
        'install',
        '--no-audit',
        '--no-fund',
        '--loglevel=error',
        '--save-exact',
        `${spec.package}@${spec.version}`,
      ]);
      const sink: Writer = opts.output ?? { write: () => true };
      // npm 一声不吭：量临时目录长了多少，界面才看得出它在下载。
      const stop = watchSize([staging], (bytes) => report({ stage, percent: 0, indeterminate: true, bytes }));
      await runCommandIn(npm.file, npm.args, staging, withNode({ ...opts.env, ...npm.env }), sink, opts.signal).finally(
        stop,
      );
      fs.writeFileSync(path.join(staging, '.onset-tool'), `${spec.package}@${spec.version}\n`);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(staging, dir);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
  const pkgDir = path.join(dir, 'node_modules', ...spec.package.split('/'));
  const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  for (const name of spec.bins) {
    const rel = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[name];
    if (!rel) throw new Error(`${spec.package}@${spec.version} 没有 ${name} 这个命令`);
    const entry = path.join(pkgDir, rel);
    if (process.platform === 'win32') {
      // bin 与工具数据可在不同盘：在 bin 留一个可被 cmd-shim 识别的 JS 入口，
      // 由同一 Node/Electron 运行时启动真正的入口，保留 require.main、ESM 与多行参数。
      const bridge = `${name}.onset.cjs`;
      writeExecutable(
        path.join(bin, bridge),
        [
          "const { spawnSync } = require('node:child_process');",
          `const result = spawnSync(process.execPath, [${marshal(entry)}, ...process.argv.slice(2)], { env: process.env, stdio: 'inherit', windowsHide: true });`,
          'if (result.error) { console.error(result.error.message); process.exitCode = 1; }',
          'else process.exitCode = result.status ?? 1;',
          '',
        ].join('\n'),
      );
      const runtime = process.execPath.replaceAll('%', '%%');
      writeExecutable(
        path.join(bin, name + '.cmd'),
        [
          '@echo off',
          'chcp 65001 >nul',
          'setlocal',
          `if exist "${runtime}" (`,
          '  set "ELECTRON_RUN_AS_NODE=1"',
          `  "${runtime}" "%~dp0\\${bridge}" %*`,
          ') else (',
          `  node "%~dp0\\${bridge}" %*`,
          ')',
          '',
        ].join('\r\n'),
      );
      continue;
    }
    writeExecutable(
      path.join(bin, name),
      [
        '#!/bin/sh',
        `# 由 onset setup 写出：用 onset 的运行时执行 ${spec.package}@${spec.version}。`,
        `r=${q(process.execPath)}`,
        `if [ -x "$r" ]; then ELECTRON_RUN_AS_NODE=1 exec "$r" ${q(entry)} "$@"; fi`,
        `exec node ${q(entry)} "$@"`,
        '',
      ].join('\n'),
    );
  }
}

/** uv 的公共环境：工具、Python 都装在 onset 的数据目录；Python 包的源沿用用户 pip.conf 里的镜像。 */
function uvEnv(data: string, bin: string, opts: InstallOptions): Record<string, string> {
  const env: Record<string, string> = {
    ...opts.env,
    UV_TOOL_DIR: path.join(data, 'tools', 'uv'),
    UV_TOOL_BIN_DIR: bin,
    UV_PYTHON_INSTALL_DIR: pythonInstallDir(opts.env),
    UV_PYTHON_PREFERENCE: 'only-managed',
  };
  if (!env.UV_DEFAULT_INDEX && !env.UV_INDEX_URL) {
    const index = pipIndexURL(opts.env);
    if (index !== '') env.UV_DEFAULT_INDEX = index;
  }
  if (opts.env[GitHubMirrorEnv]) {
    env.UV_PYTHON_INSTALL_MIRROR = mirrored(
      'https://github.com/astral-sh/python-build-standalone/releases/download',
      opts.env,
    );
  }
  return env;
}

async function installUVTool(
  spec: Extract<ToolSpec, { kind: 'uv-tool' }>,
  uv: string,
  data: string,
  bin: string,
  opts: InstallOptions,
): Promise<void> {
  const report = opts.progress ?? (() => {});
  const stage = `安装 ${spec.package}==${spec.version}`;
  report({ stage, percent: 0, indeterminate: true });
  const args = ['tool', 'install', '--force', '--python', ToolPythonVersion];
  if (spec.prerelease) args.push('--prerelease', 'allow');
  args.push(`${spec.package}==${spec.version}`);
  // uv 装 Python 与包时量这两个目录长了多少：界面据此显示下了多少、多快。
  const stop = watchSize([path.join(data, 'tools', 'uv'), pythonInstallDir(opts.env)], (bytes) =>
    report({ stage, percent: 0, indeterminate: true, bytes }),
  );
  await runCommandIn(uv, args, data, uvEnv(data, bin, opts), opts.output ?? { write: () => true }, opts.signal).finally(
    stop,
  );
}

async function installUVVenv(
  spec: Extract<ToolSpec, { kind: 'uv-venv' }>,
  uv: string,
  data: string,
  bin: string,
  opts: InstallOptions,
): Promise<void> {
  const report = opts.progress ?? (() => {});
  const venv = path.join(data, 'tools', 'venv', spec.name);
  const env = uvEnv(data, bin, opts);
  const sink: Writer = opts.output ?? { write: () => true };
  const make = `建 ${spec.name} 的 Python 环境`;
  report({ stage: make, percent: 0, indeterminate: true });
  fs.rmSync(venv, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(venv), { recursive: true });
  let stop = watchSize([pythonInstallDir(opts.env)], (bytes) =>
    report({ stage: make, percent: 0, indeterminate: true, bytes }),
  );
  await runCommandIn(uv, ['venv', '--python', ToolPythonVersion, venv], data, env, sink, opts.signal).finally(stop);
  const install = `安装 ${spec.packages.join(' ')}`;
  report({ stage: install, percent: 0, indeterminate: true });
  const windows = process.platform === 'win32';
  const python = windows ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
  // torch 这类包几百 MB：量环境目录长了多少，界面才看得出它在下载。
  stop = watchSize([venv], (bytes) => report({ stage: install, percent: 0, indeterminate: true, bytes }));
  await runCommandIn(
    uv,
    ['pip', 'install', '--python', python, ...spec.packages],
    data,
    env,
    sink,
    opts.signal,
  ).finally(stop);
  if (windows) writeExecutable(path.join(bin, spec.bin + '.cmd'), windowsPythonScript(python));
  else {
    writeExecutable(
      path.join(bin, spec.bin),
      `#!/bin/sh\n# 由 onset setup 写出：${spec.name} 专用的 Python 环境。\nexec ${q(python)} "$@"\n`,
    );
  }
}

/**
 * 用户 pip 配置里的 index-url（PIP_INDEX_URL 优先，其次 pip.conf）：国内用户多半配了镜像，
 * 而 uv 自己的安装器不读 pip.conf，不转过去的话 torch 这种几百 MB 的包会从境外直连。
 */
export function pipIndexURL(env: Record<string, string | undefined>): string {
  if (env.PIP_INDEX_URL) return env.PIP_INDEX_URL;
  const home = env.HOME ?? '';
  const files = [
    env.PIP_CONFIG_FILE ?? '',
    home && path.join(home, '.config', 'pip', 'pip.conf'),
    home && path.join(home, '.pip', 'pip.conf'),
    home && path.join(home, 'Library', 'Application Support', 'pip', 'pip.conf'),
    '/Library/Application Support/pip/pip.conf',
    '/etc/pip.conf',
  ].filter(Boolean);
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const m = /^\s*index-url\s*[=:]\s*(\S+)/m.exec(text);
    if (m) return m[1];
  }
  return '';
}
