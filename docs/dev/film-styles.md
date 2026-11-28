# 整片风格

> 从仓库根 `AGENTS.md` 拆出的开发约定。总则、命令与各份文件的索引见根 `AGENTS.md`；文中「见「某节」」指的节都能从那份索引找到。

整片风格分两层：`packages/engine/src/filmstyle` 是**与来源无关的通用部分**（`Source` 接口、来源表、风格目录查找、装进项目的契约、目录式风格库 `DirectorySource`），具体风格来源由内置插件在 `apply` 里 `ctx.filmStyleSource(...)` 登记，`filmstyle.sources()` 从插件登记表取（`plugin.pluginFilmStyleSources`）再并上当前项目的第三方来源。目前有五个内置插件：`lemo-styles`（「LemoLab 风格库」，`packages/engine/src/plugins/lemo-styles`：来源 lemo-opuscar，LemoLab，MIT + demo CC BY 4.0）、`anidoodle-styles`（「anidoodle 代码绘画」，`packages/engine/src/plugins/anidoodle-styles`：来源 anidoodle，Alex Greenshpun，Apache-2.0）、`huashu-styles`（「花叔艺术动画」，`packages/engine/src/plugins/huashu-styles`：来源 huashu，花叔，MIT + 字体 OFL）、`mg-styles`（「MG 动效风格库（MIT）」，`packages/engine/src/plugins/mg-styles`：来源 mg-styles，15 套 MIT 风格）与 `papercraft-styles`（「Papercraft 折纸立体书（MIT）」，`packages/engine/src/plugins/papercraft-styles`：来源 papercraft，xikhar/papercraft v0.7.0 + 离线 three@0.187.0，2D Canvas + 3D Three.js 离线开箱即用）。`filmstyle` 与内核（prereqs、config、studio、cli）不 import 它们。几个来源共用的下载零件（分段稀疏检出、锁、屏蔽用户配置的 git 调用）在 `filmstyle/gitlib.ts`，SKILL.md 模板用的 Go text/template 子集在 `filmstyle/template.ts`。onset 本身不锁定视觉；整片风格是可选的第三种技能来源，与 `SourceEmbedded` / `SourceUpstream` 并列但**不进 `registeredSkills`**：那张表要求解析不到时退回按名字引用，而整片风格解析不到的意思是「本片没有整片风格」。`scene.resolveFilmStyle` 只找项目级（不找家目录），只认契约，解析到就并进 `resolveAllSkills` 的结果，指纹与安全模式读取因此自动覆盖；`buildPrompt` 据此把「视觉自由度」段换成 `filmStyleSection`。

