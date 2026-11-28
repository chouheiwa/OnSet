/**
 * 轻量级 PCM WAV 尾部硬断检测：仅读取文件尾窗，不依赖外部进程，也不误杀正常收尾。
 *
 * 用于在配音合成后识别「末段仍处于高能量语音、几乎没有尾静音就直接截断」的异常片段，
 * 只产出诊断信息与告警，不阻断或改写音频。
 */
import fs from 'node:fs';
import path from 'node:path';
import { goRound } from '../gofmt';
import type { Toolchain } from '../mediaprobe';

/** 分段末尾微淡出时长（秒）：消除与数字零静音拼接的咔哒硬断，不损伤正常语尾。 */
export const SegmentTailFadeSeconds = 0.018;
/** 低于此时长（秒）的极短片段不做尾淡出。 */
const MinFadeDurationSeconds = 0.1;
const roundSec = (value: number) => goRound(value * 1_000_000) / 1_000_000;

export interface TailInspection {
  tailSilenceMs: number;
  tail50msDb: number;
  abrupt: boolean;
}

const SILENCE_THRESHOLD = 10 ** (-35 / 20);
const ABRUPT_MAX_SILENCE_MS = 5;
const ABRUPT_MIN_RMS_DB = -28;
const MIN_DURATION_SECONDS = 0.2;
const INSPECT_WINDOW_SECONDS = 0.5;
const TAIL_RMS_WINDOW_SECONDS = 0.05;

interface WavLayout {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataSize: number;
}

function parsePcmWavLayout(fd: number, fileSize: number): WavLayout | null {
  if (fileSize < 44) return null;
  const header = Buffer.alloc(12);
  if (fs.readSync(fd, header, 0, 12, 0) < 12) return null;
  if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') return null;

  let offset = 12;
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;
  const chunkHeader = Buffer.alloc(8);

  while (offset + 8 <= fileSize) {
    if (fs.readSync(fd, chunkHeader, 0, 8, offset) < 8) break;
    const id = chunkHeader.toString('ascii', 0, 4);
    const size = chunkHeader.readUInt32LE(4);
    const body = offset + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= fileSize) {
      const fmt = Buffer.alloc(16);
      fs.readSync(fd, fmt, 0, 16, body);
      audioFormat = fmt.readUInt16LE(0);
      channels = fmt.readUInt16LE(2);
      sampleRate = fmt.readUInt32LE(4);
      bitsPerSample = fmt.readUInt16LE(14);
    } else if (id === 'data') {
      dataOffset = body;
      dataSize = Math.min(size, Math.max(0, fileSize - body));
      break;
    }
    const next = body + size + (size & 1);
    if (next <= offset) break;
    offset = next;
  }

  if (audioFormat !== 1 || bitsPerSample !== 16 || channels < 1 || sampleRate < 1 || dataOffset < 0 || dataSize <= 0) {
    return null;
  }
  return { sampleRate, channels, bitsPerSample, dataOffset, dataSize };
}

/**
 * 检查未施加淡出的 16-bit PCM WAV 末尾是否出现高能量硬截断；非 PCM WAV 返回 undefined。
 */
