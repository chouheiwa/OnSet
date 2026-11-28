import type { ModelSpec, ToolSpec } from '../toolinstall';
import { BreezeTTS2, QwenCustomVoice } from './tts_models';

export { orchestratorAccess, orchestratorBaseCommands, parseAllowCommands } from './access';
export { BreezeTTS2, QwenCustomVoice } from './tts_models';

/**
 * 一个可选的配音服务。合成由 voice.synthesize 执行，编排工具只调用 voice_synthesize。
 *
 * timestamps 是该服务自带时间戳的粒度，决定第四阶段要不要另做强制对齐：
 * sentence 只能用于粗排，char 可以直接用作短语级时间轴的依据。
 *
 * command 是 OnSet 内部使用的适配器命令，不加入编排工具的命令白名单。
 */
export interface TTSProvider {
  id: string;
  name: string;
  timestamps: string;
  command: string;
  /** onset setup 怎么装它（版本钉死）。客户端用户不必自己 npm / pipx / brew。 */
  install: ToolSpec;
  /** 工具第一次运行会去下的模型：onset setup（客户端的工具准备页）预先下好，OnSet 的配音适配器直接取本地路径。 */
  model?: ModelSpec;
}

/**
 * TTS_PROVIDER 的全部合法取值，顺序即帮助文字里的顺序。
 *
 * 收录标准是「有可非交互调用的 CLI，且凭据不必落进项目文件」：
 *   - 豆包 / 火山引擎没有官方 CLI，接入要在 onset 里写一个无法离线验证的 HTTP 客户端；
 *   - Azure 的 spx 把密钥写进当前目录下的 ./spx/data，即项目目录；
 *   - IndexTTS2 的许可对商用与模型输出有限制，且只能从源码安装。
 *
 * 这三家暂不收录。
 *
 * breeze（Breeze TTS 2）与 mlx 是同一个 mlx-audio 命令，换了模型：它的权重与生成的音频受
 * BreezeBlue Research and Non-Commercial License 约束，商用要 RESONIA, Inc. 书面授权
 * （推理代码的 Apache 2.0 不覆盖模型与产出）。许可只写在 README 里，界面与提示词不另行提示；缺省值仍是 minimax。
 */
export const TTSProviders: readonly TTSProvider[] = [
  {
    id: 'minimax',
    name: 'MiniMax（mmx CLI）',
    timestamps: 'sentence',
    command: 'mmx',
    install: { kind: 'npm', package: 'mmx-cli', version: '1.0.28', bins: ['mmx'] },
  },
  {
    id: 'bailian',
    name: '阿里云百炼（bl CLI）',
    timestamps: 'none',
    command: 'bl',
    install: { kind: 'npm', package: 'bailian-cli', version: '2.5.1', bins: ['bl'] },
  },
  {
    id: 'edge',
    name: '微软 Edge 在线语音（edge-tts，免鉴权）',
    timestamps: 'sentence',
    command: 'edge-tts',
    install: { kind: 'uv-tool', package: 'edge-tts', version: '7.3.1', bins: ['edge-tts'] },
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs（官方 CLI）',
    timestamps: 'char',
    command: 'elevenlabs',
    install: { kind: 'npm', package: '@elevenlabs/cli', version: '1.7.0', bins: ['elevenlabs'] },
  },
  {
    id: 'tencent',
    name: '腾讯云语音合成（tccli）',
    timestamps: 'sentence',
    command: 'tccli',
    install: { kind: 'uv-tool', package: 'tccli', version: '3.1.187.1', bins: ['tccli'] },
  },
  {
    id: 'mlx',
    name: '本机 MLX 语音合成（mlx-audio，仅 Apple Silicon）',
    timestamps: 'none',
    command: 'mlx_audio.tts.generate',
    install: mlxAudio(['mlx_audio.tts.generate']),
    model: QwenCustomVoice,
  },
  {
    id: 'breeze',
    name:
      process.platform === 'win32'
        ? 'Breeze TTS 2（Windows CUDA，Q8_0）'
        : 'Breeze TTS 2（mlx-audio，仅 Apple Silicon）',
    timestamps: 'none',
    command: process.platform === 'win32' ? 'breeze-tts' : 'mlx_audio.tts.generate',
    install:
      process.platform === 'win32'
        ? { kind: 'native-breeze' as const, version: '0.9.4', bins: ['breeze-tts'], platforms: ['win32/x64'] }
        : mlxAudio(['mlx_audio.tts.generate']),
    model: process.platform === 'win32' ? undefined : BreezeTTS2,
  },
];

