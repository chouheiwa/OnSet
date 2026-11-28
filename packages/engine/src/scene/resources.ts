/** 只消费技能与风格来源的声明，不依赖任何具体风格插件。 */
import fs from 'node:fs';
import path from 'node:path';
import * as filmstyle from '../filmstyle';
import { compareBytes } from '../gojson';
import * as renderassets from '../renderassets';
import { missingComponents, sceneComponentPlan } from './component-plan';
import { componentMounts } from './components';
import { contained, findProjectRoot, type Scene } from './scene';
import { allSkills, FilmStyleOwnKey } from './skills';
import { VerificationError } from './verification';

export function resourceFiles(s: Scene, resolved: Record<string, string>): renderassets.Resource[] {
  const root = findProjectRoot(s.directory);
  if (!root || path.resolve(root) === path.resolve(s.directory)) return [];
  const mounts: renderassets.Mount[] = [
    { from: path.join(root, 'assets/fonts'), to: 'assets/fonts' },
    { from: path.join(root, 'assets/vendor'), to: 'vendor' },
    ...componentMounts(root, sceneComponentPlan(s, root).names),
  ];
  for (const skill of allSkills()) {
    const dir = resolved[skill.name];
    if (!dir) continue;
    for (const rel of skill.runtimeAssets ?? []) mounts.push({ from: path.join(dir, skill.name, rel), to: rel });
  }
  const style =
    s.film_style === ''
      ? resolved[filmstyle.SkillName]
        ? path.join(resolved[filmstyle.SkillName]!, filmstyle.SkillName)
        : ''
      : s.film_style === filmstyle.NoFilmStyle
        ? ''
        : (resolved[FilmStyleOwnKey] ?? '');
  if (style) {
    const manifest = filmstyle.readManifest(path.join(style, filmstyle.ManifestFile));
    const source = manifest ? filmstyle.sourceByID(manifest.source) : undefined;
    for (const rel of source?.runtimeAssets ?? []) mounts.push({ from: path.join(style, rel), to: rel });
  }
  return renderassets.collect(mounts);
}

/** 自动按已挂载字体生成的 @font-face 样式表（font-display: block），省去每镜手写与出错返工。 */
export const FontsCSSFile = 'onset-fonts.css';

