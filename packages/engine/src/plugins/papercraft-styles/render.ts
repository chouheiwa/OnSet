/**
 * 将 Papercraft 风格条目渲染为整片风格契约文件：STYLE.md、SKILL.md、style.json 与 ATTRIBUTION.md。
 */
import { marshalIndent } from '../../gojson';
import {
  LicenseName,
  type PapercraftStyleEntry,
  PinnedCommit,
  PinnedVersion,
  SourceID,
  SourceName,
  ThreeVersion,
  UpstreamRepo,
  UpstreamVersion,
} from './papercraft';

function engineLabel(engine: string): string {
  switch (engine) {
    case 'threejs':
      return `Three.js 真 3D（必须引入离线 three@${ThreeVersion} 与 paperkit-3d.js，严禁 CSS 3D 伪装或 CDN 远程引入）`;
    case 'canvas2d':
      return 'Canvas2D 逐帧绘制（使用 paperkit-2d.js 与 onset-papercraft-2d.js，避免退化为静态 DOM 卡片）';
    default:
      return engine;
  }
}

/** 渲染 STYLE.md（整片风格不变量：纸艺物理模型、结构法则、色板、效果配方、横竖屏与禁忌）。 */
export function renderStyleMD(entry: PapercraftStyleEntry): string {
  const engines = entry.engine_contract.required.map(engineLabel).join('；');
  const severity = entry.engine_contract.severity === 'error' ? '阻断级强契约（error）' : '建议级提醒（warn）';
  const lines = [
    `# ${entry.cn}（${entry.en}）`,
    '',
    `> 来源：${SourceName}（\`${SourceID}/${entry.slug}\`，源自 MIT 项目 \`${UpstreamRepo}@v${UpstreamVersion}\`）`,
    '',
    entry.summary,
    '',
    '## 1. 渲染引擎契约',
    `- **要求引擎**：${engines}`,
    `- **门禁级别**：${severity}`,
    ...(entry.engine_contract.note ? [`- **执行说明**：${entry.engine_contract.note}`] : []),
    '- **显式偏离豁免**：若单镜确有充分创意理由需要降级，须在入口顶部 50 行写注释 `// onset-engine-deviation: <engine> -> <replacement> | reason: <理由>`。',
    '',
    '## 2. 纸艺材质与结构法则（不变量）',
    '1. **薄卡纸与折痕**：一切形体来自裁剪、折叠、叠层与插槽，不捏体积感塑料球；卡纸厚度约主体高 1.5%–3%。',
    '2. **绝对哑光**：仅漫反射（wrap ≈ 0.3），零高光、零镜面、零塑料光泽。',
    '3. **低位侧主光 + 彩色软影**：主光偏镜头轴 45°–65°、仰角 45°–55°（黄昏 20°–35°），辅以正面补光；阴影必须取自当前世界的阴影色（见 `papercraft/lights.json` 的 `leak`），严禁灰黑死阴影；所有站立纸片必有底部接触暗影。',
    '4. **分层叠印卡面**：每张立牌不是平涂，而是 3–5 阶明度色块逐层叠加（`P.layer` / `P.parts` / `P.marks`），每层带短暖影 + 受光侧细白边。',
    '5. **剪裁边与折痕边区分**：剪裁轮廓用 1.5–2.5px 深棕边加受光侧内高光；底部折痕处不画剪裁边，严禁四周均匀白边（贴纸光环）。',
    '6. **微距俯拍铺满四边**：底纸必须铺满画幅四边，不露天空、地平线、书边或桌面；中景保持清晰带，上下自然虚化。',
    '7. **只绕折痕起落**：所有纸片用 `FlapSpring` 绕折痕旋转弹起（8%–15% 过冲，~1s 稳住），错峰 0.05–0.1s；不用缩放弹出或整卡淡入。',
    '8. **严禁照搬示例题材**：色板、底纸、地标与物件必须完全按本镜头文案与主题派生，不得套用上游乡村示例。',
    '',
    '## 3. 推荐动效组合（`motion_effects`）',
    `- 推荐标识：${entry.motion_effects.map((id) => `\`${id}\``).join('、')}`,
    '- 分镜阶段可直接填入该镜头的 `motion_effects`（每镜最多 3 条）。',
    '',
    '## 4. 起始参考色板（优先遵守全片配色）',
    '| 角色 | 色值 | 用途 |',
    '|---|---|---|',
    `| 底纸 Ground | \`${entry.palette.bg}\` | 印刷底纸基调（较立牌略浅略低饱和） |`,
    `| 纸张 Stock | \`${entry.palette.surface}\` | 纤维卡纸正片叠底与亮部高光 |`,
    `| 主色 Primary | \`${entry.palette.primary}\` | 核心纸卡主体色系 |`,
    `| 辅色 Secondary | \`${entry.palette.secondary}\` | 层次对比、水体或建筑副色 |`,
    `| 强调 Accent | \`${entry.palette.accent}\` | 暖窗、标注点睛与高对比装饰 |`,
    `| 墨线 Ink | \`${entry.palette.ink}\` | 剪裁深棕轮廓与深色印刷细纹 |`,
    '',
    '## 5. 视觉规格与效果配方',
    `- **排版气质**：${entry.typography}`,
    `- **构图原则**：${entry.composition}`,
    `- **质感材质**：${entry.texture}`,
    `- **动效语法**：${entry.motion_grammar}`,
    `- **转场 Transition**：${entry.recipes.transition}`,
    `- **冲击 Impact**：${entry.recipes.impact}`,
    `- **相机 Camera**：${entry.recipes.camera}`,
    `- **颗粒 Grain**：${entry.recipes.grain}`,
    `- **二次运动 Secondary**：${entry.recipes.secondary}`,
    '',
    '## 6. 风格禁忌',
    ...entry.taboos.map((item) => `- ${item}`),
    '',
  ];
  return lines.join('\n');
}

