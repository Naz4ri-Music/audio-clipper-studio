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