| 约定 | 原因 |
|---|---|
| 项目里的契约：`.agents/skills/onset-film-style/` 下必须有 `STYLE.md`（不变量）与 `SKILL.md`（用法、技法参考在哪、来源特有的注意事项），`onset-film-style.json` 记来源、风格、版本与内容摘要；其余文件由来源决定。`filmstyle.install`（`install.ts`）校验契约、负责换位与新旧目录，来源只实现 `fill` | 镜头提示词、制作提示词与客户端只依赖契约，接新来源不用改它们。目录名带 `onset-` 前缀，免得撞上用户自己装的技能 |
| **镜头提示词与制作提示词不点名任何来源**：lemo 的页面契约、demo、`core/fonts`、真实素材类风格的先后顺序都写在 lemo 自己的 `SKILL.md` 模板里；`gen.test.ts` 的「carries the film style without naming a source」拦 `lemo`、`DEMO.md`、`core/fonts` 回流到制作提示词 | 来源特有的话写进通用提示词，下一个来源就得到一份错的说明 |
| 风格标识是「来源/目录名」（`styleKey`）；`filmstyle.lookup` 也认唯一的目录名、中文名、英文名，多个来源重名时要求写全 | 来源之间目录名会撞 |
| 各来源的数据放在 `filmstyle.rootDir`（`~/.local/share/onset/film-styles`，`ONSET_FILM_STYLES_DIR` 覆盖）下以来源 ID 分目录；`childEnvironment` 显式传根目录，来源自己的覆盖变量（lemo 的 `ONSET_LEMO_OPUSCAR_LIBRARY`）由插件经 `ctx.childEnv` 登记、随 `pluginEnv` 传 | 默认目录由 `XDG_DATA_HOME` 推出而它不在白名单，子进程会算出另一个目录 |
| 来源数据是前置资源：只由 `onset setup` 经 `Source.prepare` 下载（每个来源一项 `styles:<来源>`，插件用 `prereqs.filmStyleSourceItem(来源)` 造这一项再 `ctx.prereq` 登记，带 `later` 进安装页「以后可能用到」，每个来源一张卡片（`later.title` 用来源名；安装页按 group 加 title 合卡片，几个来源合成一张的话一个装了、一个没装时看不出缺的是谁）），其余路径用 `Source.check` / `fill` 只读，缺了抛 `prereq.MissingError`。编排工具的可写范围里**没有**来源数据 | 见「技能树」一节前置资源的理由 |
| 新增来源：写一个内置插件（`plugins/<id>/` 加 `assets/plugins/<id>/onset-station.json`、在 `plugins/index.ts` 排队），在 `apply` 里 `ctx.filmStyleSource(来源)`，要下载数据的另登记 `ctx.prereq`、有目录覆盖变量的另登记 `ctx.childEnv`；随插件下发的现成风格目录直接用 `new filmstyle.DirectorySource(...)`。来源 id 不能以 `x-` 开头（那是第三方的）。用到来源表的地方要导入 `plugin` 包（内置插件靠它登记）。`filmstyle/filmstyle.test.ts` 的假来源证明通用部分不依赖任何具体来源，`filmstyle/builtin.test.ts` 用测试里登记的假插件证明新增来源不用改 `filmstyle/`、`prereqs/`、`config/`、`studio/` | 与别的内置功能同一条登记路；以前来源在模块加载时 `register`、集中在一个 sources 模块 import，是第二套登记 |
| 一个项目可以装几种风格：默认风格在 `.agents/skills/onset-film-style/`（`onset film-style use`），个别镜头用的额外风格在 `.agents/onset-film-styles/<来源>/<目录名>/`（`onset film-style add`，`filmstyle.extraDir`），契约相同。**额外风格不能放进 `.agents/skills`** | 技能目录在指纹里是整棵算一份摘要（`resolveAllSkills` 给注册技能的值就是 `.agents/skills`），放进去的话给项目添一种风格，所有镜头都变 Stale |
| 镜头 `scene.json` 的 `film_style`：空是默认风格，「来源/目录名」是点名的风格，`none` 是不用整片风格。不写的镜头仍记在 `filmstyle.SkillName` 下、提示词仍是 `filmStyleSection`，与只有一种风格时逐字相同；点名的记在 `FilmStyleOwnKey`、提示词换成 `sceneFilmStyleSection`。点名了却没装时 `resolveSceneFilmStyle` 报错，不降级 | 升级 onset 不让老镜头变 Stale；降级成「不用风格」会一路静默到成片 |
| 风格交界：相邻镜头实际用的风格不同时，分镜计划的 `handoff` 必须写 `style_shift`（`scene.StyleShifts`：`morph` / `window` / `sweep` / `match_cut`，每种只配几种 `device`），由 `onset scene cues` 的 `verifyStyleBoundaries` 按项目当前的默认风格判定。cues 把它连同对方镜头 `film_style` 的**原值**（`peer_film_style`）写进两侧的 `timing.enter` / `exit`；`resolveAllSkills` 据此把对方风格解析进 `FilmStyleEnterKey` / `FilmStyleExitKey`，`styleShiftSection` 告诉每一侧手法、自己负责哪一段与对方的 STYLE.md 在哪 | 两侧分别渲染、互相看不到，画法要在画面里自然地换过去，只能靠同一份约定指定谁来换、换的那一侧能读到对方的风格。记原值而不是解析结果，是为了换默认风格后两侧跟着变、不用重跑 cues。改手法表要同步改制作提示词第五阶段「风格交界」的表格，`gen.test.ts` 的「carries style boundaries」逐行比对 |
| 去掉或换掉一种风格前看 `filmstyle.scenesNaming`：还有镜头点名它时 `onset film-style remove` 拒绝（`--force` 才删），`use --replace` 把旧的默认风格留作额外风格（`keepReplaced`）。客户端里镜头的「换风格」不改文件，只把要求写进输入框交给编排工具 | 删了被点名的风格，那些镜头渲染时找不到它；哪个镜头用哪种风格要改分镜计划，是编排工具的事 |