const fontExtRe = /^assets\/fonts\/([^\r\n/`]+)\.(woff2|woff|ttf|otf)$/i;

function fontFormat(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'woff2':
      return 'woff2';
    case 'woff':
      return 'woff';
    case 'otf':
      return 'opentype';
    default:
      return 'truetype';
  }
}

const namedFontWeights: ReadonlyArray<[RegExp, string]> = [
  [/(?:^|[-_])(?:thin|hairline)(?:$|[-_])/i, '100'],
  [/(?:^|[-_])(?:extralight|ultralight)(?:$|[-_])/i, '200'],
  [/(?:^|[-_])light(?:$|[-_])/i, '300'],
  [/(?:^|[-_])(?:regular|normal|book)(?:$|[-_])/i, '400'],
  [/(?:^|[-_])medium(?:$|[-_])/i, '500'],
  [/(?:^|[-_])(?:semibold|demibold)(?:$|[-_])/i, '600'],
  [/(?:^|[-_])bold(?:$|[-_])/i, '700'],
  [/(?:^|[-_])(?:extrabold|ultrabold|heavy)(?:$|[-_])/i, '800'],
  [/(?:^|[-_])black(?:$|[-_])/i, '900'],
];

const fontsCSSHeader = '/* 由 onset 按挂载字体自动生成，勿手改。 */';

function parseFontFace(rel: string): { family: string; weight: string; style: string; format: string } | null {
  const m = fontExtRe.exec(rel);
  if (!m) return null;
  const stem = m[1]!;
  const format = fontFormat(m[2]!);
  const weightMatch = /(?:^|[-_])([1-9]00)(?:$|[-_])/.exec(stem);
  const italic = /(?:^|[-_])italic(?:$|[-_])/i.test(stem);
  const namedWeight = namedFontWeights.find(([re]) => re.test(stem))?.[1];
  const weight = weightMatch ? weightMatch[1]! : (namedWeight ?? '400');
  const rawFamily = stem
    .replace(
      /[-_](?:[1-9]00|regular|normal|book|bold|medium|semibold|demibold|extralight|ultralight|light|black|thin|hairline|extrabold|ultrabold|heavy|italic)(?=$|[-_])/gi,
      '',
    )
    .replace(/[-_]+/g, ' ')
    .trim();
  const family = (rawFamily || stem)
    .split(/\s+/)
    .map((word) => (word.length <= 2 ? word.toUpperCase() : word[0]!.toUpperCase() + word.slice(1)))
    .join(' ');
  return { family, weight, style: italic ? 'italic' : 'normal', format };
}

/** 为镜头内已挂载的 assets/fonts/* 生成确定性 onset-fonts.css；没有挂载字体时不写。 */
export function writeFontsCSS(sceneDir: string, paths: readonly string[]): boolean {
  const fonts = [...new Set(paths)].filter((p) => fontExtRe.test(p)).sort(compareBytes);
  if (fonts.length === 0) return false;
  const blocks: string[] = [fontsCSSHeader];
  for (const rel of fonts) {
    const face = parseFontFace(rel);
    if (!face) continue;
    blocks.push(
      `@font-face {\n` +
        `  font-family: '${face.family}';\n` +
        `  src: url('${rel}') format('${face.format}');\n` +
        `  font-weight: ${face.weight};\n` +
        `  font-style: ${face.style};\n` +
        `  font-display: block;\n` +
        `}`,
    );
  }
  if (blocks.length <= 1) return false;
  const body = blocks.join('\n\n') + '\n';
  const rawTarget = path.join(sceneDir, FontsCSSFile);
  let stat: fs.Stats | null = null;
  try {
    stat = fs.lstatSync(rawTarget);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (stat !== null) {
    if (stat.isSymbolicLink()) throw new Error(`${FontsCSSFile} 不能是符号链接`);
    if (!stat.isFile()) throw new Error(`${FontsCSSFile} 不是普通文件`);
  }
  const target = contained(sceneDir, FontsCSSFile, FontsCSSFile);
  if (stat !== null) {
    const existing = fs.readFileSync(target, 'utf8');
    if (existing === body) return true;
    if (!existing.startsWith(fontsCSSHeader)) {
      throw new Error(`镜头目录已有手写的 ${FontsCSSFile}，拒绝覆盖；如需由片场自动生成，请移出或改名`);
    }
  }
  fs.writeFileSync(target, body, 'utf8');
  return true;
}

/** 返回本次实际挂载的字节指纹；启动前与输入指纹对照，防止准备期间来源被改写。 */
export function prepareResources(s: Scene, resolved: Record<string, string>): Record<string, string> {
  const pending = missingComponents(s).filter((component) => component.source_scene !== '');
  if (pending.length) {
    throw new VerificationError(
      s.directory,
      pending.map(
        ({ name, source_scene }) =>
          `共用组件 ${name} 还没有登记${source_scene ? `，先验收产出镜头 ${source_scene}` : ''}，再调用 shared_component_promote()。`,
      ),
    );
  }
  const files = resourceFiles(s, resolved);
  if (files.length > 0) renderassets.prepare(findProjectRoot(s.directory), s.directory, files);
  renderassets.verify(s.directory);
  writeFontsCSS(s.directory, [...files.map((file) => file.path), ...renderassets.paths(s.directory)]);
  return renderassets.inputs(s.directory, []);
}

/** 汇总已挂载字体生成到 onset-fonts.css 的字体族与字重，避免每镜再 read_file("onset-fonts.css")。 */
export function describeMountedFonts(paths: readonly string[]): string {
  const fonts = [...new Set(paths)].filter((p) => fontExtRe.test(p)).sort(compareBytes);
  const byFamily = new Map<string, Set<string>>();
  for (const rel of fonts) {
    const face = parseFontFace(rel);
    if (!face) continue;
    let weights = byFamily.get(face.family);
    if (!weights) {
      weights = new Set<string>();
      byFamily.set(face.family, weights);
    }
    weights.add(face.style === 'italic' ? `${face.weight} italic` : face.weight);
  }
  return [...byFamily.entries()]
    .sort(([a], [b]) => compareBytes(a, b))
    .map(([family, weights]) => `'${family}' (${[...weights].sort(compareBytes).join(', ')})`)
    .join('、');
}

const helperJsRe = /^(?:[^/\r\n`]+\/)*[^/\r\n`]+\.m?js$/i;
const skipHelperJsRe = /(?:^|\/)(?:scene-kit\.js|onset-scene\.js|scene\.js|[^/]+\.min\.m?js)$/i;
const maxHelperScanBytes = 128 * 1024;
const maxExportsPerFile = 20;
const maxDescribedHelpers = 8;

/** 轻量级静态提取 JS/ESM 辅助库的公开导出符号（不依赖 AST 解析器），帮助渲染器直接调用而不整份通读库源码。 */
export function extractJsExportSummary(filePath: string): string[] {
  let text = '';
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0 || stat.size > maxHelperScanBytes) return [];
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const byName = new Map<string, string>();
  const add = (name: string, sig: string) => {
    const prev = byName.get(name);
    if (!prev || (!prev.includes('(') && sig.includes('('))) byName.set(name, sig);
  };
  const cleanArgs = (raw: string) => raw.replace(/\s+/g, ' ').trim();

  for (const m of text.matchAll(
    /\bexport\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)\r\n]{0,80})\)/g,
  )) {
    add(m[1]!, `${m[1]!}(${cleanArgs(m[2]!)})`);
  }
  for (const m of text.matchAll(
    /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)\r\n]{0,80})\)\s*=>/g,
  )) {
    add(m[1]!, `${m[1]!}(${cleanArgs(m[2]!)})`);
  }
  for (const m of text.matchAll(/\bexport\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)\b/g)) {
    add(m[1]!, m[1]!);
  }
  for (const m of text.matchAll(/\bexport\s*\{([^}]{1,400})\}/g)) {
    for (const part of m[1]!.split(',')) {
      const cleaned = part
        .trim()
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .trim();
      if (!cleaned) continue;
      const asMatch = /^(?:[A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(cleaned);
      const ident = asMatch ? asMatch[1]! : /^[A-Za-z_$][\w$]*$/.test(cleaned) ? cleaned : '';
      if (ident && ident !== 'default') add(ident, ident);
    }
  }
  for (const m of text.matchAll(/(?:window|globalThis|global)\.([A-Za-z_$][\w$]*)\s*=/g)) {
    const ident = m[1]!;
    if (!ident.startsWith('__')) add(`window.${ident}`, `window.${ident}`);
  }
  const items = [...byName.values()];
  if (items.length <= maxExportsPerFile) return items;
  return [...items.slice(0, maxExportsPerFile), `…共 ${items.length} 项`];
}

/** 汇总镜头目录中已挂载的非压缩辅助 JS 库的公开导出接口。 */
export function describeMountedLibraries(
  sceneDir: string,
  paths: readonly string[],
  files: readonly renderassets.Resource[] = [],
): string[] {
  const sourceByPath = new Map(files.map((file) => [file.path, file.from]));
  const candidates = [...new Set(paths)]
    .filter((rel) => helperJsRe.test(rel) && !skipHelperJsRe.test(rel))
    .sort(compareBytes)
    .slice(0, maxDescribedHelpers);
  const out: string[] = [];
  for (const rel of candidates) {
    let target = sourceByPath.get(rel) ?? '';
    if (!target) {
      try {
        target = contained(sceneDir, rel, rel);
      } catch {
        continue;
      }
    }
    const exports = extractJsExportSummary(target);
    if (exports.length > 0) out.push(`\`${rel}\`：${exports.join('、')}`);
  }
  return out;
}

