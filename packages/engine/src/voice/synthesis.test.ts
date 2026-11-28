import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { modelReady } from '../toolinstall';
import { breezeMaxTokens } from './adapters';
import { runVoice } from './runner';
import { SegmentTailFadeSeconds, synthesize } from './synthesis';
import { inspectWavTail } from './tail';

const transcodeCalls: { file: string; args: string[] }[] = [];
let mockProbeDuration = 1;
let customTranscode: ((file: string, args: string[]) => void) | null = null;

vi.mock('./runner', () => ({ runVoice: vi.fn() }));
vi.mock('./design', () => ({ designStatus: () => ({ ready: true }) }));
vi.mock('../toolinstall', () => ({ modelReady: vi.fn(() => true), modelDir: () => '/prepared/model' }));
vi.mock('../mediaprobe', () => ({
  newToolchain: () => ({
    transcode: async (file: string, args: string[]) => {
      transcodeCalls.push({ file, args });
      if (customTranscode) customTranscode(file, args);
      else fs.writeFileSync(file, 'converted audio');
    },
    probe: () => ({ duration_seconds: mockProbeDuration, audio: { sample_rate: 48000, channels: 2 } }),
  }),
}));
let root: string;
const calls = vi.mocked(runVoice);
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-synthesis-'));
  calls.mockReset();
  transcodeCalls.length = 0;
  mockProbeDuration = 1;
  customTranscode = null;
  vi.mocked(modelReady).mockReturnValue(true);
  calls.mockImplementation(async (_command, args) => {
    const flag = (key: string) => args[args.indexOf(key) + 1];
    if (args.includes('--output_path')) fs.writeFileSync(path.join(flag('--output_path'), 'take.wav'), 'raw');
    if (args.includes('--out')) fs.writeFileSync(flag('--out'), 'raw');
    if (args.includes('--write-media')) fs.writeFileSync(flag('--write-media'), 'raw');
    if (args.includes('TextToVoice'))
      return JSON.stringify({ Audio: Buffer.from('raw').toString('base64'), Subtitles: [] });
    if (args.includes('convert_with_timestamps'))
      return JSON.stringify({
        audio_base64: Buffer.from('raw').toString('base64'),
        alignment: { characters: ['你'], character_start_times_seconds: [0], character_end_times_seconds: [1] },
      });
    return '{}';
  });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const options = (provider: string) => ({
  provider,
  text: '你好。',
  voice: provider === 'tencent' ? '101001' : 'speaker',
  output: path.join(root, 'voice.wav'),
  env: {},
});

