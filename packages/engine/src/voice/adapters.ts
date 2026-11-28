/** 各服务的命令与返回结构只在宿主适配器里出现。 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { TTSProvider } from '../config/providers';
import { MissingError } from '../prereq';
import { modelDir } from '../toolinstall';
import type { VoiceEntry } from './library';
import { runVoice } from './runner';
import type { SynthesisOptions } from './synthesis';

type AlignmentItem = { text: string; start: number; end: number };

/**
 * Breeze TTS 2 编解码器帧率为 12.5 Hz（每帧 80ms）；mlx_audio.tts.generate 默认 750 帧（60 秒）
 * 容易截断长段落。按字数留出宽裕余量，设 1500 帧（120 秒）下限与 4096 帧（327 秒）上限。
 */
export function breezeMaxTokens(text: string): number {
  const chars = [...text].length;
  return Math.min(4096, Math.max(1500, Math.ceil(chars * 6) + 300));
}

export async function generateTake(
  opts: SynthesisOptions,
  provider: TTSProvider,
  voice: string,
  reference: VoiceEntry | undefined,
  dir: string,
  text: string,
): Promise<{ raw: string; alignment?: AlignmentItem[] }> {
  const env = opts.env;
  let alignment: AlignmentItem[] | undefined;
  fs.writeFileSync(path.join(dir, 'text.txt'), text);
  const raw = path.join(dir, provider.id === 'edge' || provider.id === 'elevenlabs' ? 'raw.mp3' : 'raw.wav');
  const args: string[] = [];
  switch (provider.id) {
    case 'minimax':
      args.push(
        'speech',
        'synthesize',
        '--text-file',
        path.join(dir, 'text.txt'),
        '--voice',
        voice,
        '--model',
        'speech-2.8-hd',
        '--speed',
        String(opts.speed ?? 1),
        '--volume',
        '1',
        '--pitch',
        '0',
        '--format',
        'wav',
        '--sample-rate',
        '44100',
        '--channels',
        '2',
        '--subtitles',
        '--out',
        raw,
      );
      for (const pronunciation of opts.pronunciation ?? []) args.push('--pronunciation', pronunciation);
      break;
    case 'bailian':
      args.push(
        'speech',
        'synthesize',
        '--text-file',
        path.join(dir, 'text.txt'),
        '--voice',
        voice,
        '--model',
        'cosyvoice-v3-flash',
        '--rate',
        String(opts.speed ?? 1),
        '--volume',
        '50',
        '--pitch',
        '1',
        '--format',
        'wav',
        '--sample-rate',
        '48000',
        '--out',
        raw,
      );
      if (opts.instruction) args.push('--instruction', opts.instruction);
      if (opts.ssml) args.push('--enable-ssml');
      break;
    case 'edge': {
      const percent = Math.round(((opts.speed ?? 1) - 1) * 100);
      args.push(
        '-v',
        voice,
        `--rate=${percent >= 0 ? '+' : ''}${percent}%`,
        '-f',
        path.join(dir, 'text.txt'),
        '--write-media',
        raw,
        '--write-subtitles',
        path.join(dir, 'raw.srt'),
      );
      break;
    }
    case 'elevenlabs':
      args.push(
        'text-to-speech',
        'convert_with_timestamps',
        '--voice-id',
        voice,
        '--model-id',
        'eleven_multilingual_v2',
        '--text',
        text,
        '--voice-settings.speed',
        String(opts.speed ?? 1),
        '--apply-text-normalization',
        'on',
        '--output-format',
        'mp3_44100_128',
        '--format',
        'json',
        '--no-retry',
      );
      break;
    case 'tencent':
      args.push(
        'tts',
        'TextToVoice',
        '--region',
        'ap-guangzhou',
        '--Text',
        text,
        '--SessionId',
        crypto.randomUUID(),
        '--VoiceType',
        voice,
        '--Codec',
        'wav',
        '--SampleRate',
        '16000',
        '--Speed',
        String(opts.speed ?? 0),
        '--EnableSubtitle',
        'True',
      );
      break;
    case 'mlx':
    case 'breeze':
      if (provider.model) args.push('--model', modelDir(provider.model, env));
      else if (provider.id === 'mlx') throw new MissingError('MLX 配音模型');
      if (provider.id === 'breeze' && process.platform === 'win32')
        args.push('--text_file', path.join(dir, 'text.txt'));
      else args.push('--text', text);
      args.push(
        '--voice',
        reference ? 'S0' : voice,
        '--output_path',
        dir,
        '--file_prefix',
        'take',
        '--join_audio',
        '--audio_format',
        'wav',
      );
      if (reference) args.push('--ref_audio', reference.audio, '--ref_text', reference.text);
      else args.push('--lang_code', 'Chinese');
      if (provider.id === 'breeze') {
        // 显式透传 Breeze generation_config.json 的官方采样参数，防止 mlx_audio CLI 默认的
        // repetition_penalty=1.1 / temperature=0.7 / top_p=0.9 覆盖并抬高提前 EOS 概率。
        args.push('--temperature', '0.9', '--max_tokens', String(breezeMaxTokens(text)));
        if (process.platform !== 'win32') args.push('--top_p', '1.0', '--repetition_penalty', '1.0');
      }
      if (opts.instruction) args.push('--instruct', opts.instruction, ...(reference ? ['--cfg_scale', '4'] : []));
      break;
  }
  const response = await runVoice(provider.command, args, env, opts.signal);
  fs.writeFileSync(path.join(dir, 'response.txt'), response);
  if (provider.id === 'tencent' || provider.id === 'elevenlabs') {
    const parsed = JSON.parse(response);
    const data = parsed.Response ?? parsed;
    if (data.Error) throw new Error('配音服务返回错误：' + String(data.Error.Code ?? 'unknown'));
    const base64 = provider.id === 'tencent' ? data.Audio : data.audio_base64;
    if (typeof base64 !== 'string' || !base64.length) throw new Error('配音服务未返回音频');
    fs.writeFileSync(raw, Buffer.from(base64, 'base64'));
    if (provider.id === 'elevenlabs') {
      const a = data.alignment;
      if (
        !a ||
        !Array.isArray(a.characters) ||
        !Array.isArray(a.character_start_times_seconds) ||
        !Array.isArray(a.character_end_times_seconds) ||
        !a.characters.length ||
        a.characters.length !== a.character_start_times_seconds.length ||
        a.characters.length !== a.character_end_times_seconds.length
      )
        throw new Error('ElevenLabs 未返回有效的字级时间戳');
      const items = a.characters.map((text: unknown, i: number) => {
        const start = a.character_start_times_seconds[i],
          end = a.character_end_times_seconds[i];
        if (typeof text !== 'string' || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start)
          throw new Error('ElevenLabs 字级时间戳无效');
        return { text, start, end };
      });
      alignment = items;
    }
  } else if (provider.id === 'mlx' || provider.id === 'breeze') {
    fs.renameSync(path.join(dir, 'take.wav'), raw);
  }
  if (!fs.existsSync(raw) || fs.statSync(raw).size === 0) throw new Error('配音服务没有生成音频');

  return { raw, alignment };
}
