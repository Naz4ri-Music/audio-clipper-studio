import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { transcodeClipPreviewAac } from "@/lib/ffmpeg";

interface ClipLike {
  id: string;
  sourceAudioId: string;
  startSec: number;
  endSec: number | null;
}

const PREVIEW_DIR = path.join(process.cwd(), "data", "public-previews");
const DEFAULT_PUBLIC_PREVIEW_BITRATE = Number.parseInt(process.env.PUBLIC_PREVIEW_BITRATE_KBPS || "96", 10);

function previewAudioPath(clipId: string): string {
  return path.join(PREVIEW_DIR, `${clipId}.m4a`);
}

function previewMetaPath(clipId: string): string {
  return path.join(PREVIEW_DIR, `${clipId}.json`);
}

function normalizeBitrate(value: number | undefined): number {
  const raw = value ?? DEFAULT_PUBLIC_PREVIEW_BITRATE;
  return Math.max(64, Math.min(320, Math.floor(raw)));
}

function previewSignature(clip: ClipLike, bitrateKbps: number): string {
  const endPart = clip.endSec === null ? "end" : clip.endSec.toFixed(3);
  return `${clip.sourceAudioId}:${clip.startSec.toFixed(3)}:${endPart}:aac${bitrateKbps}`;
}

async function ensureDir(): Promise<void> {
  await mkdir(PREVIEW_DIR, { recursive: true });
}

export function getPublicPreviewUrlPath(clipId: string): string {
  return `/api/public/clips/${clipId}/preview`;
}

export async function ensurePublicClipPreview(params: {
  clip: ClipLike;
  sourcePath: string;
  bitrateKbps?: number;
}): Promise<string> {
  await ensureDir();

  const audioPath = previewAudioPath(params.clip.id);
  const metaPath = previewMetaPath(params.clip.id);
  const bitrateKbps = normalizeBitrate(params.bitrateKbps);
  const signature = previewSignature(params.clip, bitrateKbps);

  try {
    const [metaRaw] = await Promise.all([readFile(metaPath, "utf-8"), access(audioPath)]);
    const parsed = JSON.parse(metaRaw) as { signature?: string };
    if (parsed.signature === signature) {
      return audioPath;
    }
  } catch {
    // Regenerate preview.
  }

  const tempPath = path.join(PREVIEW_DIR, `${params.clip.id}.${randomUUID()}.tmp.m4a`);
  try {
    await transcodeClipPreviewAac({
      sourcePath: params.sourcePath,
      startSec: params.clip.startSec,
      endSec: params.clip.endSec,
      outputPath: tempPath,
      bitrateKbps
    });
    await rename(tempPath, audioPath);
    await writeFile(metaPath, JSON.stringify({ signature }, null, 2), "utf-8");
    return audioPath;
  } finally {
    await rm(tempPath, { force: true });
  }
}