describe('managed speech synthesis', () => {
  it.each(['minimax', 'bailian', 'edge', 'elevenlabs', 'tencent', 'mlx'])(
    'runs %s through the managed runner and publishes WAV with source evidence',
    async (provider) => {
      const result = await synthesize(options(provider));
      expect(fs.readFileSync(result.audio, 'utf8')).toBe('converted audio');
      expect(fs.existsSync(result.report)).toBe(true);
      expect(result.duration_seconds).toBe(1);
      expect(calls).toHaveBeenCalled();
    },
  );

  it('loads the default Breeze reference itself and keeps the transcript byte for byte', async () => {
    const library = path.join(root, 'voices');
    fs.mkdirSync(path.join(library, '老周'), { recursive: true });
    fs.writeFileSync(path.join(library, 'library.json'), '{"default":"老周"}');
    fs.writeFileSync(
      path.join(library, '老周', 'voice.json'),
      JSON.stringify({ name: '老周', text: '原样的参考稿。', source: 'recorded' }),
    );
    fs.writeFileSync(path.join(library, '老周', 'reference.wav'), 'reference');
    await synthesize({
      ...options('breeze'),
      voice: '',
      instruction: '平静、真诚',
      env: { ONSET_VOICES_DIR: library },
    });
    const args = calls.mock.calls[0][1];
    expect(args).toContain('原样的参考稿。');
    expect(args).toContain(path.join(library, '老周', 'reference.wav'));
    expect(args).toContain('平静、真诚');
    expect(args).toContain('--temperature');
    expect(args[args.indexOf('--temperature') + 1]).toBe('0.9');
    expect(args).toContain('--max_tokens');
    expect(Number(args[args.indexOf('--max_tokens') + 1])).toBeGreaterThanOrEqual(1500);
    if (process.platform !== 'win32') {
      expect(args[args.indexOf('--top_p') + 1]).toBe('1.0');
      expect(args[args.indexOf('--repetition_penalty') + 1]).toBe('1.0');
    }
    expect(args).not.toContain('mlx-community/Breeze-TTS-2-mlx-8bit');
  });

  it('scales Breeze max_tokens dynamically with text length and applies tail fade on transcode', async () => {
    expect(breezeMaxTokens('短句')).toBe(1500);
    expect(breezeMaxTokens('字'.repeat(300))).toBe(2100);
    expect(breezeMaxTokens('字'.repeat(1000))).toBe(4096);

    await synthesize(options('edge'));
    const segTranscode = transcodeCalls.find((c) => c.file.endsWith('audio.wav'));
    expect(segTranscode?.args).toContain('-af');
    expect(segTranscode?.args).toContain(`afade=t=out:st=${1 - SegmentTailFadeSeconds}:d=${SegmentTailFadeSeconds}`);

    // 极短片段（<= 0.1s）不施加淡出。
    transcodeCalls.length = 0;
    mockProbeDuration = 0.08;
    await synthesize({ ...options('edge'), output: path.join(root, 'tiny.wav') });
    expect(transcodeCalls.some((c) => c.args.includes('-af'))).toBe(false);
  });

  it('detects abrupt high-energy WAV tails and inspects non-WAV sources before tail fade', async () => {
    const makePcmWav = (file: string, sampleRate: number, totalSec: number, tailSilentSec: number) => {
      const totalSamples = Math.round(sampleRate * totalSec);
      const activeSamples = Math.round(sampleRate * (totalSec - tailSilentSec));
      const data = Buffer.alloc(totalSamples * 2);
      for (let i = 0; i < activeSamples; i++) {
        const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 16000);
        data.writeInt16LE(sample, i * 2);
      }
      const header = Buffer.alloc(44);
      header.write('RIFF', 0);
      header.writeUInt32LE(36 + data.length, 4);
      header.write('WAVE', 8);
      header.write('fmt ', 12);
      header.writeUInt32LE(16, 16);
      header.writeUInt16LE(1, 20);
      header.writeUInt16LE(1, 22);
      header.writeUInt32LE(sampleRate, 24);
      header.writeUInt32LE(sampleRate * 2, 28);
      header.writeUInt16LE(2, 32);
      header.writeUInt16LE(16, 34);
      header.write('data', 36);
      header.writeUInt32LE(data.length, 40);
      fs.writeFileSync(file, Buffer.concat([header, data]));
    };

    const abruptWav = path.join(root, 'abrupt.wav');
    const cleanWav = path.join(root, 'clean.wav');
    const shortTailWav = path.join(root, 'short-tail-15ms.wav');
    makePcmWav(abruptWav, 24000, 1.0, 0);
    makePcmWav(cleanWav, 24000, 1.0, 0.12);
    makePcmWav(shortTailWav, 48000, 1.0, 0.015);
    expect(inspectWavTail(abruptWav)).toMatchObject({ abrupt: true, tailSilenceMs: 0 });
    expect(inspectWavTail(cleanWav)).toMatchObject({ abrupt: false });
    expect(inspectWavTail(shortTailWav)).toMatchObject({ abrupt: false, tailSilenceMs: 15 });

    let callIdx = 0;
    calls.mockImplementation(async (_command, args) => {
      const out = args[args.indexOf('--out') + 1];
      fs.copyFileSync(callIdx++ === 0 ? abruptWav : cleanWav, out);
      return '{}';
    });
    const progress: string[] = [];
    const result = await synthesize({
      ...options('minimax'),
      text: '第一段硬断。\n第二段正常。',
      progress: (msg) => progress.push(msg),
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings![0]).toContain('第 1 段');
    expect(progress.some((m) => m.includes('疑似高能量硬截断'))).toBe(true);
    const report = JSON.parse(fs.readFileSync(result.report, 'utf8'));
    expect(report.segments[0].abrupt_tail).toBe(true);
    expect(report.segments[1].abrupt_tail).toBeUndefined();
    expect(report.warnings).toEqual(result.warnings);

    // 非 WAV 音源（Edge MP3）：先归一化 PCM 检查，15ms 自然尾静音不误报，0ms 无尾静音仍准确报警。
    calls.mockImplementation(async (_command, args) => {
      fs.writeFileSync(args[args.indexOf('--write-media') + 1], 'mp3');
      return '{}';
    });
    let normIdx = 0;
    customTranscode = (file, args) => {
      if (file.endsWith('.normalized.wav')) {
        fs.copyFileSync(normIdx++ === 0 ? shortTailWav : abruptWav, file);
      } else if (args.some((arg) => arg.endsWith('.normalized.wav'))) {
        expect(args).toContain('-af');
        fs.writeFileSync(file, 'faded audio');
      } else {
        fs.writeFileSync(file, 'converted audio');
      }
    };
    const mp3Res = await synthesize({
      ...options('edge'),
      output: path.join(root, 'edge-tail.wav'),
      text: '高能量后带15毫秒尾静音。\n真正零尾静音硬断。',
    });
    const mp3Report = JSON.parse(fs.readFileSync(mp3Res.report, 'utf8'));
    expect(mp3Report.segments[0].abrupt_tail).toBeUndefined();
    expect(mp3Report.segments[1].abrupt_tail).toBe(true);
    expect(mp3Res.warnings).toHaveLength(1);
    expect(mp3Res.warnings![0]).toContain('第 2 段');
    expect(fs.existsSync(path.join(mp3Res.sources, '001', '.normalized.wav'))).toBe(false);
    expect(fs.existsSync(path.join(mp3Res.sources, '002', '.normalized.wav'))).toBe(false);
  });

  it('splits Tencent at its request limit without losing any text', async () => {
    const text = '这是长文。'.repeat(80);
    await synthesize({ ...options('tencent'), voice: '101001', text });
    const parts = calls.mock.calls.map(([, args]) => args[args.indexOf('--Text') + 1]);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('')).toBe(text);
    expect(parts.every((part) => [...part].length <= 150)).toBe(true);
  });

  it('keeps shell metacharacters as literal text and translates Edge rate', async () => {
    const text = '原样 $(touch nope) `command` "quoted"\n下一行';
    await synthesize({ ...options('edge'), text, speed: 0.98 });
    const args = calls.mock.calls[0][1];
    expect(args).toContain('--rate=-2%');
    expect(fs.readFileSync(path.join(root, 'voice.tts', 'text.txt'), 'utf8')).toBe(text);
  });

  it('rejects unsupported options and empty text before starting a provider', async () => {
    await expect(synthesize({ ...options('edge'), instruction: '平静' })).rejects.toThrow('instruction');
    await expect(synthesize({ ...options('minimax'), text: '  ' })).rejects.toThrow('文稿');
    await expect(synthesize({ ...options('mlx'), speed: NaN })).rejects.toThrow('speed');
    expect(calls).not.toHaveBeenCalled();
  });

  it('requires the prepared local MLX model without starting a download', async () => {
    vi.mocked(modelReady).mockReturnValue(false);
    await expect(synthesize(options('mlx'))).rejects.toThrow('工具准备页');
    expect(calls).not.toHaveBeenCalled();
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('normalizes real character timestamps and rejects malformed provider responses', async () => {
    const result = await synthesize(options('elevenlabs'));
    expect(JSON.parse(fs.readFileSync(result.alignment!, 'utf8'))).toEqual([{ text: '你', start: 0, end: 1 }]);
    calls.mockResolvedValueOnce('{"audio_base64":"cmF3","alignment":{"characters":["你"]}}');
    const output = path.join(root, 'bad.wav');
    await expect(synthesize({ ...options('elevenlabs'), output })).rejects.toThrow('字级时间戳');
    expect(fs.existsSync(output)).toBe(false);
  });

  it('allows only one synthesis per output, including during conversion', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const normal = calls.getMockImplementation()!;
    calls.mockImplementation(async (...args) => {
      await gate;
      return normal(...args);
    });
    const first = synthesize(options('edge'));
    await expect(synthesize(options('edge'))).rejects.toThrow('正在生成');
    release();
    await first;
    expect(fs.existsSync(path.join(root, 'voice.tts.lock'))).toBe(false);
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('splits multi-paragraph and chapter text with default 650ms / 1300ms pauses and offsets character timestamps', async () => {
    const result = await synthesize({ ...options('elevenlabs'), text: '第一段。\n第二段。\n\n第三段。' });
    expect(calls).toHaveBeenCalledTimes(3);
    const report = JSON.parse(fs.readFileSync(result.report, 'utf8'));
    expect(report.paragraph_pause_ms).toBe(650);
    expect(report.chapter_pause_ms).toBe(1300);
    expect(
      report.segments.map((s: { start_seconds: number; pause_after_ms?: number }) => [
        s.start_seconds,
        s.pause_after_ms ?? 0,
      ]),
    ).toEqual([
      [0, 650],
      [1.65, 1300],
      [3.95, 0],
    ]);
    const concat = fs.readFileSync(path.join(result.sources, 'concat.txt'), 'utf8');
    expect(concat).toBe(
      "file '001/audio.wav'\nfile 'pause-650ms.wav'\nfile '002/audio.wav'\nfile 'pause-1300ms.wav'\nfile '003/audio.wav'\n",
    );
    const alignment = JSON.parse(fs.readFileSync(result.alignment!, 'utf8')) as {
      text: string;
      start: number;
      end: number;
    }[];
    expect(alignment.map((item) => [item.start, item.end])).toEqual([
      [0, 1],
      [1.65, 2.65],
      [3.95, 4.95],
    ]);
  });

  it('skips paragraph splitting when paragraphPauseMs is 0 or ssml is enabled, and rejects invalid pause values', async () => {
    await synthesize({ ...options('edge'), text: '第一段。\n第二段。\n\n第三段。', paragraphPauseMs: 0 });
    expect(calls).toHaveBeenCalledTimes(1);
    calls.mockClear();
    await synthesize({
      ...options('bailian'),
      output: path.join(root, 'ssml.wav'),
      text: '<speak>\n第一段。\n第二段。\n</speak>',
      ssml: true,
    });
    expect(calls).toHaveBeenCalledTimes(1);
    await expect(
      synthesize({ ...options('edge'), output: path.join(root, 'bad-pause.wav'), paragraphPauseMs: -10 }),
    ).rejects.toThrow('paragraph_pause_ms');
    await expect(
      synthesize({ ...options('edge'), output: path.join(root, 'bad-pause2.wav'), paragraphPauseMs: 5000 }),
    ).rejects.toThrow('paragraph_pause_ms');
    await expect(
      synthesize({ ...options('edge'), output: path.join(root, 'bad-chapter.wav'), chapterPauseMs: 6000 }),
    ).rejects.toThrow('chapter_pause_ms');
  });

  it('preserves existing takes and leaves no final output on failure or cancellation', async () => {
    fs.writeFileSync(options('edge').output, 'approved');
    await expect(synthesize(options('edge'))).rejects.toThrow('已存在');
    expect(fs.readFileSync(options('edge').output, 'utf8')).toBe('approved');
    fs.unlinkSync(options('edge').output);
    calls.mockRejectedValueOnce(new Error('provider failed'));
    await expect(synthesize(options('edge'))).rejects.toThrow('provider failed');
    expect(fs.existsSync(options('edge').output)).toBe(false);
    const controller = new AbortController();
    controller.abort();
    await expect(synthesize({ ...options('edge'), signal: controller.signal })).rejects.toThrow();
    expect(fs.existsSync(options('edge').output)).toBe(false);
  });
});
