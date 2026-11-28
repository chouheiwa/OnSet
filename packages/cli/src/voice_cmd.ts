/**
 * voice_*：音色库与配音（@onset/engine/voice）的宿主操作。
 *
 * 删除不是操作：音色库是用户积累下来的声音，编排工具一句话删掉就找不回来，只在客户端的音色页里删。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as config from '@onset/engine/config';
import { envMap } from '@onset/engine/envutil';
import * as voice from '@onset/engine/voice';
import { defineGroup } from './ops/cli';
import { bool, num, projectRoot, str, strs } from './ops/common';
import { defineOp, ParamError } from './ops/op';

function libraryDir(): string {
  const dir = voice.defaultDir(envMap());
  if (dir === '') throw new Error('无法确定音色库目录：环境里没有 HOME');
  return dir;
}

/** 配音只读写项目内的普通路径；拒绝通过父目录软链接越过项目边界。 */
function projectFile(root: string, value: string): string {
  const file = path.resolve(root, value);
  const inside = (candidate: string) => {
    const rel = path.relative(root, candidate);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel))
      throw new ParamError('配音文件必须在项目目录内');
  };
  inside(file);
  if (/(^|[\\/])\.(?:env|git|codex)(?:[.\\/]|$)/i.test(path.relative(root, file)))
    throw new ParamError('配音不能读取或写入凭据与内部配置文件');
  let parent = file;
  while (true) {
    try {
      if (fs.lstatSync(parent).isSymbolicLink()) throw new ParamError('配音路径不能经过符号链接');
      inside(fs.realpathSync(parent));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (parent === root) break;
    parent = path.dirname(parent);
  }
  return file;
}

defineOp({
  name: 'voice_synthesize',
  cli: ['voice', 'synthesize'],
  verb: '生成配音',
  summary: '按项目配置生成配音：OnSet 管理服务调用、Breeze 音色克隆、格式转换与原始产物',
  description: `所有内置 TTS 都从这里调用，不在终端执行配音命令。读取项目的 TTS_PROVIDER，text 与 text_file 二选一。
Breeze 的 voice 是音色库名称，留空取默认音色；参考音频和逐字稿由 OnSet 读取，instruction 只指导语气。
其他服务的 voice 是 voice_catalog 返回的 ID。speed 通常是倍率；腾讯沿用 -2..6 刻度（0 正常）；Breeze 和 MLX 用 instruction 指导语速。
输出统一为 48kHz 双声道 WAV，同名 .tts 目录保存文本、原始音频、原始时间戳和 report.json。
ElevenLabs 返回 alignment 路径，可交给 align_build；其他服务需继续强制对齐。已有产物不覆盖，重做用新的版本文件名。
模型或工具缺失时回工具准备页；调用可用 job_cancel 取消，不自行安装、下载或重试失败请求。`,
  examples: [
    'voice_synthesize({"text_file":"production/audio/tts-text.txt","output":"production/audio/voice.wav"})',
    'voice_synthesize({"text":"大家好。","voice":"沉稳男声","instruction":"平静、真诚","output":"production/audio/try-01.wav"})',
  ],
  params: {
    project_root: projectRoot,
    text: { type: 'string', description: '要朗读的文稿，与 text_file 二选一' },
    text_file: { type: 'string', description: '项目内的 UTF-8 文稿文件，与 text 二选一' },
    voice: { type: 'string', description: '音色 ID；Breeze 为音色库名称，留空取默认音色' },
    output: { type: 'string', description: '项目内的新 WAV 文件；不覆盖', default: 'production/audio/voice.wav' },
    speed: {
      type: 'string',
      description: '可选语速数值：通常为倍率；腾讯为 -2..6（0 正常）；Breeze 和 MLX 不支持，改用 instruction',
    },
    instruction: { type: 'string', description: 'Breeze、MLX 或百炼的语气指导，不用于更换 Breeze 音色' },
    pronunciation: { type: 'strings', description: 'MiniMax 发音替换，每项为 原文/读法，如 2025年/二零二五年' },
    ssml: { type: 'boolean', description: '仅百炼：文稿使用 SSML' },
    paragraph_pause_ms: {
      type: 'integer',
      description: `多段文稿（单换行分段）在段落之间插入的静音停顿毫秒数，默认 ${voice.DefaultParagraphPauseMs}（范围 0..${voice.MaxParagraphPauseMs}，0 关闭分段补静音）`,
      default: voice.DefaultParagraphPauseMs,
    },
    chapter_pause_ms: {
      type: 'integer',
      description: `章节（空行 \\n\\n 分隔，align_text 在 # 标题处自动保留）之间插入的静音停顿毫秒数，默认 ${voice.DefaultChapterPauseMs}（范围 0..${voice.MaxChapterPauseMs}）`,
    },
  },
  run: async (p, { out, signal }) => {
    const root = fs.realpathSync(str(p.project_root));
    const cfg = config.load(root, null);
    if ((str(p.text) === '') === (str(p.text_file) === '')) throw new ParamError('text 与 text_file 要给且只给一个');
    const text = str(p.text_file) ? fs.readFileSync(projectFile(root, str(p.text_file)), 'utf8') : str(p.text);
    const paragraphPauseMs = num(p.paragraph_pause_ms);
    const chapterPauseMs = p.chapter_pause_ms !== undefined ? num(p.chapter_pause_ms) : undefined;
    const result = await voice.synthesize({
      provider: cfg.ttsProvider,
      text,
      voice: str(p.voice),
      output: projectFile(root, str(p.output)),
      ...(str(p.speed) ? { speed: Number(str(p.speed)) } : {}),
      instruction: str(p.instruction),
      pronunciation: strs(p.pronunciation),
      ssml: bool(p.ssml),
      paragraphPauseMs,
      ...(chapterPauseMs !== undefined ? { chapterPauseMs } : {}),
      env: { ...envMap(), ...cfg.overlay },
      signal,
      progress: (message) => out.write(message + '\n'),
    });
    out.write(`配音已生成：${result.audio}\n生成报告：${result.report}\n`);
    for (const warning of result.warnings ?? []) out.write(`警告：${warning}\n`);
    return { data: result };
  },
});