lemo 来源（内置插件 `lemo-styles`，`packages/engine/src/plugins/lemo-styles`）自己的约定：

| 约定 | 原因 |
|---|---|
| `PinnedCommit`（`lemo.ts`）固定 commit，`catalog.json` 由 `gen/main.ts` 的 `generateCatalog(<检出目录>)` 从同一 commit 生成（生成器校验 HEAD，只在开发时调用），`PinnedStyleCount` 守条数 | STYLE.md 与 demo 引擎直接决定画面；跟随 main 的话同一项目两次安装得到不同风格 |
| 风格库在 `<风格根目录>/lemo-opuscar/<commit>`，`ONSET_LEMO_OPUSCAR_LIBRARY` 指向用户自己的检出；onset 克隆的带 `.onset-library` 标记，只有它的稀疏规则可以由 onset 改 | 子进程总是经环境变量拿到风格库目录，不能用「是不是默认目录」判断归属 |
| 只接画面，不接风格库的 Python 配乐工具（`core/audio/`） | 要一套 Python 环境加约 1.4 GB 采样库，国内网络装不上时整条链路卡住；配乐仍走第九阶段的授权素材，Sound palette 只作参考 |
| git 子进程带 `GIT_HTTP_LOW_SPEED_LIMIT/TIME`（1 KB/s 持续 60 秒即放弃） | 连接被掐断时 `--filter=blob:none` 的按需取文件不报错只挂着，实测卡过半小时 |
| 下载可续传：克隆在固定的 `<目录>.partial` 里进行，失败保留；`prepareLibrary`（`prepare.ts`）先按 `libraryStages`（`library.ts`）取基础部分，再取海报、按 `demoBatch` 分批取 demo、取 core/assets，每段重试 5 次，最后 `npm ci` 装 three.js，全部完成写 `.git/onset-complete` | 按需取文件一批里断一次整批白下；分段后已取回的留在本地，国内网络下重跑几次总能下完 |
| 技能目录不带 `demo/stills`、渲染产物与音频，不带 `core/render`；three.js 只带 demo 与 `core/` 实际 import 到的模块（`threeClosure`），`core/assets` 只带源码里出现过名字的模型与贴图（`referencedAssets`，按名字认是因为 demo 常拼接路径），两者都在 `select.ts` | 整棵带的话一种 three.js 风格进项目 34 MB，挑过之后几 MB；多余的文件还会让指纹随无关内容变化 |
| 风格库里的文件硬链接进项目，跨磁盘时退回复制；用户自己的检出只复制、不改权限。**不设只读** | 内容钉在 commit 上不会变，硬链接不占第二份磁盘。只读试过：渲染器 cp 出的副本继承只读，安全模式又不放行 chmod，真实渲染在这上面绕了好几轮 |
| `SKILL.md` 由 `skill.md.tmpl` 生成：给制作的说明（先 treatment 再看 demo、字体从 Google Fonts 取、`core/fonts` 中文只有约 200 字）与渲染规则（`window.render(t)` 怎么换成 HyperFrames 的 `hf-seek`、`/core/...` 路径为何拷进镜头目录后不用改、Sound palette 与胶片颗粒对镜头无效） | 上游写给它自己的渲染器，这些冲突上游不会替我们守 |

制作提示词「整片风格」一节由「carries the film style without naming a source」钉着。升级 `PinnedCommit` 时对比新旧 `core/lib.js` 与 `core/README.md` 的页面契约。

anidoodle 来源（内置插件 `anidoodle-styles`）自己的约定。上游不是「风格目录 + demo」，而是一套 Canvas2D 绘图引擎：每种风格是 `draw(ctx, frame, env)` 写成的示范画（TypeScript），多数另有笔触模块（`<风格>Kit.ts`），`references/styles/<风格>.md` 写介质、笔触、边缘、顺序、色板与禁忌：

