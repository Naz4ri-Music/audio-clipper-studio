import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export class BinaryExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BinaryExecutionError";
  }
}

async function runBinary(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(new BinaryExecutionError(`${command} no está disponible: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new BinaryExecutionError(`${command} terminó con código ${code}. ${stderr}`));
    });
  });
}

async function runBinaryBuffer(
  command: string,
  args: string[],
  maxStdoutBytes = 64 * 1024 * 1024
): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let exceeded = false;

    child.stdout.on("data", (chunk: Buffer) => {
      if (exceeded) {
        return;
      }

      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        exceeded = true;
        child.kill("SIGKILL");
        return;
      }

      chunks.push(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(new BinaryExecutionError(`${command} no está disponible: ${error.message}`));
    });

    child.on("close", (code) => {
      if (exceeded) {
        reject(new BinaryExecutionError(`Salida demasiado grande en ${command}.`));
        return;
      }

      if (code === 0) {
        resolve({ stdout: Buffer.concat(chunks), stderr });
        return;
      }
      reject(new BinaryExecutionError(`${command} terminó con código ${code}. ${stderr}`));
    });
  });
}

export async function extractWaveformPeaks(params: {
  filePath: string;
  samples?: number;
}): Promise<number[]> {
  const safeSamples = Math.min(4000, Math.max(64, Math.floor(params.samples ?? 700)));

  const { stdout } = await runBinaryBuffer("ffmpeg", [
    "-v",
    "error",
    "-i",
    params.filePath,
    "-ac",
    "1",
    "-ar",
    "8000",
    "-f",
    "f32le",
    "pipe:1"
  ]);

  if (stdout.length < 4) {
    return new Array<number>(safeSamples).fill(0);
  }

  const usableBytes = stdout.length - (stdout.length % 4);
  if (usableBytes <= 0) {
    return new Array<number>(safeSamples).fill(0);
  }

  const copied = stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + usableBytes);
  const pcm = new Float32Array(copied);
  if (pcm.length === 0) {
    return new Array<number>(safeSamples).fill(0);
  }

  const blockSize = Math.max(1, Math.floor(pcm.length / safeSamples));
  const peaks = new Array<number>(safeSamples).fill(0);
  let globalPeak = 0;

  for (let i = 0; i < safeSamples; i += 1) {
    const start = i * blockSize;
    const end = i === safeSamples - 1 ? pcm.length : Math.min(start + blockSize, pcm.length);
    let localPeak = 0;

    for (let j = start; j < end; j += 1) {
      const value = Math.abs(pcm[j] || 0);
      if (value > localPeak) {
        localPeak = value;
      }
    }

    peaks[i] = localPeak;
    if (localPeak > globalPeak) {
      globalPeak = localPeak;
    }
  }

  if (globalPeak <= 0) {
    return peaks;
  }

  return peaks.map((value) => value / globalPeak);
}

export async function probeDurationSec(filePath: string): Promise<number | null> {
  try {
    const { stdout } = await runBinary("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath
    ]);

    const parsed = Number.parseFloat(stdout.trim());
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function renderClip(params: {
  sourcePath: string;
  startSec: number;
  endSec: number | null;
  includeCountdown: boolean;
  delaySec: number;
  countdownPath: string;
  outputDir: string;
  outputStem: string;
}): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "audio-clipper-"));
  const outputPath = path.join(params.outputDir, `${params.outputStem}-${randomUUID()}.mp3`);

  const normalizedStart = Math.max(0, params.startSec || 0);
  const normalizedEnd =
    params.endSec !== null && Number.isFinite(params.endSec) ? Math.max(params.endSec, normalizedStart) : null;
  const durationSec = normalizedEnd !== null ? Math.max(0.05, normalizedEnd - normalizedStart) : null;

  try {
    if (!params.includeCountdown && params.delaySec <= 0) {
      const trimArgs = ["-y", "-i", params.sourcePath, "-ss", normalizedStart.toFixed(3)];
      if (durationSec !== null) {
        trimArgs.push("-t", durationSec.toFixed(3));
      }
      trimArgs.push("-c:a", "libmp3lame", "-q:a", "2", outputPath);
      await runBinary("ffmpeg", trimArgs);
      return outputPath;
    }

    const parts: string[] = [];

    if (params.delaySec > 0) {
      const silencePath = path.join(tempDir, "silence.wav");
      await runBinary("ffmpeg", [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=44100:cl=stereo",
        "-t",
        params.delaySec.toFixed(3),
        "-acodec",
        "pcm_s16le",
        silencePath
      ]);
      parts.push(silencePath);
    }

    if (params.includeCountdown) {
      const countdownPreparedPath = path.join(tempDir, "countdown.wav");
      await runBinary("ffmpeg", [
        "-y",
        "-i",
        params.countdownPath,
        "-af",
        "areverse,silenceremove=start_periods=1:start_duration=0.02:start_threshold=-45dB,areverse",
        "-ar",
        "44100",
        "-ac",
        "2",
        "-acodec",
        "pcm_s16le",
        countdownPreparedPath
      ]);
      parts.push(countdownPreparedPath);
    }

    const clipPath = path.join(tempDir, "clip.wav");
    const clipArgs = ["-y", "-i", params.sourcePath, "-ss", normalizedStart.toFixed(3)];
    if (durationSec !== null) {
      clipArgs.push("-t", durationSec.toFixed(3));
    }
    clipArgs.push("-ar", "44100", "-ac", "2", "-acodec", "pcm_s16le", clipPath);
    await runBinary("ffmpeg", clipArgs);
    parts.push(clipPath);

    const concatArgs = ["-y"];
    parts.forEach((partPath) => {
      concatArgs.push("-i", partPath);
    });

    const inputRefs = parts.map((_, index) => `[${index}:a]`).join("");
    const concatFilter = `${inputRefs}concat=n=${parts.length}:v=0:a=1[out]`;
    concatArgs.push("-filter_complex", concatFilter, "-map", "[out]", "-c:a", "libmp3lame", "-q:a", "2", outputPath);

    await runBinary("ffmpeg", concatArgs);

    return outputPath;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function transcodeClipPreviewAac(params: {
  sourcePath: string;
  startSec: number;
  endSec: number | null;
  outputPath: string;
  bitrateKbps?: number;
}): Promise<void> {
  const normalizedStart = Math.max(0, params.startSec || 0);
  const normalizedEnd =
    params.endSec !== null && Number.isFinite(params.endSec) ? Math.max(params.endSec, normalizedStart) : null;
  const durationSec = normalizedEnd !== null ? Math.max(0.05, normalizedEnd - normalizedStart) : null;
  const bitrate = Math.max(64, Math.min(320, Math.floor(params.bitrateKbps ?? 128)));

  const args = ["-y", "-i", params.sourcePath, "-ss", normalizedStart.toFixed(3)];
  if (durationSec !== null) {
    args.push("-t", durationSec.toFixed(3));
  }
  args.push(
    "-vn",
    "-sn",
    "-dn",
    "-c:a",
    "aac",
    "-b:a",
    `${bitrate}k`,
    "-ar",
    "44100",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    params.outputPath
  );

  await runBinary("ffmpeg", args);
}

export async function renderClipSegmentWavBuffer(params: {
  sourcePath: string;
  startSec: number;
  endSec: number | null;
}): Promise<Buffer> {
  const normalizedStart = Math.max(0, params.startSec || 0);
  const normalizedEnd =
    params.endSec !== null && Number.isFinite(params.endSec) ? Math.max(params.endSec, normalizedStart) : null;
  const durationSec = normalizedEnd !== null ? Math.max(0.05, normalizedEnd - normalizedStart) : null;

  const args = ["-v", "error", "-i", params.sourcePath, "-ss", normalizedStart.toFixed(3)];
  if (durationSec !== null) {
    args.push("-t", durationSec.toFixed(3));
  }
  args.push("-vn", "-sn", "-dn", "-c:a", "pcm_s16le", "-ar", "44100", "-ac", "2", "-f", "wav", "pipe:1");

  const { stdout } = await runBinaryBuffer("ffmpeg", args);
  return stdout;
}