/** mlx-audio：语音合成与 Qwen3 强制对齐是同一个包；依赖里有预发布版本，要放行。0.6.5 起修复 Qwen3 编解码器误将码字 0 当作 padding 截断 Breeze 段尾的缺陷。 */
function mlxAudio(bins: string[]): ToolSpec {
  return {
    kind: 'uv-tool',
    package: 'mlx-audio',
    version: '0.6.5',
    bins,
    prerelease: true,
    platforms: ['darwin/arm64'],
  };
}

/**
 * 一个已知文本强制对齐工具：文稿是现成的，把它逐字对到配音上
 * 比识别更准，也不会把专有名词识别错。
 *
 * command 同 TTSProvider.command。FunASR 装进专用 Python 环境，由 align_run 调用。
 */
export interface Aligner {
  id: string;
  name: string;
  command: string;
  install: ToolSpec;
  /** 工具第一次运行会去下的模型：onset setup（客户端的工具准备页）预先下好，提示词经 config_get 工具取 ALIGN_MODEL 的本地路径。 */
  model?: ModelSpec;
}

/** MLX 强制对齐用的模型（Hugging Face 与魔搭上同名；摘要取自魔搭的文件列表，2026-11）。 */
export const QwenForcedAligner: ModelSpec = {
  repo: 'mlx-community/Qwen3-ForcedAligner-0.6B-8bit',
  files: [
    {
      path: 'chat_template.json',
      sha256: '75a8cfca24f00de72d796fbfed6858fc9614ef3dabd8696684cc3bc03a9c58ff',
      size: 1161,
    },
    { path: 'config.json', sha256: '8dc126e1a4ac001acb02f3a9ca6277c8a20a25485fde293bc99eeab3aedc604d', size: 6940 },
    {
      path: 'generation_config.json',
      sha256: '948d089b23bca1d214e768d59c4438365665f52ec6d33678f4062206b3fbbb8c',
      size: 115,
    },
    { path: 'merges.txt', sha256: '8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5', size: 1671853 },
    {
      path: 'model.safetensors',
      sha256: 'be19ef8ac4326d032e7673342930b14c2df30bd68c1632493b0f563e30829f91',
      size: 1271924386,
    },
    {
      path: 'model.safetensors.index.json',
      sha256: '766eb50873855eeb4d95ab92def358cfd173bfc8c7aabd8635ababa1edf6db79',
      size: 79108,
    },
    {
      path: 'preprocessor_config.json',
      sha256: '45e120a4eda2c20c5d7f2ea9354e63536bf35e27aa573fb7cdf78017b378770d',
      size: 330,
    },
    {
      path: 'tokenizer_config.json',
      sha256: '3ab80063f8511deb9566e6ad438d17b7a6277fcffd52d92854112f19d36bd81c',
      size: 12666,
    },
    { path: 'vocab.json', sha256: 'ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910', size: 2776833 },
  ],
};

/** FunASR 时间戳模型；文件与摘要来自官方魔搭仓库（2026-11）。 */
export const FunASRTimestampModel: ModelSpec = {
  repo: 'iic/speech_timestamp_prediction-v1-16k-offline',
  files: [
    { path: 'am.mvn', sha256: '29b3c740a2c0cfc6b308126d31d7f265fa2be74f3bb095cd2f143ea970896ae5', size: 11203 },
    { path: 'config.yaml', sha256: 'bf673207f2a2e2263403d64adec49666166c047dc74bc03153b0e7882f8d09b4', size: 2455 },
    {
      path: 'configuration.json',
      sha256: 'fbb37220a629e1eb5468c8486fcd5f5650bc0817b28551530e5485db41662c73',
      size: 448,
    },
    { path: 'model.pt', sha256: 'f34ede558af831fb504206b25f1c2f27ca2f77753c26c4dd38d03323153b6f73', size: 158469618 },
    { path: 'seg_dict', sha256: '59a2ef803a3f1648ad03a2e1480db1c1ee0c0d7dc4ef4dbd16cea33944329022', size: 8287834 },
    { path: 'tokens.json', sha256: '2b20c2b12572d682afff84ce1c8d560f67b8b32a4c1f21567411d141ed352127', size: 93676 },
  ],
};