/** 未启用共享资源的旧镜头逐字不变，不因升级被判 Stale；run 准备后才注入。 */
export function resourceSection(
  s: Scene,
  resolved: Record<string, string>,
  directorBrief = false,
  v6 = false,
  v8 = false,
): string {
  if (!fs.existsSync(path.join(s.directory, renderassets.ManifestFile))) return '';
  const files = resourceFiles(s, resolved);
  const paths = [...files.map((file) => file.path), ...renderassets.paths(s.directory)];
  const locations = [
    ...new Set(
      paths.map((rel) => {
        const parts = rel.split('/');
        return parts.length === 1
          ? rel
          : parts.slice(0, parts[0] === 'assets' || parts[0] === 'node_modules' ? 2 : 1).join('/') + '/';
      }),
    ),
  ].sort(compareBytes);
  const readyFiles = directorBrief
    ? [...new Set(paths)]
        .filter(
          (rel) =>
            /^assets\/fonts\/[^\r\n`]+\.(?:woff2?|ttf|otf)$/i.test(rel) ||
            /^vendor\/[^\r\n`]+\.(?:m?js|css)$/i.test(rel) ||
            /^(?:[^/\r\n`]+\/)*[^/\r\n`]+\.(?:m?js|css)$/i.test(rel),
        )
        .sort(compareBytes)
        .slice(0, 12)
    : [];
  const hasFontsCSS = v6 && fs.existsSync(path.join(s.directory, FontsCSSFile));
  const fontFamilies = v8 && hasFontsCSS ? describeMountedFonts(paths) : '';
  const librarySummaries = v8 ? describeMountedLibraries(s.directory, paths, files) : [];
  const fontsLine = hasFontsCSS
    ? v8 && fontFamilies
      ? `- 已自动生成 \`${FontsCSSFile}\`（含 \`font-display: block\` 的 \`@font-face\`；已声明字体族：${fontFamilies}），HTML 中直接 \`<link rel="stylesheet" href="${FontsCSSFile}">\` 并按上述 \`font-family\` 引用即可，不必再 \`read_file\` \`${FontsCSSFile}\` 或手写 \`@font-face\`。\n`
      : `- 已自动生成 \`${FontsCSSFile}\`（含 \`font-display: block\` 的 \`@font-face\`），HTML 中直接 \`<link rel="stylesheet" href="${FontsCSSFile}">\` 即可，不必重复手写 \`@font-face\`。\n`
    : '';
  const libsBlock =
    librarySummaries.length > 0
      ? '- 已挂载辅助库公开接口速查（直接 import/调用，无需先整份 read_file；仅对具体参数有疑问时按需看对应几行）：\n' +
        librarySummaries.map((line) => `  - ${line}\n`).join('')
      : '';
  return (
    '\n共享渲染资源（强制，优先于技能里的复制说明）：\n' +
    '- 引擎已在本镜头准备这些相对路径：' +
    locations.join('、') +
    '。文件清单见 ' +
    renderassets.ManifestFile +
    '。\n' +
    (readyFiles.length
      ? '- 已挂载的字体和库可直接引用：' + readyFiles.map((file) => '`' + file + '`').join('、') + '。\n'
      : '') +
    fontsLine +
    libsBlock +
    '- 这些文件通过相对链接共用项目内的固定内容（不支持链接时是副本），不要再次复制、下载或改写，也不要删除链接。HTML、CSS 与 import 仍引用上面的镜头内路径，不引用链接目标。\n' +
    '- 要改某个库时，另存为本镜头自己的新文件并改引用；模板可以读出来另写 index.html。镜头自己的 scene.js、onset-scene.js 与合成代码不共享。\n'
  );
}
