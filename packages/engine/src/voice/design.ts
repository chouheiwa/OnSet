/**
 * 在音色页上直接做一个新声音：按一句描述用本机的 Breeze TTS 2 念一段试听（音色设计），
 * 或者让用户对着麦克风念同一段文字。两条路都落到 library.save，存成可以克隆的参考音频。
 *
 * 试听稿放在音色库目录的 .drafts/ 下（以点开头，list 不会把它当成音色），一天后清掉。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BreezeTTS2, TTSProviders } from '../config/providers';
import { modelDir, modelReady, toolStatus } from '../toolinstall';
import { findOptional } from '../toolpath';
import { windowsBreezeStatus } from '../windowsruntime/breeze';
import { runVoice } from './runner';

/**
 * 默认的朗读稿：录自己的声音、设计新声音时都念它。十秒左右（参考音频要 3 到 30 秒），
 * 有陈述、有疑问、有停顿，克隆时语气才有东西可学；没有生僻字、英文和数字，念错的机会少，
 * 逐字稿也就对得上。
 */
export const SampleText =
  '大家好，欢迎来到今天的节目。这一期我们聊一个看起来简单、其实很多人都想错了的问题：为什么坚持，往往比开始更难？';

const draftsDir = '.drafts';
const draftTTLms = 24 * 60 * 60 * 1000;
const tool = TTSProviders.find((p) => p.id === 'breeze')!;

/** 这台机器能不能用描述设计音色，不能的话原因是什么。 */
export interface DesignStatus {
  ready: boolean;
  /** Apple Silicon 使用 MLX；Windows x64 使用单独安装并验证的 CUDA 运行时。 */
  supported: boolean;
  problem: string;
}

export function designStatus(
  env: Record<string, string | undefined>,
  platform = process.platform,
  arch = process.arch,
): DesignStatus {
  if (platform === 'win32' && arch === 'x64') {
    const status = windowsBreezeStatus(env, platform);
    return {
      ready: status.ok,
      supported: true,
      problem: status.ok ? '' : '还没准备好 Windows Breeze CUDA 运行时与 Q8 模型，请在工具准备页安装并完成合成自检',
    };
  }
  if (platform !== 'darwin' || arch !== 'arm64') {
    return {
      ready: false,
      supported: false,
      problem: '按描述设计音色要用本机的 Breeze TTS 2，只能在 Apple Silicon 的 Mac 上运行',
    };
  }
  if (!toolStatus(TTSProviders.find((p) => p.id === 'mlx')!.install, env).ok || !modelReady(BreezeTTS2, env)) {
    return { ready: false, supported: true, problem: '还没装 Breeze TTS 2（约 4.6 GB）' };
  }
  return { ready: true, supported: true, problem: '' };
}

/** 一段试听稿。 */
export interface Draft {
  id: string;
  instruction: string;
  text: string;
  audio: string;
  created: string;
}

function draftRoot(root: string): string {
  return path.join(root, draftsDir);
}

/** 按 id 取试听稿；id 只认 design 生成的格式，免得拼出库外的路径。 */
export function getDraft(root: string, id: string): Draft {
  if (!/^d-[0-9a-f]{12}$/.test(id)) throw new Error('没有这段试听');
  const meta = path.join(draftRoot(root), id + '.json');
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(meta, 'utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('没有这段试听（试听只保留一天）');
  }
  return {
    id,
    instruction: String(raw.instruction ?? ''),
    text: String(raw.text ?? ''),
    audio: path.join(draftRoot(root), id + '.wav'),
    created: String(raw.created ?? ''),
  };
}

function pruneDrafts(root: string, now: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(draftRoot(root));
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(draftRoot(root), name);
    try {
      if (now - fs.statSync(file).mtimeMs > draftTTLms) fs.rmSync(file, { recursive: true, force: true });
    } catch {
      // 别的请求刚删掉它。
    }
  }
}

export interface DesignOptions {
  instruction: string;
  text?: string;
  env: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * 按描述念一段试听。描述说清性别、年龄段、音色与语气；不给 text 时念 SampleText。
 * 同一句描述每次生成的声音都不一样，所以可以多生成几段再挑——挑中的那段存进音色库之后，
 * 以后都从它克隆，声音才稳定下来。
 */
export async function design(root: string, opts: DesignOptions): Promise<Draft> {
  if (root === '') throw new Error('无法确定音色库目录：环境里没有 HOME');
  const instruction = opts.instruction.trim();
  if (instruction === '')
    throw new Error('先写一句描述：性别、年龄段、音色和语气，例如「三十多岁的男性，声音沉稳清晰，语气平静、真诚」');
  if ([...instruction].length > 200) throw new Error('描述写一两句就够了（200 字以内）');
  const text = (opts.text ?? '').trim() || SampleText;
  if ([...text].length > 120) throw new Error('试听文字太长：120 字以内（存进音色库的参考音频最长 30 秒）');
  const status = designStatus(opts.env);
  if (!status.ready) throw new Error(status.problem);
  const command = findOptional(tool.command, opts.env);
  if (command === '') throw new Error(designStatus({}).problem);

  const now = Date.now();
  pruneDrafts(root, now);
  const dir = draftRoot(root);
  fs.mkdirSync(dir, { recursive: true });
  const id = 'd-' + crypto.randomBytes(6).toString('hex');
  const work = fs.mkdtempSync(path.join(dir, '.work-'));
  try {
    const args = [
      ...(process.platform === 'win32' ? [] : ['--model', modelDir(BreezeTTS2, opts.env)]),
      '--text',
      text,
      '--voice',
      'S0',
      '--instruct',
      instruction,
      '--cfg_scale',
      '4',
      '--temperature',
      '0.9',
      ...(process.platform === 'win32' ? [] : ['--top_p', '1.0', '--repetition_penalty', '1.0']),
      '--output_path',
      work,
      '--file_prefix',
      'take',
      '--join_audio',
      '--audio_format',
      'wav',
    ];
    await runVoice(command, args, { ...opts.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' }, opts.signal);
    const take = path.join(work, 'take.wav');
    if (!fs.existsSync(take)) throw new Error('Breeze 没有生成音频');
    fs.renameSync(take, path.join(dir, id + '.wav'));
    const draft: Draft = {
      id,
      instruction,
      text,
      audio: path.join(dir, id + '.wav'),
      created: new Date(now).toISOString(),
    };
    fs.writeFileSync(
      path.join(dir, id + '.json'),
      JSON.stringify({ instruction, text, created: draft.created }) + '\n',
    );
    return draft;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
