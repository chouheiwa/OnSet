/**
 * Papercraft 折纸立体书（MIT）的 filmstyle.Source 实现。
 *
 * 全部运行库、离线 three@0.187.0 与海报随片场内置资产下发（assets/plugins/papercraft-styles/），
 * check() 仅校验本机内置资源完整、不联网；通过 runtimeAssets: ['papercraft'] 自动经项目内容池共享到镜头目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { GuideFile, type Source, type Style, StyleFile } from '../../filmstyle';
import {
  catalog,
  entryStyle,
  find,
  PinnedVersion,
  pluginAssetsDir,
  posterAssetPath,
  runtimeFilesFor,
  SourceID,
  SourceName,
} from './papercraft';
import { renderAttributionMD, renderSkillMD, renderStyleJSON, renderStyleMD } from './render';

function copyRegularFile(from: string, to: string): void {
  const stat = fs.lstatSync(from);
  if (stat.isSymbolicLink()) throw new Error(`papercraft 内置资源不能是符号链接：${from}`);
  if (!stat.isFile()) throw new Error(`papercraft 内置资源不是普通文件：${from}`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, fs.readFileSync(from), { mode: 0o644 });
}

export const papercraftSource: Source = {
  runtimeAssets: ['papercraft'],
  id: () => SourceID,
  name: () => SourceName,
  gallery: () => '',
  catalog: () => catalog().map(entryStyle),
  location: () => pluginAssetsDir(),
  check: () => {
    const base = pluginAssetsDir();
    const required = new Set<string>(['LICENSE']);
    for (const entry of catalog()) {
      for (const rel of runtimeFilesFor(entry.mode)) required.add(rel);
    }
    for (const rel of required) {
      const file = path.join(base, rel);
      if (!fs.existsSync(file)) throw new Error(`Papercraft 内置风格资产缺失：${file}`);
    }
  },
  prepare: async () => {
    // 全部 2D / 3D 资产内置随包下发，零 CDN，无需联网准备。
  },
  poster(_env, slug) {
    const file = posterAssetPath(slug);
    if (!fs.existsSync(file)) {
      throw Object.assign(new Error(`风格 ${slug} 缺少海报：${file}`), { code: 'ENOENT' });
    }
    return file;
  },
  fill(dir: string, style: Style): string {
    const entry = find(style.slug);
    if (!entry) throw new Error(`Papercraft 风格库里没有 ${style.slug}`);
    const base = pluginAssetsDir();
    for (const rel of runtimeFilesFor(entry.mode)) {
      const from = path.join(base, rel);
      if (!fs.existsSync(from)) throw new Error(`Papercraft 风格库缺少运行资源：${rel}`);
      copyRegularFile(from, path.join(dir, rel));
    }
    copyRegularFile(path.join(base, 'LICENSE'), path.join(dir, 'LICENSE'));
    const poster = posterAssetPath(entry.slug);
    if (fs.existsSync(poster)) copyRegularFile(poster, path.join(dir, 'poster.jpg'));
    fs.writeFileSync(path.join(dir, StyleFile), renderStyleMD(entry), 'utf8');
    fs.writeFileSync(path.join(dir, GuideFile), renderSkillMD(entry), 'utf8');
    fs.writeFileSync(path.join(dir, 'style.json'), renderStyleJSON(entry), 'utf8');
    fs.writeFileSync(path.join(dir, 'ATTRIBUTION.md'), renderAttributionMD(entry), 'utf8');
    return PinnedVersion;
  },
};
