import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BreezeTTS2 } from '../config/providers';
import { designStatus } from '../voice/design';
import { ensureTool, type ToolSpec, toolStatus } from './tools';
import { compareToolVersions, uvToolInstalledVersion } from './uv_version';

const createdDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-uvver-'));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs) fs.rmSync(dir, { recursive: true, force: true });
  createdDirs.length = 0;
});

function makeFakeUvVenv(root: string, pkgDirName: string, version: string, withMetadata = true): string {
  const venv = path.join(root, 'venv');
  fs.mkdirSync(path.join(venv, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(venv, 'pyvenv.cfg'), 'home = /usr/bin\n');
  const distInfo = path.join(venv, 'lib', 'python3.12', 'site-packages', `${pkgDirName}-${version}.dist-info`);
  fs.mkdirSync(distInfo, { recursive: true });
  if (withMetadata) {
    fs.writeFileSync(
      path.join(distInfo, 'METADATA'),
      `Metadata-Version: 2.4\nName: ${pkgDirName}\nVersion: ${version}\n`,
    );
  }
  return venv;
}

describe('compareToolVersions', () => {
  it('compares PEP 440 releases, prereleases and postreleases accurately', () => {
    expect(compareToolVersions('0.5.8', '0.6.5')).toBeLessThan(0);
    expect(compareToolVersions('0.6.1', '0.6.5')).toBeLessThan(0);
    expect(compareToolVersions('0.6.5', '0.6.5')).toBe(0);
    expect(compareToolVersions('0.6.8', '0.6.5')).toBeGreaterThan(0);
    expect(compareToolVersions('0.6.10', '0.6.5')).toBeGreaterThan(0);
    expect(compareToolVersions('0.6.5a1', '0.6.5')).toBeLessThan(0);
    expect(compareToolVersions('0.6.5rc1', '0.6.5')).toBeLessThan(0);
    expect(compareToolVersions('0.6.5.post1', '0.6.5')).toBeGreaterThan(0);
    expect(compareToolVersions('0.6.5.post1.dev0', '0.6.5')).toBeGreaterThan(0);
    expect(compareToolVersions('0.6.5.post1.dev0', '0.6.5.post1')).toBeLessThan(0);
    expect(compareToolVersions('0.6.5a1.dev0', '0.6.5a1')).toBeLessThan(0);
    expect(compareToolVersions('0.6.5.dev0', '0.6.5a1')).toBeLessThan(0);
    expect(compareToolVersions('0.6', '0.6.0')).toBe(0);
    expect(compareToolVersions('not-a-version', '0.6.5')).toBeNull();
  });
});

describe('uvToolInstalledVersion & toolStatus version gate', () => {
  const spec: ToolSpec = {
    kind: 'uv-tool',
    package: 'mlx-audio',
    version: '0.6.5',
    bins: ['mlx_audio.tts.generate'],
    prerelease: true,
  };

  it.skipIf(process.platform === 'win32')(
    'flags outdated uv-tool installs (e.g. 0.5.8 / 0.6.1 < 0.6.5) and accepts >= 0.6.5',
    () => {
      const home = tempDir();
      const userBin = path.join(home, '.local', 'bin');
      fs.mkdirSync(userBin, { recursive: true });
      const oldVenv = makeFakeUvVenv(path.join(home, 'old'), 'mlx_audio', '0.5.8');
      const script = path.join(userBin, 'mlx_audio.tts.generate');
      fs.writeFileSync(script, `#!${path.join(oldVenv, 'bin', 'python')}\nimport sys\n`, { mode: 0o755 });
      const env = { HOME: home, PATH: userBin };

      expect(uvToolInstalledVersion(spec, script, env)).toBe('0.5.8');
      expect(toolStatus(spec, env)).toEqual({ ok: false, where: script });

      const newVenv = makeFakeUvVenv(path.join(home, 'new'), 'mlx_audio', '0.6.5');
      fs.writeFileSync(script, `#!${path.join(newVenv, 'bin', 'python')}\nimport sys\n`, { mode: 0o755 });
      expect(uvToolInstalledVersion(spec, script, env)).toBe('0.6.5');
      expect(toolStatus(spec, env)).toEqual({ ok: true, where: script });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'parses uv space-safe #!/bin/sh exec wrappers and fails open on opaque stubs',
    () => {
      const home = tempDir();
      const bin = path.join(home, 'bin');
      fs.mkdirSync(bin, { recursive: true });
      const spacedVenv = makeFakeUvVenv(path.join(home, 'my tools'), 'mlx_audio', '0.6.1', false);
      const script = path.join(bin, 'mlx_audio.tts.generate');
      fs.writeFileSync(script, `#!/bin/sh\n'''exec' '${path.join(spacedVenv, 'bin', 'python')}' "$0" "$@"\n' '''\n`, {
        mode: 0o755,
      });
      const env = { HOME: home, PATH: bin };
      expect(uvToolInstalledVersion(spec, script, env)).toBe('0.6.1');
      expect(toolStatus(spec, env)).toEqual({ ok: false, where: script });

      // 无法识别版本的自定义脚本或测试桩：安全放行不崩溃。
      fs.writeFileSync(script, '#!/bin/sh\necho custom\n', { mode: 0o755 });
      expect(uvToolInstalledVersion(spec, script, env)).toBeNull();
      expect(toolStatus(spec, env)).toEqual({ ok: true, where: script });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'detects onset-managed uv tool venv even for binary launchers without text shebang',
    () => {
      const home = tempDir();
      const data = path.join(home, '.local', 'share', 'onset');
      const bin = path.join(data, 'bin');
      fs.mkdirSync(bin, { recursive: true });
      const distInfo = path.join(
        data,
        'tools',
        'uv',
        'mlx-audio',
        'lib',
        'python3.12',
        'site-packages',
        'mlx_audio-0.6.1.dist-info',
      );
      fs.mkdirSync(distInfo, { recursive: true });
      fs.writeFileSync(path.join(distInfo, 'METADATA'), 'Name: mlx-audio\nVersion: 0.6.1\n');
      const launcher = path.join(bin, 'mlx_audio.tts.generate');
      // 含 NUL 字节模拟二进制启动器。
      fs.writeFileSync(launcher, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]), { mode: 0o755 });
      const env = { HOME: home, PATH: '/nonexistent' };
      expect(uvToolInstalledVersion(spec, launcher, env)).toBe('0.6.1');
      expect(toolStatus(spec, env)).toEqual({ ok: false, where: launcher });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not attribute a stale managed venv version to a custom text wrapper in managed bin and keeps designStatus ready',
    () => {
      const home = tempDir();
      const data = path.join(home, '.local', 'share', 'onset');
      const bin = path.join(data, 'bin');
      fs.mkdirSync(bin, { recursive: true });
      const staleDistInfo = path.join(
        data,
        'tools',
        'uv',
        'mlx-audio',
        'lib',
        'python3.12',
        'site-packages',
        'mlx_audio-0.6.1.dist-info',
      );
      fs.mkdirSync(staleDistInfo, { recursive: true });
      fs.writeFileSync(path.join(staleDistInfo, 'METADATA'), 'Name: mlx-audio\nVersion: 0.6.1\n');
      const wrapper = path.join(bin, 'mlx_audio.tts.generate');
      fs.writeFileSync(wrapper, '#!/bin/sh\nexec /opt/custom/mlx_audio.tts.generate "$@"\n', { mode: 0o755 });

      const modelRoot = path.join(data, 'models', 'mlx-community__Breeze-TTS-2-mlx-8bit');
      for (const f of BreezeTTS2.files) {
        const dest = path.join(modelRoot, f.path);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, '');
        fs.truncateSync(dest, f.size);
      }

      const env = { HOME: home, PATH: '/nonexistent' };
      expect(uvToolInstalledVersion(spec, wrapper, env)).toBeNull();
      expect(toolStatus(spec, env)).toEqual({ ok: true, where: wrapper });
      expect(designStatus(env, 'darwin', 'arm64')).toEqual({ ready: true, supported: true, problem: '' });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'triggers uv upgrade in ensureTool when PATH holds an outdated version',
    async () => {
      const home = tempDir();
      const userBin = path.join(home, '.local', 'bin');
      const data = path.join(home, '.local', 'share', 'onset');
      const onsetBin = path.join(data, 'bin');
      fs.mkdirSync(userBin, { recursive: true });
      fs.mkdirSync(onsetBin, { recursive: true });

      const oldVenv = makeFakeUvVenv(path.join(home, 'old'), 'mlx_audio', '0.5.8');
      fs.writeFileSync(path.join(userBin, 'mlx_audio.tts.generate'), `#!${path.join(oldVenv, 'bin', 'python')}\n`, {
        mode: 0o755,
      });
      const uvArgsFile = path.join(home, 'uv-args.json');
      const upgradedVenv = makeFakeUvVenv(path.join(home, 'upgraded'), 'mlx_audio', '0.6.5');
      // 假 uv：记录收到的参数并在 UV_TOOL_BIN_DIR 写入指向 0.6.5 venv 的入口脚本。
      fs.writeFileSync(
        path.join(onsetBin, 'uv'),
        `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(${JSON.stringify(uvArgsFile)}, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(
  path.join(process.env.UV_TOOL_BIN_DIR, 'mlx_audio.tts.generate'),
  '#!${path.join(upgradedVenv, 'bin', 'python')}\\n',
  { mode: 0o755 },
);
`,
        { mode: 0o755 },
      );

      const env = { HOME: home, PATH: userBin };
      const installedPath = await ensureTool(spec, { env });
      expect(installedPath).toBe(path.join(onsetBin, 'mlx_audio.tts.generate'));
      const uvArgs = JSON.parse(fs.readFileSync(uvArgsFile, 'utf8')) as string[];
      expect(uvArgs).toContain('--force');
      expect(uvArgs).toContain('mlx-audio==0.6.5');
      expect(toolStatus(spec, env)).toEqual({ ok: true, where: installedPath });
    },
  );
});
