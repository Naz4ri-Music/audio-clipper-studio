import { access } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { createAudioStreamResponse } from "@/lib/audio-response";
import { renderClipSegmentWavBuffer } from "@/lib/ffmpeg";
import { findPublicCollectionClipAudioBySlug, sanitizeFilenameStem } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

function buildDownloadName(songName: string, clipName: string, originalName: string): string {
  const extension = path.extname(originalName).toLowerCase() || ".mp3";
  const stem = sanitizeFilenameStem(`${songName}_${clipName}`.replace(/\s+/g, "_"));
  return `${stem}${extension}`;
}

function buildWavDownloadName(songName: string, clipName: string): string {
  const stem = sanitizeFilenameStem(`${songName}_${clipName}`.replace(/\s+/g, "_"));
  return `${stem}.wav`;
}

function buildContentDisposition(downloadName: string): string {
  const encoded = encodeURIComponent(downloadName);
  return `attachment; filename*=UTF-8''${encoded}`;
}

export async function GET(
  request: NextRequest,
  context: { params: { slug: string; clipId: string } }
): Promise<NextResponse> {
  try {
    const resolved = await findPublicCollectionClipAudioBySlug({
      slug: context.params.slug,
      clipId: context.params.clipId
    });
    if (!resolved) {
      return NextResponse.json({ error: "Clip no encontrado en la colección" }, { status: 404 });
    }
    if (!resolved.collection.allowDownloads) {
      return NextResponse.json({ error: "Las descargas no están habilitadas para esta colección" }, { status: 403 });
    }

    await access(resolved.audio.path);

    const clipStartsAtZero = resolved.clip.startSec <= 0.001;
    const endsAtSourceEnd =
      resolved.clip.endSec === null ||
      (resolved.audio.durationSec !== null && Math.abs(resolved.clip.endSec - resolved.audio.durationSec) <= 0.05);
    const canUseOriginalFile = clipStartsAtZero && endsAtSourceEnd;

    if (canUseOriginalFile) {
      const downloadName = buildDownloadName(
        resolved.song.name,
        resolved.clip.name,
        resolved.audio.originalName
      );

      return createAudioStreamResponse({
        request,
        filePath: resolved.audio.path,
        contentType: resolved.audio.mimeType,
        downloadName
      });
    }

    const wavBuffer = await renderClipSegmentWavBuffer({
      sourcePath: resolved.audio.path,
      startSec: resolved.clip.startSec,
      endSec: resolved.clip.endSec
    });

    const downloadName = buildWavDownloadName(resolved.song.name, resolved.clip.name);
    return new NextResponse(wavBuffer, {
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(wavBuffer.byteLength),
        "Content-Disposition": buildContentDisposition(downloadName),
        "Cache-Control": "no-store"
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    return NextResponse.json({ error: `No se pudo descargar el audio original: ${message}` }, { status: 500 });
  }
}
