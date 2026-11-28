import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import * as determinism from '../../determinism';
import * as filmstyle from '../../filmstyle';
import '../../plugin';
import { load as loadScene, resolveAllSkills } from '../../scene';
import { verifySceneMotionEffects } from '../../scene/motion_prompt';
import { prepareResources } from '../../scene/resources';
import {
  catalog,
  entryStyle,
  find,
  LicenseName,
  PinnedCommit,
  PinnedStyleCount,
  PinnedVersion,
  papercraftSource,
  RuntimeFiles2D,
  RuntimeFiles3D,
  SourceID,
  ThreeVersion,
  UpstreamRepo,
} from './index';

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-papercraft-'));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

describe('papercraft-styles catalog & packaging', () => {
  it('ships 2 offline MIT styles (2D + 3D) with valid contracts, motion effects, and no node_modules paths', () => {
    const list = catalog();
    expect(list.length).toBe(PinnedStyleCount);
    expect(list.map((s) => s.slug)).toEqual(['popup-2d', 'popup-3d']);

    for (const entry of list) {
      expect(entry.cn).not.toBe('');
      expect(entry.en).not.toBe('');
      expect(entry.summary).not.toBe('');
      expect(entry.uses.length).toBeGreaterThanOrEqual(2);
      expect(entry.taboos.length).toBeGreaterThanOrEqual(3);
      const hits = verifySceneMotionEffects(entry.motion_effects, undefined, entry.slug);
      expect(hits.length).toBe(entry.motion_effects.length);
    }

    expect(find('popup-2d')!.engine_contract).toMatchObject({ required: ['canvas2d'], severity: 'warn' });
    expect(find('popup-3d')!.engine_contract).toMatchObject({ required: ['threejs'], severity: 'error' });

    // 严禁在内置资产路径中出现 node_modules（electron-builder extraResources 会静默丢弃）。
    for (const rel of [...RuntimeFiles2D, ...RuntimeFiles3D]) {
      expect(rel).not.toContain('node_modules');
      expect(rel).not.toContain('paper-sound');
      expect(rel).not.toContain('paper-music');
    }
    expect(RuntimeFiles2D.some((r) => r.includes('three'))).toBe(false);
    expect(RuntimeFiles3D).toContain('papercraft/vendor/three/three.module.js');
    expect(RuntimeFiles3D).toContain('papercraft/vendor/three/LICENSE');
  });

  it('passes check() offline and exposes posters for both styles', () => {
    expect(() => papercraftSource.check({})).not.toThrow();
    for (const entry of catalog()) {
      const poster = papercraftSource.poster({}, entry.slug);
      expect(fs.existsSync(poster), poster).toBe(true);
      expect(fs.statSync(poster).size).toBeGreaterThan(1024);
    }
  });

  it('registers in filmstyle catalog without colliding with any other source', () => {
    expect(filmstyle.sourceByID(SourceID)).toBeDefined();
    expect(filmstyle.sourceByID(SourceID)!.runtimeAssets).toEqual(['papercraft']);
    expect(filmstyle.categories(SourceID)).toEqual(['折纸与立体书']);

    const others = filmstyle
      .sources()
      .filter((s) => s.id() !== SourceID)
      .flatMap((s) => s.catalog());
    const otherCN = new Set(others.map((o) => o.cn));
    const otherSlugs = new Set(others.map((o) => o.slug));

    for (const entry of catalog()) {
      expect(otherCN.has(entry.cn), `中文名撞车：${entry.cn}`).toBe(false);
      expect(otherSlugs.has(entry.slug), `slug 撞车：${entry.slug}`).toBe(false);
      for (const query of [`${SourceID}/${entry.slug}`, entry.slug, entry.cn, entry.en]) {
        expect(filmstyle.styleKey(filmstyle.lookup(query)), query).toBe(`${SourceID}/${entry.slug}`);
      }
    }
  });
});