export function inspectWavTail(file: string): TailInspection | undefined {
  let fd = -1;
  try {
    const stat = fs.statSync(file);
    fd = fs.openSync(file, 'r');
    const wav = parsePcmWavLayout(fd, stat.size);
    if (!wav) return undefined;

    const frameBytes = wav.channels * 2;
    const totalFrames = Math.floor(wav.dataSize / frameBytes);
    if (totalFrames / wav.sampleRate < MIN_DURATION_SECONDS) return undefined;

    const rmsFrames = Math.max(1, goRound(TAIL_RMS_WINDOW_SECONDS * wav.sampleRate));
    if (totalFrames < rmsFrames) return undefined;

    const windowFrames = Math.min(totalFrames, Math.max(rmsFrames, goRound(INSPECT_WINDOW_SECONDS * wav.sampleRate)));
    const startFrame = totalFrames - windowFrames;
    const buf = Buffer.alloc(windowFrames * frameBytes);
    const read = fs.readSync(fd, buf, 0, buf.length, wav.dataOffset + startFrame * frameBytes);
    const framesRead = Math.floor(read / frameBytes);
    if (framesRead < rmsFrames) return undefined;

    let lastActive = -1;
    let rmsSum = 0;
    const rmsStart = framesRead - rmsFrames;
    for (let i = 0; i < framesRead; i++) {
      let peak = 0;
      let frameSq = 0;
      const base = i * frameBytes;
      for (let ch = 0; ch < wav.channels; ch++) {
        const v = buf.readInt16LE(base + ch * 2) / 32768;
        const abs = Math.abs(v);
        if (abs > peak) peak = abs;
        frameSq += v * v;
      }
      if (peak > SILENCE_THRESHOLD) lastActive = i;
      if (i >= rmsStart) rmsSum += frameSq / wav.channels;
    }

    const tailSilenceFrames = lastActive < 0 ? framesRead : framesRead - 1 - lastActive;
    const tailSilenceMs = goRound(((tailSilenceFrames * 1000) / wav.sampleRate) * 10) / 10;
    const rms = Math.sqrt(rmsSum / rmsFrames);
    const tail50msDb = Math.max(-120, goRound(20 * Math.log10(Math.max(rms, 1e-6)) * 10) / 10);
    const abrupt = tailSilenceMs <= ABRUPT_MAX_SILENCE_MS && tail50msDb > ABRUPT_MIN_RMS_DB;
    return { tailSilenceMs, tail50msDb, abrupt };
  } catch {
    return undefined;
  } finally {
    if (fd >= 0) fs.closeSync(fd);
  }
}

/**
 * 将原始分段音频归一化为 48kHz 双声道 PCM WAV 并施加极短防爆音尾淡出，同时在淡出前检查真实尾静音。
 * WAV 源直接检查原始文件后单次转码；非 WAV 源（如 MP3）先转无淡出 PCM 检查，再按实测时长施加尾淡出。
 */
export async function normalizeSegmentAudio(
  tc: Pick<Toolchain, 'probe' | 'transcode'>,
  raw: string,
  audio: string,
  signal?: AbortSignal,
): Promise<{ duration: number; tail?: TailInspection }> {
  let tail: TailInspection | undefined;
  if (path.extname(raw).toLowerCase() === '.wav') {
    tail = inspectWavTail(raw);
    let rawDuration = 0;
    try {
      rawDuration = tc.probe(raw).duration_seconds;
    } catch {
      rawDuration = 0;
    }
    const transcodeArgs = ['-i', raw, '-vn'];
    if (Number.isFinite(rawDuration) && rawDuration > MinFadeDurationSeconds) {
      const fadeStart = Math.max(0, roundSec(rawDuration - SegmentTailFadeSeconds));
      transcodeArgs.push('-af', `afade=t=out:st=${fadeStart}:d=${SegmentTailFadeSeconds}`);
    }
    transcodeArgs.push('-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le');
    await tc.transcode(audio, transcodeArgs, signal);
  } else {
    const normalized = path.join(path.dirname(audio), '.normalized.wav');
    try {
      await tc.transcode(normalized, ['-i', raw, '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le'], signal);
      tail = inspectWavTail(normalized);
      const normDuration = tc.probe(normalized).duration_seconds;
      if (Number.isFinite(normDuration) && normDuration > MinFadeDurationSeconds) {
        const fadeStart = Math.max(0, roundSec(normDuration - SegmentTailFadeSeconds));
        await tc.transcode(
          audio,
          [
            '-i',
            normalized,
            '-vn',
            '-af',
            `afade=t=out:st=${fadeStart}:d=${SegmentTailFadeSeconds}`,
            '-c:a',
            'pcm_s16le',
          ],
          signal,
        );
      } else {
        fs.renameSync(normalized, audio);
      }
    } finally {
      fs.rmSync(normalized, { force: true });
    }
  }
  const duration = tc.probe(audio).duration_seconds;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('配音音频时长无效');
  return { duration, tail };
}