defineOp({
  name: 'voice_catalog',
  cli: ['voice', 'catalog'],
  summary: '查询项目当前配音服务的可用音色；Breeze 返回用户音色库',
  description:
    '读取项目 TTS_PROVIDER，由 OnSet 查询当前服务的音色，不需要执行外部命令。Breeze 返回已保存音色及默认项；MLX 返回预置音色；腾讯返回 VoiceType 列表入口。云端服务使用已有的用户级登录，未登录先完成服务登录，不把密钥传给工具。',
  examples: ['voice_catalog()'],
  params: { project_root: projectRoot },
  run: async (p, { out, signal }) => {
    const cfg = config.load(str(p.project_root), null);
    const data = await voice.catalog(cfg.ttsProvider, { ...envMap(), ...cfg.overlay }, signal);
    out.write('已查询配音音色\n');
    return { data };
  },
});

defineOp({
  name: 'voice_design',
  cli: ['voice', 'design'],
  summary: '用 Breeze 按描述生成新音色试听；确认后用 voice_save 存入库',
  description:
    '只用于试听新声音，不用于正式配音。已有音色用 voice_synthesize 克隆。设计会检查本地工具和模型，不联网下载。',
  examples: [
    'voice_design({"instruction":"三十多岁的男性，声音沉稳清晰，语气平静、真诚","output":"production/audio/try-01.wav"})',
  ],
  params: {
    project_root: projectRoot,
    instruction: { type: 'string', description: '新声音的性别、年龄段、音色和语气', required: true },
    text: { type: 'string', description: '试听文稿，120 字以内；留空用标准朗读稿' },
    output: { type: 'string', description: '项目内的新试听 WAV 文件', required: true },
  },
  run: async (p, { out, signal }) => {
    const root = fs.realpathSync(str(p.project_root));
    const output = projectFile(root, str(p.output));
    if (path.extname(output).toLowerCase() !== '.wav') throw new ParamError('output 必须是 .wav 文件');
    if (fs.existsSync(output)) throw new ParamError('试听文件已存在，请换一个文件名');
    out.write('正在设计音色试听\n');
    const draft = await voice.design(libraryDir(), {
      instruction: str(p.instruction),
      text: str(p.text),
      env: envMap(),
      signal,
    });
    signal.throwIfAborted();
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(draft.audio, output, fs.constants.COPYFILE_EXCL);
    out.write(`试听已生成：${output}\n`);
    return { data: { ...draft, audio: output } };
  },
});