/** 渲染 SKILL.md（HyperFrames 离线接线指南、API 速查表、横竖屏与静音约定）。 */
export function renderSkillMD(entry: PapercraftStyleEntry): string {
  const is3D = entry.mode === '3d';
  const adapter = is3D ? 'onset-papercraft-3d.js' : 'onset-papercraft-2d.js';
  const template = is3D ? 'template-3d.html' : 'template-2d.html';
  const filesTable = is3D
    ? [
        '| `papercraft/onset-papercraft-3d.js` | 3D 确定性 HyperFrames 接头（`createWorld3D` / `play` / `MOODS` / `loadLights`） |',
        '| `papercraft/paperkit-3d.js` | 3D 纸卡与立体折构（`makeCard`、`crossCard`、`boxFold`、`prismFold`、`layeredCard`、`fanCard`、`extrudedLayerStack`、`platform`、`PaperPost`） |',
        '| `papercraft/paperkit-2d.js` | 2D 程序化纸纹、剪影与叠层印刷（`rng`、`paperSheet`、`shape`、`roughen`、`printCard`、`fromDrawing`、`drawnPiece`） |',
        '| `papercraft/paper-motion.js` | 确定性折痕弹簧与轨道相机（`FlapSpring`、`Spring`、`windSway`、`glideSchedule`、`polarCameraPos`、`checkContinuity`） |',
        '| `papercraft/paper-life.js` | 3D 纸艺微生态（`createLife`：飘叶、飞鸟、雪花、炊烟、萤火虫） |',
        '| `papercraft/lights.json` | 10 套光照与阴影色预设（`day`/`golden-hour`/`dusk`/`night`/`snow-bright`/`mist`/`aquatic` 等） |',
        `| \`papercraft/vendor/three/three.module.js\` | 离线 \`three@${ThreeVersion}\` ESM 单文件包（零 CDN） |`,
        `| \`papercraft/${template}\` | 含相对路径 \`importmap\` 与 \`hf-seek\` 接线的 3D 合成起步模板 |`,
      ]
    : [
        '| `papercraft/onset-papercraft-2d.js` | 2D 确定性 HyperFrames 接头（`createWorld2D` / `play` / `loadLights`，已强制 CPU 软件光栅） |',
        '| `papercraft/paperkit-2d.js` | 2D 程序化纸纹、剪影、叠层印刷与 2D 桥面（`rng`、`paperSheet`、`shape`、`roughen`、`printCard`、`fromDrawing`、`drawDeck2D`、`deckShadow2D`） |',
        '| `papercraft/paper-motion.js` | 确定性折痕弹簧与微风（`FlapSpring`、`Spring`、`windSway`、`smootherstep`、`WalkField`） |',
        '| `papercraft/lights.json` | 10 套光照与阴影色预设（取 `lights[mood].leak` 作为彩色阴影色） |',
        `| \`papercraft/${template}\` | 含相对路径 \`importmap\` 与 \`hf-seek\` 接线的 2D 合成起步模板 |`,
      ];

  const apiBlock = is3D
    ? [
        '## 离线 3D 快速接线与 API 速查',
        '1. **相对路径 `importmap`（强制，严禁用 `/` 根路径或 CDN）**：',
        '```html',
        '<script type="importmap">',
        '{ "imports": { "three": "./papercraft/vendor/three/three.module.js", "papercraft/": "./papercraft/" } }',
        '</script>',
        '```',
        '2. **主模块顶部显式引入 `THREE` 并用 `play()` 接入 `hf-seek`**：',
        '```js',
        "import * as THREE from 'three';",
        "import * as P2 from 'papercraft/paperkit-2d.js';",
        "import { boxFold, prismFold, layeredCard } from 'papercraft/paperkit-3d.js';",
        "import { glideSchedule, polarCameraPos } from 'papercraft/paper-motion.js';",
        "import { createWorld3D, play } from 'papercraft/onset-papercraft-3d.js';",
        '```',
        '- `createWorld3D({ canvas, ground, mood, view, light, lens, autoOpen, prewarmSeconds })`：自动读 `window.ONSET_SCENE` 画幅（16:9 / 9:16 自适应）并启用 `preserveDrawingBuffer: true`。',
        '- `world.printGround(({ g, X, Z, rnd, washes, torn, band, ribbon, line, drifts }) => ...)`：印刷底纸并自动叠加纸纤维与法线贴图。',
        '- `world.popup(pts, paint, { x, z, cross, yaw, sway, scale, node, order, open })`：创建折痕立牌；`cross: "full" | "half" | "quarter"` 造插槽立体件；`node` 可挂 `boxFold({ w, d, wallH, roofH, paper, paints: { front, gable, roof } })` 或 `prismFold(footprint, { h, roof: "pyramid" | "flat", roofH, paper, paints: { wall, roof } })`。',
        '- `world.stack(x, z, layers)` / `world.dome(x, z, opts)` / `world.lamp(x, y, z, k)` / `world.glowing(group)` / `world.mixMood(a, b, k)`。',
        '- `world.cue(t, fn)` / `world.fold(handle, open, delay)` / `world.setOpen(open)` / `world.setCameraController((t, dt, ctx) => ...)` / `world.attachLife({ seed, ... })`（返回对象支持 `fallers` / `motes` / `flyers` / `flock` / `puffs` / `cloudShadows`）。',
      ]
    : [
        '## 离线 2D 快速接线与 API 速查',
        '1. **相对路径 `importmap`（强制，严禁用 `/` 根路径或 CDN）**：',
        '```html',
        '<script type="importmap">',
        '{ "imports": { "papercraft/": "./papercraft/" } }',
        '</script>',
        '```',
        '2. **用 `createWorld2D` + `play()` 接入 `hf-seek`**：',
        '```js',
        "import * as P2 from 'papercraft/paperkit-2d.js';",
        "import { createWorld2D, play } from 'papercraft/onset-papercraft-2d.js';",
        '```',
        '- `createWorld2D({ canvas, ground, shadow, kraft, view, light, subject, autoOpen, prewarmSeconds })`：自动读 `window.ONSET_SCENE` 画幅并强制 CPU 光栅（`willReadFrequently: true`），9:16 竖屏自动拉近并抬高清晰带避让底部字幕。',
        '- `world.printGround(({ x, X, Z, GQ, rnd, washes, ribbon, line, drifts }) => ...)`：印刷底纸并自动叠加纸纹。',
        '- `world.piece(pts, paint, { x, z, y, yaw, sway, slotted, sharp, holes, float, bob, reflect, open })`：印刷纸卡并挂接 `FlapSpring` 折痕弹簧。',
        '- `world.decks.push({ z, draw, shadow })`：用 `P2.drawDeck2D` / `P2.deckShadow2D` 在景深中插入纸桥、平台或斜坡。',
        '- `world.cue(t, fn)` / `world.fold(piece, open, delay)` / `world.setOpen(open)` / `world.setCamera((t, cam) => { cam.x = ...; cam.zoom = ...; })`。',
        '- `P2` 常用印刷工具：`P2.rng(seed)`、`P2.shape.{mound,rect,arch,gable,...}`、`P2.roughen(pts, r)`、`P2.fromDrawing(draw)`、`P2.draw2`；画笔 `P.{fill,gradient,layer,parts,marks,innerShade,draw,rim}`。',
      ];

  return [
    `# ${entry.cn}（${entry.en}）— HyperFrames 实现指南`,
    '',
    `本风格来自内置「${SourceName}」（\`${SourceID}/${entry.slug}\`，${LicenseName} 许可，源自 \`${UpstreamRepo}@v${UpstreamVersion}\` commit \`${PinnedCommit.slice(0, 12)}\`）。`,
    '',
    '| 文件 | 用途 |',
    '|---|---|',
    '| `STYLE.md` | 纸艺材质法则、色板、构图、动效配方与禁忌 |',
    ...filesTable,
    '| `ATTRIBUTION.md`、`LICENSE` | MIT 开源许可与上游来源署名 |',
    '',
    '## 规则（渲染镜头时）',
    '1. **共享运行库直接引用**：片场在渲染前已通过共享资源池把 `papercraft/` 挂载到本镜头目录，直接按相对路径 `./papercraft/...` 引用，不要重复复制、改写或引用镜头外路径。',
    `2. **从模板起步**：可参考 \`papercraft/${template}\` 写出本镜头的 \`index.html\`，替换 \`__W__\`、\`__H__\`、\`__DUR__\`，并按本镜头 \`prompt.md\` 创作全新场景与道具。`,
    `3. **确定性求值与 \`hf-seek\`**：\`${adapter}\` 的 \`play()\` 已接好 \`hf-seek\` 与 \`window.__hf.buildReady.papercraft\`，每次 seek 都从 \`t = 0\` 固定步长推进。严禁在场景脚本里使用 \`Math.random()\`、\`Date.now()\`、\`performance.now()\` 或 \`requestAnimationFrame\`；全部随机请用 \`P2.rng(seed)\`。`,
    '4. **时间轴与字幕**：若合成里只有 Canvas、无 GSAP 时间轴，根元素必须保留 `data-no-timeline`（否则渲染每镜白等 45 秒）；若叠加 `SceneKit.captions` 或 GSAP 图层，则去掉 `data-no-timeline` 并照 HyperFrames 规范注册 `window.__timelines`。',
    '5. **画幅与第 0 帧**：横屏（16:9）、竖屏（9:16 / 3:4）均按 `window.ONSET_SCENE` 动态构图，不写死 1920×1080；建议传 `prewarmSeconds: 0.4–0.6` 或对主地标设 `open: 1`，避免第 0 帧全平无画面。',
    '6. **严格静音无音轨**：已刻意裁剪上游 `paper-sound.js` 与 `paper-music.js`；禁止在镜头里放 `<audio>` 或 WebAudio，配音、纸张音效与配乐由片场上层音轨统一合成。',
    '',
    ...apiBlock,
    '',
  ].join('\n');
}