describe('papercraft-styles install, runtimeAssets mounting, determinism & engine contract', () => {
  function setupProjectWithStyle(slug: 'popup-2d' | 'popup-3d') {
    const project = tempDir();
    fs.writeFileSync(path.join(project, 'onset.conf'), '');
    fs.writeFileSync(
      path.join(project, 'frame.md'),
      '---\ncanvas:\n  width_px: 1920\n  height_px: 1080\n  fps: 30\n---\n',
    );
    const entry = find(slug)!;
    const res = filmstyle.install({
      projectDir: project,
      style: entryStyle(entry),
      now: new Date('2026-11-28T00:00:00Z'),
    });
    const sceneDir = path.join(project, 'scenes', 'scene-001');
    fs.mkdirSync(sceneDir, { recursive: true });
    fs.writeFileSync(path.join(sceneDir, 'voice.srt'), '1\n00:00:00,000 --> 00:00:02,000\n你好折纸世界\n');
    fs.writeFileSync(
      path.join(sceneDir, 'scene.json'),
      JSON.stringify({
        id: 'scene-001',
        duration_seconds: 2,
        output: 'out.mp4',
        transcript: 'voice.srt',
        text: '你好折纸世界',
      }),
    );
    const s = loadScene(sceneDir);
    const resolved = resolveAllSkills('claude', sceneDir, {}, s);
    const mounted = prepareResources(s, resolved);
    return { project, sceneDir, res, mounted };
  }

  it('installs popup-2d offline without Three.js and passes determinism + engine contract checks', () => {
    const { project, sceneDir, res, mounted } = setupProjectWithStyle('popup-2d');
    expect(res.unchanged).toBe(false);
    expect(res.manifest).toMatchObject({ source: SourceID, slug: 'popup-2d', version: PinnedVersion });

    const styleDir = filmstyle.skillDir(project);
    expect(fs.readFileSync(path.join(styleDir, 'ATTRIBUTION.md'), 'utf8')).toContain(PinnedCommit);
    expect(fs.readFileSync(path.join(styleDir, 'LICENSE'), 'utf8')).toContain('MIT License');
    expect(fs.existsSync(path.join(styleDir, 'papercraft', 'vendor'))).toBe(false);
    expect(fs.existsSync(path.join(sceneDir, 'papercraft', 'paperkit-2d.js'))).toBe(true);
    expect(fs.existsSync(path.join(sceneDir, 'papercraft', 'onset-papercraft-2d.js'))).toBe(true);
    expect(mounted['asset:papercraft/paperkit-2d.js']).toMatch(/^[a-f0-9]{64}$/);

    // 用随插件下发的 2D 模板作为入口，验证确定性扫描与引擎契约全部通过。
    const html = fs
      .readFileSync(path.join(sceneDir, 'papercraft', 'template-2d.html'), 'utf8')
      .replaceAll('__W__', '1920')
      .replaceAll('__H__', '1080')
      .replaceAll('__DUR__', '2');
    fs.writeFileSync(path.join(sceneDir, 'index.html'), html);

    const scan = determinism.scan(sceneDir);
    expect(scan.ok, JSON.stringify(scan.findings)).toBe(true);
    expect(scan.findings).toEqual([]);
    expect(scan.files).toContain('papercraft/onset-papercraft-2d.js');
    expect(scan.files).toContain('papercraft/paperkit-2d.js');
    expect(scan.files).toContain('papercraft/paper-motion.js');

    const contract = determinism.checkEngineContract(sceneDir, { files: scan.files });
    expect(contract.ok).toBe(true);
    expect(contract.errors).toEqual([]);
    expect(contract.warnings).toEqual([]);

    // 幂等性校验
    const second = filmstyle.install({ projectDir: project, style: entryStyle(find('popup-2d')!) });
    expect(second.unchanged).toBe(true);
  });

  it('installs popup-3d with offline three@0.187.0 and passes determinism + threejs hard contract', () => {
    const { project, sceneDir, res, mounted } = setupProjectWithStyle('popup-3d');
    expect(res.manifest).toMatchObject({ source: SourceID, slug: 'popup-3d', version: PinnedVersion });

    const styleDir = filmstyle.skillDir(project);
    const styleJSON = JSON.parse(fs.readFileSync(path.join(styleDir, 'style.json'), 'utf8')) as Record<string, unknown>;
    expect(styleJSON.license).toBe(LicenseName);
    expect(styleJSON.upstream).toBe(UpstreamRepo);
    expect(styleJSON.three_version).toBe(ThreeVersion);
    expect(fs.existsSync(path.join(sceneDir, 'papercraft', 'vendor', 'three', 'three.module.js'))).toBe(true);
    expect(fs.existsSync(path.join(sceneDir, 'papercraft', 'vendor', 'three', 'LICENSE'))).toBe(true);
    expect(mounted['asset:papercraft/vendor/three/three.module.js']).toMatch(/^[a-f0-9]{64}$/);

    // 用随插件下发的 3D 模板作为入口，验证确定性扫描（含 paperkit-3d / paper-life / onset-papercraft-3d）与 threejs 强契约均通过。
    const html = fs
      .readFileSync(path.join(sceneDir, 'papercraft', 'template-3d.html'), 'utf8')
      .replaceAll('__W__', '1920')
      .replaceAll('__H__', '1080')
      .replaceAll('__DUR__', '2');
    fs.writeFileSync(path.join(sceneDir, 'index.html'), html);
    expect(html).not.toMatch(/https?:\/\//);

    const scan = determinism.scan(sceneDir);
    expect(scan.ok, JSON.stringify(scan.findings)).toBe(true);
    expect(scan.findings).toEqual([]);
    expect(scan.files).toContain('papercraft/onset-papercraft-3d.js');
    expect(scan.files).toContain('papercraft/paperkit-3d.js');
    expect(scan.files).toContain('papercraft/paperkit-2d.js');
    expect(scan.files).toContain('papercraft/paper-motion.js');
    expect(scan.files).toContain('papercraft/paper-life.js');
    expect(scan.skipped ?? []).toContain('papercraft/vendor/three/three.module.js');

    const contract = determinism.checkEngineContract(sceneDir, { files: scan.files });
    expect(contract.ok, JSON.stringify(contract.errors)).toBe(true);
    expect(contract.errors).toEqual([]);
    expect(contract.style_key).toBe('papercraft/popup-3d');
  });
});