function voiceJSON(v: voice.VoiceEntry): Record<string, unknown> {
  return {
    name: v.name,
    audio: v.audio,
    text: v.text,
    source: v.source,
    ...(v.instruction ? { instruction: v.instruction } : {}),
    duration_seconds: v.duration_seconds,
    created: v.created,
    is_default: v.is_default,
  };
}

defineGroup({
  path: ['voice'],
  summary: '音色库：所有项目共用的参考音色，Breeze 从它克隆，保持同一个声音',
  description: `音色库放在用户级目录（ONSET_VOICES_DIR 可覆盖），所有项目共用。每个音色是一段确认过的参考音频
（转成 24kHz 单声道 WAV）加逐字一致的文字稿，用 Breeze 配音时从它克隆。

只靠一句描述设计音色每次生成都会漂，同一个账号的片子之间听起来像换了人；克隆出来的始终是同一个声音。

  voice_list()      看库里有哪些音色、默认是哪个
  voice_catalog()   看项目配音服务的可用音色
  voice_synthesize()  按项目配置生成配音
  voice_design()    设计新音色的试听
  voice_get()       查看默认音色（或指定音色）的详情
  voice_save()      把用户确认过的一段声音存进来
  voice_default()   换默认音色

删除只能在客户端的音色页里做。`,
});

defineOp({
  name: 'voice_list',
  cli: ['voice', 'list'],
  summary: '列出音色库里的音色（所有项目共用），标出默认音色',
  description: `音色库放在用户级目录，所有项目共用：每个音色是一段确认过的参考音频加逐字一致的文字稿，
Breeze TTS 2 从它克隆，同一个账号的每部片子都是同一个声音。

只靠一句描述设计音色每次生成都会漂；要长期保持同一个声音，就把确认过的那段存进来（voice_save()），
以后用 voice_get() 取出参考音频与文字稿克隆。`,
  examples: ['voice_list()'],
  params: {},
  run: (_p, { out }) => {
    const voices = voice.list(libraryDir());
    if (voices.length === 0) out.write('音色库还是空的：用户确认了一个声音后，用 voice_save() 存进来。\n');
    for (const v of voices) {
      out.write(`${v.is_default ? '★ ' : '  '}${v.name}（${v.duration_seconds.toFixed(1)} 秒）：${v.text}\n`);
    }
    return { data: { voices: voices.map(voiceJSON) } };
  },
});

defineOp({
  name: 'voice_get',
  cli: ['voice', 'get'],
  summary: '取一个音色的参考音频路径与文字稿（不给名字取默认音色），用来克隆',
  description: `返回音色详情与参考文字稿。正式配音把 name 交给 voice_synthesize，OnSet 自动读取参考音频和文字稿。不给 name 时取默认音色；还没有默认音色时报错。`,
  examples: ['voice_get()', 'voice_get({"name": "老周"})'],
  params: {
    name: { type: 'string', description: '音色名；不填取默认音色', positional: 0 },
  },
  run: (p, { out }) => {
    const dir = libraryDir();
    let name = str(p.name);
    if (name === '') {
      name = voice.defaultName(dir);
      if (name === '')
        throw new ParamError('音色库里还没有默认音色：先按制作提示词试听、确认一个声音，再用 voice_save() 存进来');
    }
    const v = voice.get(dir, name);
    out.write(`音色：${v.name}${v.is_default ? '（默认）' : ''}\n参考音频：${v.audio}\n文字稿：${v.text}\n`);
    return { data: voiceJSON(v) };
  },
});