| 约定 | 原因 |
|---|---|
| `PinnedCommit`（`anidoodle.ts`）固定 commit；`catalog.json` 由 `gen/main.ts` 从同一 commit 的检出生成，含每种风格要带的模块闭包（`modules`）与它在上游图鉴里的格子（`cell`）。中文名、分类、示范画与适用题材写在 `gen/zh.ts`，与上游风格一一对应，中文名避开别的来源（`anidoodle.test.ts` 的「does not share a Chinese name with another source」）。升级时 `ONSET_UPDATE_GOLDEN=1 ONSET_ANIDOODLE_SRC=<检出> npx vitest run --root packages/engine src/plugins/anidoodle-styles` 重写目录，不设 `ONSET_UPDATE_GOLDEN` 时核对目录并对 32 种风格跑转换与确定性扫描 | 示范画与笔触模块直接决定画面；中文名撞了，`film_style_use` 只写名字就得写全 |
| 只稀疏检出要用的（约 2 MB：许可、风格说明、四份通用说明、各风格的模块闭包、图鉴），不取 README 的动图视频、配乐、采样包与工具脚本 | 整仓 94 MB，绝大部分是给它自己的工作流用的 |
| TypeScript 在 `onset setup` 时转成浏览器 ES 模块（`build.ts`）：用 onset 自己的运行时的 `module.stripTypeScriptTypes`（transform 模式，上游有参数属性与 `<T>` 断言），再按 tsc 的规则去掉没当作值用到的具名引入（`elideUnusedImports`），相对引用补 `.js`。不用 esbuild / tsc。转换规则变了就递增 `CompilerVersion`，已下载的检出会重转、不重下 | 客户端里没有 esbuild、tsc 与 npm 装出来的原生二进制。上游有 `import { P, rng }` 这种不带 `type` 的类型引入，只去类型的话浏览器报「没有导出 P」，整个模块加载失败（实测）；判断「用到」时成员访问与对象字面量的键不算 |
| 海报从上游图鉴 `skills/anidoodle/assets/styles.jpg`（8×4）裁（`mediaprobe.cropImages`），裁前核对图鉴的 sha256；缺 ffmpeg 时抛 `prereq.MissingError` | 上游没有单张海报；图鉴重排了而格子没改，海报会张冠李戴 |
| 转好的模块与海报放在构建目录：onset 自己克隆的放检出里的 `.onset-build/`，`ONSET_ANIDOODLE_LIBRARY` 指向的用户检出另放在 `<风格根目录>/anidoodle/local-<路径摘要>`，不往用户目录里写 | 与 lemo 一样不改用户自己的检出 |
| 项目里的风格目录：`anidoodle/`（转好的模块加接头 `onset-anidoodle.js`，渲染器整目录拷进镜头目录）、`source/`（TypeScript 原文，读来学技法）、`references/`、`STYLE.md`（中文说明加上游原文；上游没写说明的两种指向源码文件头）。接头（`runtime.js.tmpl`）把 Film 接到 `hf-seek`：先画第 0 帧、准备登记成 `window.__hf.buildReady`，Film 的检查比上游 `validate` 宽（不要求镜头切在 bpm 网格上）。改 `core.ts` / `film.ts` 的 `Env` 或 `renderFrame` 时要同步改接头 | 上游的宿主（`hosts/page.ts`）依赖它自己的打包与 playwright，不能直接用 |
| SKILL.md 要求只有 canvas、没有 GSAP 时间轴的合成在根元素上加 `data-no-timeline` | 不加的话 HyperFrames 每次渲染等 45 秒时间轴（实测 50 秒对 4.7 秒，产物逐字节相同） |
| 只接画面：配乐、旁白、音效、采样包、发布片模板、品牌导入、3D（`three-core`）与上游全部工具脚本都没接 | 与 lemo 同理；3D 要另带 three.js，以后要接可复用 `filmstyle/select.ts` 的 `threeClosure` |

huashu 来源（内置插件 `huashu-styles`）自己的约定。上游 huashu-art-motion 是一台浏览器 Canvas2D 动画引擎：`engine.js` 把时间 t 画成一帧，`lib/` 是十几个绘画库（全局 `U`、`PAINT`、`RIG`……），每种风格是 `scenes/<id>.js` 注册的一个场景 `SCENES[id] = { draw(c, lt, t) }`，`references/风格配方/<id>.md` 是配方卡：

