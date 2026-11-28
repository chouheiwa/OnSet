/**
 * Papercraft 折纸立体书（MIT）的目录数据、路径解析与运行文件清单。
 *
 * 源自 MIT 许可项目 xikhar/papercraft（v0.7.0）与 three@0.187.0，全部运行时库与光照预设
 * 随客户端内置资产下发（assets/plugins/papercraft-styles/），零 CDN、不联网、开箱即用。
 */
import path from 'node:path';
import { assetsBase } from '../../assets';
import type { EngineContract, Style } from '../../filmstyle';
import rawCatalog from './catalog.json';

export const SourceID = 'papercraft';
export const SourceName = 'Papercraft 折纸立体书（MIT）';
export const PluginID = 'papercraft-styles';
export const UpstreamRepo = 'xikhar/papercraft';
export const UpstreamVersion = '0.7.0';
export const PinnedCommit = '30e9aaff8aa244e2237f3ea8921952dcd2e8cda8';
export const ThreeVersion = '0.187.0';
export const LicenseName = 'MIT';
export const PinnedVersion = 'papercraft@0.7.0';
export const PinnedStyleCount = 2;

export type PapercraftMode = '2d' | '3d';

export interface PapercraftPalette {
  bg: string;
  surface: string;
  primary: string;
  secondary: string;
  accent: string;
  ink: string;
}

export interface PapercraftEffectRecipes {
  transition: string;
  impact: string;
  camera: string;
  grain: string;
  secondary: string;
}

export interface PapercraftStyleEntry {
  slug: string;
  order: string;
  mode: PapercraftMode;
  cn: string;
  en: string;
  category_cn: string;
  category_en: string;
  uses: string[];
  summary: string;
  tags: string[];
  engine_contract: EngineContract;
  motion_effects: string[];
  palette: PapercraftPalette;
  typography: string;
  composition: string;
  texture: string;
  motion_grammar: string;
  recipes: PapercraftEffectRecipes;
  taboos: string[];
}

interface CatalogDocument {
  source: string;
  license: string;
  upstream: string;
  version: string;
  commit: string;
  three_version: string;
  styles: PapercraftStyleEntry[];
}

const doc = rawCatalog as CatalogDocument;

/** 2D 风格拷入项目 papercraft/ 的精简运行文件（不带 Three.js 与 3D 库）。 */
export const RuntimeFiles2D: readonly string[] = [
  'papercraft/lights.json',
  'papercraft/paperkit-2d.js',
  'papercraft/paper-motion.js',
  'papercraft/onset-papercraft-2d.js',
  'papercraft/template-2d.html',
];

/** 3D 风格拷入项目 papercraft/ 的完整离线运行文件（含离线 three@0.187.0，绝不含 node_modules）。 */
export const RuntimeFiles3D: readonly string[] = [
  'papercraft/lights.json',
  'papercraft/paperkit-2d.js',
  'papercraft/paper-motion.js',
  'papercraft/paperkit-3d.js',
  'papercraft/paper-life.js',
  'papercraft/onset-papercraft-3d.js',
  'papercraft/template-3d.html',
  'papercraft/vendor/three/three.module.js',
  'papercraft/vendor/three/LICENSE',
];

export function runtimeFilesFor(mode: PapercraftMode): readonly string[] {
  return mode === '3d' ? RuntimeFiles3D : RuntimeFiles2D;
}

/** 内置插件的磁盘资产目录：assets/plugins/papercraft-styles/。 */
export function pluginAssetsDir(): string {
  return path.join(assetsBase(), 'assets', 'plugins', PluginID);
}

export function posterAssetPath(slug: string): string {
  return path.join(pluginAssetsDir(), 'posters', `${slug}.jpg`);
}

export function catalog(): PapercraftStyleEntry[] {
  return doc.styles.map((s) => ({
    ...s,
    uses: [...s.uses],
    tags: [...s.tags],
    motion_effects: [...s.motion_effects],
    engine_contract: { ...s.engine_contract, required: [...s.engine_contract.required] },
    palette: { ...s.palette },
    recipes: { ...s.recipes },
    taboos: [...s.taboos],
  }));
}

export function find(slug: string): PapercraftStyleEntry | undefined {
  return doc.styles.find((s) => s.slug === slug);
}

export function entryStyle(entry: PapercraftStyleEntry): Style {
  return {
    source: SourceID,
    slug: entry.slug,
    order: entry.order,
    cn: entry.cn,
    en: entry.en,
    category_cn: entry.category_cn,
    category_en: entry.category_en,
    uses: [...entry.uses],
    summary: entry.summary,
    tags: entry.tags.length > 0 ? [...entry.tags] : undefined,
    motion_effects: [...entry.motion_effects],
    engine_contract: { ...entry.engine_contract, required: [...entry.engine_contract.required] },
  };
}
