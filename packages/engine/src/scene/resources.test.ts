import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import '../plugin';
import { freezeInput } from '../memory';
import { inputs } from '../renderassets';
import { containedPath } from '../studio/sessions';
import { fingerprint } from './record';
import { describeMountedLibraries, FontsCSSFile, prepareResources, resourceFiles, writeFontsCSS } from './resources';
import { buildPrompt, load } from './scene';
import { tempDir, writeScene } from './testsupport';

function fixture() {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'onset.conf'), '');
  const dir = path.join(root, 'scenes', 'one');
  fs.mkdirSync(path.dirname(dir));
  fs.renameSync(
    writeScene('{"id":"one","duration_seconds":1,"output":"out.mp4","transcript":"transcript.srt","text":"hello"}'),
    dir,
  );
  const skills = path.join(root, '.agents', 'skills');
  for (const [rel, body] of Object.entries({
    'assets/fonts/body.woff2': 'font',
    'assets/vendor/lib.min.js': 'window.lib = 1',
    '.agents/skills/scene-kit/scene-kit.js': 'window.SceneKit = {}',
    '.agents/skills/onset-film-style/onset-film-style.json': '{"source":"huashu","slug":"test"}',
    '.agents/skills/onset-film-style/huashu/lib/util.js': 'window.U = {}',
    '.agents/skills/onset-film-style/huashu/lib/fonts/body.woff2': 'font',
  })) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return { root, dir, s: load(dir), resolved: { 'scene-kit': skills, 'onset-film-style': skills } };
}

describe('scene resource integration', () => {
  it('does not change old prompts or add resource fingerprint parts before the first managed render', () => {
    const f = fixture();
    expect(buildPrompt(f.s, f.resolved)).not.toContain('共享渲染资源');
    expect(Object.keys(fingerprint(f.s, 'claude', f.resolved).parts!).some((key) => key.startsWith('asset:'))).toBe(
      false,
    );
  });
  it('prepares project fonts, JS and plugin-declared runtime resources for preview', () => {
    const f = fixture();
    prepareResources(f.s, f.resolved);
    for (const rel of ['assets/fonts/body.woff2', 'vendor/lib.min.js', 'scene-kit.js', 'huashu/lib/util.js']) {
      expect(fs.readFileSync(containedPath(f.root, path.relative(f.root, path.join(f.dir, rel))))).not.toHaveLength(0);
    }
    const prompt = buildPrompt(f.s, f.resolved);
    expect(prompt).toContain('共享渲染资源');
    expect(prompt).toContain('不要再次复制');
    expect(prompt).toContain('huashu/');
    expect(prompt).not.toContain('assets/fonts/body.woff2');
    const brief = buildPrompt(f.s, f.resolved, true);
    expect(brief).toContain('assets/fonts/body.woff2');
    expect(brief).toContain('vendor/lib.min.js');
    expect(brief).not.toContain('sha256');
    const parts = fingerprint(f.s, 'claude', f.resolved).parts!;
    expect(parts['asset:scene-kit.js']).toBeTruthy();
    const hash = parts['asset:assets/fonts/body.woff2'];
    fs.writeFileSync(path.join(f.root, 'assets/fonts/body.woff2'), 'new font');
    expect(fingerprint(f.s, 'claude', f.resolved).parts!['asset:assets/fonts/body.woff2']).not.toBe(hash);
  });

  it('does not mount the default film runtime when the scene opts out', () => {
    const f = fixture();
    expect(resourceFiles({ ...f.s, film_style: 'none' }, f.resolved).map((r) => r.path)).not.toContain(
      'huashu/lib/util.js',
    );
  });

  it('takes runtime assets from the explicitly selected scene style', () => {
    const f = fixture();
    const style = path.join(f.root, '.agents/skills/onset-film-style');
    const extra = path.join(f.root, '.agents/onset-film-styles/huashu/test');
    fs.mkdirSync(path.dirname(extra), { recursive: true });
    fs.renameSync(style, extra);
    const files = resourceFiles({ ...f.s, film_style: 'huashu/test' }, { 'film-style:own': extra });
    expect(files.map((file) => file.path)).toContain('huashu/lib/util.js');
  });

  it('freezes linked assets into the actual memory replay input', () => {
    const f = fixture();
    prepareResources(f.s, f.resolved);
    const snapshot = path.join(tempDir(), 'input');
    const before = inputs(f.dir, resourceFiles(f.s, f.resolved));
    freezeInput(f.s, snapshot);
    fs.rmSync(f.root, { recursive: true, force: true });
    expect(inputs(snapshot, [])).toEqual(before);
    expect(fs.readFileSync(path.join(snapshot, 'scene-kit.js'), 'utf8')).toContain('SceneKit');
  });

  it('keeps preview blocking links to caches outside the project', () => {
    if (process.platform === 'win32') return;
    const f = fixture();
    const outside = path.join(tempDir(), 'lib.js');
    fs.writeFileSync(outside, 'outside');
    fs.symlinkSync(outside, path.join(f.dir, 'bad.js'));
    expect(() => containedPath(f.root, path.relative(f.root, path.join(f.dir, 'bad.js')))).toThrow('逃出了项目');
  });

  it('distinguishes named font weights and refuses to overwrite hand-written or symlinked onset-fonts.css', () => {
    const dir = tempDir();
    expect(
      writeFontsCSS(dir, [
        'assets/fonts/inter-semibold.woff2',
        'assets/fonts/inter-extrabold.woff2',
        'assets/fonts/inter-thin.woff2',
        'assets/fonts/inter-black.woff2',
      ]),
    ).toBe(true);
    const css = fs.readFileSync(path.join(dir, FontsCSSFile), 'utf8');
    expect(css).toContain('font-weight: 600;');
    expect(css).toContain('font-weight: 800;');
    expect(css).toContain('font-weight: 100;');
    expect(css).toContain('font-weight: 900;');
    // 已由 onset 生成的文件允许幂等更新。
    expect(writeFontsCSS(dir, ['assets/fonts/inter-bold.woff2'])).toBe(true);
    expect(fs.readFileSync(path.join(dir, FontsCSSFile), 'utf8')).toContain('font-weight: 700;');
    // 手写文件拒绝覆盖并保留原内容。
    fs.writeFileSync(path.join(dir, FontsCSSFile), '/* custom */\n');
    expect(() => writeFontsCSS(dir, ['assets/fonts/inter-bold.woff2'])).toThrow('手写');
    expect(fs.readFileSync(path.join(dir, FontsCSSFile), 'utf8')).toBe('/* custom */\n');
    if (process.platform !== 'win32') {
      const target = path.join(tempDir(), 'real.css');
      fs.writeFileSync(target, '/* target */\n');
      fs.rmSync(path.join(dir, FontsCSSFile));
      fs.symlinkSync(target, path.join(dir, FontsCSSFile));
      expect(() => writeFontsCSS(dir, ['assets/fonts/inter-bold.woff2'])).toThrow('符号链接');
    }
  });

  it('extracts public JS exports for unminified helper libraries up to 128 KB', () => {
    const dir = tempDir();
    const rel = 'papercraft/big-kit.js';
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 80 KB（大于旧的 64 KB 上限、小于新的 128 KB 上限）
    const body = 'export function printCard(pts, opts) { return pts; }\n' + '// '.padEnd(80 * 1024, 'x') + '\n';
    fs.writeFileSync(file, body, 'utf8');
    const summary = describeMountedLibraries(dir, [rel]);
    expect(summary).toEqual(['`papercraft/big-kit.js`：printCard(pts, opts)']);
  });
});