defineOp({
  name: 'voice_save',
  cli: ['voice', 'save'],
  summary: '把用户确认过的一段声音存进音色库，以后的片子都从它克隆',
  description: `audio 是项目里的一段音频（试听文件或用户上传的录音），text 是这段音频里说的话，必须逐字一致——
克隆时 OnSet 使用它，对不上会让克隆出来的声音含糊、吞字。音频转成 24kHz 单声道 WAV 存进
用户级的音色库，时长要在 ${voice.MinReferenceSeconds} 到 ${voice.MaxReferenceSeconds} 秒之间（一两句话）。

同名音色已存在时报错，确实要替换加 overwrite。
库里还没有默认音色时，存进来的就是默认音色；make_default 让它成为默认。`,
  examples: [
    '# 用户试听后说「就这个声音，以后都用它」',
    'voice_save({"name": "沉稳男声", "audio": "production/audio/try-2.wav", "text_file": "production/audio/try-text.txt", "source": "designed", "instruction": "一位三十多岁的男性，声音沉稳清晰，语气平静、真诚", "make_default": true})',
    '',
    '# 用户上传了一段自己的录音',
    'voice_save({"name": "我的声音", "audio": "assets/voice/me.m4a", "text": "大家好，欢迎来到今天的节目。", "source": "recorded"})',
  ],
  params: {
    name: {
      type: 'string',
      description: '音色名：中文、字母、数字、- 和 _，最长 40 字',
      required: true,
      positional: 0,
    },
    audio: { type: 'string', description: '音频文件，相对项目根', required: true },
    text: { type: 'string', description: '音频里说的话，逐字一致；与 text_file 二选一' },
    text_file: { type: 'string', description: '存着文字稿的文本文件，相对项目根；与 text 二选一' },
    source: {
      type: 'string',
      description: '来源：designed（描述设计后确认的）、recorded（用户本人的录音）、uploaded（其他）',
      default: 'designed',
    },
    instruction: { type: 'string', description: '设计这个音色时用的描述（只作记录）' },
    make_default: { type: 'boolean', description: '设为默认音色' },
    overwrite: { type: 'boolean', description: '替换同名音色' },
  },
  run: async (p, { out, signal }) => {
    const text = str(p.text);
    const textFile = str(p.text_file);
    if ((text === '') === (textFile === '')) throw new ParamError('text 与 text_file 要给且只给一个');
    const source = str(p.source) as voice.Source;
    if (!voice.Sources.includes(source)) throw new ParamError(`source 只能是 ${voice.Sources.join('、')}`);
    const transcript = textFile === '' ? text : fs.readFileSync(path.resolve(textFile), 'utf8');
    const saved = await voice.save(libraryDir(), {
      name: str(p.name),
      audio: path.resolve(str(p.audio)),
      text: transcript,
      source,
      instruction: str(p.instruction),
      overwrite: bool(p.overwrite),
      makeDefault: bool(p.make_default),
      env: envMap(),
      signal,
    });
    out.write(
      `已存进音色库：${saved.name}（${saved.duration_seconds.toFixed(1)} 秒）${saved.is_default ? '，是默认音色' : ''}\n`,
    );
    return { data: voiceJSON(saved) };
  },
});

defineOp({
  name: 'voice_default',
  cli: ['voice', 'default'],
  summary: '把音色库里的一个音色设为默认：新项目用 Breeze 配音时直接克隆它',
  description: `默认音色是用 Breeze 配音时不指定名字就克隆的那一个（voice_get() 不给 name 时取它）。
只在用户明确说「以后都用这个声音」时才改默认：它对所有项目生效，不只是这一部片子。`,
  examples: ['voice_default({"name": "沉稳男声"})'],
  params: {
    name: { type: 'string', description: '音色名', required: true, positional: 0 },
  },
  run: (p, { out }) => {
    const dir = libraryDir();
    voice.setDefault(dir, str(p.name));
    out.write(`默认音色：${str(p.name)}\n`);
    return { data: voiceJSON(voice.get(dir, str(p.name))) };
  },
});