/** ALIGN_PROVIDER 的具体取值；另有 auto 按平台选择。 */
export const Aligners: readonly Aligner[] = [
  {
    id: 'mlx',
    name: 'Qwen3-ForcedAligner（mlx-audio，Apple Silicon 本机）',
    command: 'mlx_audio.stt.generate',
    install: mlxAudio(['mlx_audio.stt.generate']),
    model: QwenForcedAligner,
  },
  {
    id: 'funasr',
    name: process.platform === 'win32' ? 'FunASR 时间戳预测（本机 CPU）' : 'FunASR 时间戳预测（CPU，macOS 与 Linux）',
    command: 'funasr-python',
    install: {
      kind: 'uv-venv',
      name: 'funasr',
      packages: ['funasr==1.4.16', 'torch', 'torchaudio'],
      bin: 'funasr-python',
    },
    model: FunASRTimestampModel,
  },
];

/** 让 onset 按运行平台选择对齐工具。 */
export const AlignAuto = 'auto';

/**
 * 把 auto 落成具体工具：Apple Silicon 用 MLX，其余用 FunASR。
 * goos / goarch 用 Go 的写法（darwin、arm64）；Node 的 process.platform 与之相同，
 * process.arch 的 arm64 也相同（x64 对应 amd64，这里只看 arm64）。
 */
export function resolveAligner(value: string, goos: string, goarch: string): string {
  if (value !== AlignAuto) return value;
  if (goos === 'darwin' && goarch === 'arm64') return 'mlx';
  return 'funasr';
}

/**
 * 内置的默认配音：Apple Silicon 上用本机的 Breeze TTS 2（离线、不花钱，能从音色库克隆同一个声音），
 * 其余平台 Breeze 跑不了（只有 MLX 版），用 MiniMax。goos / goarch 的写法同 resolveAligner。
 * 只是没人设过时的缺省：全局设置或项目里写了就用写的。
 */
export function defaultTTSProvider(goos: string = process.platform, goarch: string = process.arch): string {
  return goos === 'darwin' && goarch === 'arm64' ? 'breeze' : 'minimax';
}

/**
 * 第三方插件提供的配音、对齐：取值是 x:<站 id>。这里只查写法，项目里加没加那个插件、它是不是真的提供，
 * 由编排工具调插件的工具时见分晓（插件的说明接在制作提示词末尾）。插件的工具经 onset 的工具服务调用，
 * 不进编排工具的命令白名单，也不是前置资源。
 */
export const PluginProviderPattern = /^x:[a-z][a-z0-9-]{1,39}$/;

export function isPluginProvider(id: string): boolean {
  return PluginProviderPattern.test(id);
}

export function validTTSProvider(id: string): boolean {
  return TTSProviders.some((provider) => provider.id === id) || isPluginProvider(id);
}

export function validAligner(id: string): boolean {
  return Aligners.some((aligner) => aligner.id === id) || isPluginProvider(id);
}

/** 空格分隔的全部取值，用于错误信息与帮助文字。 */
export function ttsProviderIDs(): string {
  return [...TTSProviders.map((provider) => provider.id), 'x:<插件>'].join(' ');
}

/** 空格分隔的全部取值（含 auto）。 */
export function alignerIDs(): string {
  return [AlignAuto, ...Aligners.map((aligner) => aligner.id), 'x:<插件>'].join(' ');
}

/** 按当前进程的平台解析 auto；测试用 resolveAligner 覆盖其他平台。 */
export function hostAligner(value: string): string {
  return resolveAligner(value, process.platform, process.arch);
}