| 约定 | 原因 |
|---|---|
| 只收 26 种：实做过、与 lemo / anidoodle 不重复、不点名具体作品形象的（`gen/zh.ts`）。不收研究配方（38–55 号，上游自评都没到 80 分）、一星的伦勃朗、重复的水墨 / 8-bit / 橡皮管 / 皮影 / 当代扁平，以及吉卜力、新海诚、Kirby、Rick & Morty、南方公园、皮克斯 | 收重复的只会让选风格时多一个分不清的名字；点名作品的风格等于让用户直接套别人的形象。`huashu.test.ts` 的「carries no likeness of the author and no named franchises」钉着 |
| `PinnedCommit`（`huashu.ts`）固定 commit；`catalog.json` 由 `gen/main.ts` 从同一 commit 的检出生成：库的加载顺序取自上游 `index.html`，每种风格的字体按场景源码里引号中的 family 名认、再加一种中文字体（`zh.ts` 的 `cjk`：霞鹜文楷或思源黑体），定位、质量、短板、手法与母题取自上游 `风格配方/INDEX.md`。升级时 `ONSET_UPDATE_GOLDEN=1 ONSET_HUASHU_SRC=<检出> npx vitest run --root packages/engine src/plugins/huashu-styles`，不设 `ONSET_UPDATE_GOLDEN` 时核对目录，并把 26 种都装进镜头目录跑确定性扫描 | 引擎、库与场景直接决定画面；字体全带的话每个镜头目录 16 MB，按风格挑之后 2 MB 左右 |
| 不带 `lib/rig_huashu.js`、角色帧与 `three.min.js` | 花叔本人的卡通形象不随 MIT 授权（上游 README「许可证」）；three.js 没有一种接入的风格用到 |
| 构建（`build.ts`）：`engine.js` 去掉预览播放器（`patchEngine`，从「预览 UI」注释到 `boot().catch(`，标记各恰好一次，否则报错）；每种风格一份 `fonts.js`（`fontsScript`，只列带上的字体、路径改成 `huashu/lib/fonts/`）；海报从全风格总览图（6×6，格子 480×270）裁，裁前核对 sha256。改了规则递增 `BuildVersion` | 预览播放器读 `performance.now()`，HyperFrames lint 直接拦下；引擎启动时加载 `FONT_FACES` 里的每一个字体，列了没带的文件就启动失败 |
| 镜头里怎么接（`fill.ts` 的 `templateHTML` 与两个接头）：渲染器把 `huashu/` 拷进镜头目录，`huashu/template.html` 拷成 `index.html` 换掉 `__W__` / `__H__` / `__DUR__`，场景写在镜头目录的 `scene.js`（`SCENES['scene']`）。加载顺序：`onset-huashu-pre.js`（全部 2D 画布 `willReadFrequently`、`OnsetHuashu.use`）→ 字体表 → 库 → `U.setStage(W, H)` → `scene.js` → `OnsetHuashu.use('scene', 秒)` → 引擎 → `onset-huashu.js`（引擎就绪登记成 `window.__hf.buildReady.huashu`，`hf-seek` 时 `prepare(t)` 再 `renderFrame(t)`） | 上游用同步 XHR 加 eval 加载场景，确定性扫描扫不到场景代码，改成 `<script src>`；场景模块初始化时就读 `STAGE`，`setStage` 放在引擎里太晚，竖屏会按 1920×1080 排（试作实测）；GPU 光栅下笔触类风格同一帧两次渲染不同（实测梵高 120 帧里 73 帧不同），软件光栅后逐帧相同、速度不变 |
| `STYLE.md` 是 onset 写的定位与规则（画法盖到每样东西上、为题材重新构图、色板以全片配色为准、文字画在材质里）加配方卡原文加源码导览（`sceneOutline`：场景第一层定义的名字与行号；读时钟、不带种子随机的行单独点名）；上游场景放 `source/` 只读来学 | 上游场景文件 30–50 KB、有几百字符的长行，渲染器一次读不完（试作反馈）；罗马马赛克的场景用 `performance.now()` 测耗时，照抄会被产物校验拦下 |
| 只接画面：解说动画语法、口播整片、长卷、配乐与上游的 Python 工具都没接 | 与 lemo、anidoodle 同理 |