/** 渲染 style.json（供引擎契约门禁与工具读取的结构化元数据）。 */
export function renderStyleJSON(entry: PapercraftStyleEntry): string {
  return (
    marshalIndent({
      source: SourceID,
      slug: entry.slug,
      order: entry.order,
      mode: entry.mode,
      cn: entry.cn,
      en: entry.en,
      category_cn: entry.category_cn,
      category_en: entry.category_en,
      uses: entry.uses,
      summary: entry.summary,
      tags: entry.tags,
      license: LicenseName,
      upstream: UpstreamRepo,
      upstream_version: UpstreamVersion,
      commit: PinnedCommit,
      ...(entry.mode === '3d' ? { three_version: ThreeVersion } : {}),
      version: PinnedVersion,
      motion_effects: entry.motion_effects,
      engine_contract: entry.engine_contract,
      palette: entry.palette,
    }) + '\n'
  );
}

/** 渲染 ATTRIBUTION.md（MIT 许可与上游来源署名）。 */
export function renderAttributionMD(entry: PapercraftStyleEntry): string {
  const lines = [
    '# Attribution & License',
    '',
    `- Style: ${entry.cn} / ${entry.en} (\`${SourceID}/${entry.slug}\`)`,
    `- Upstream: \`${UpstreamRepo}\` v${UpstreamVersion} (commit \`${PinnedCommit}\`)`,
    `- License: ${LicenseName} License (Copyright (c) 2026 Shikhar, see \`LICENSE\`)`,
    '- Modifications: removed optional `performance.now()` profiling in `paperkit-2d.js`, excluded `paper-sound.js` and `paper-music.js` (OnSet scenes are silent), and added deterministic HyperFrames seek adapters.',
  ];
  if (entry.mode === '3d') {
    lines.push(
      `- Offline 3D runtime: \`three@${ThreeVersion}\` (MIT License, see \`papercraft/vendor/three/LICENSE\`), bundled as \`papercraft/vendor/three/three.module.js\`.`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
