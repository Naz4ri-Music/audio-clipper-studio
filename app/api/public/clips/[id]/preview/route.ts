import { NextRequest, NextResponse } from "next/server";
import { createAudioStreamResponse } from "@/lib/audio-response";
import { ensurePublicClipPreview } from "@/lib/public-preview";
import { findAudioById, findClipById } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(
  request: NextRequest,
  context: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const clip = await findClipById(context.params.id);
    if (!clip) {
      return NextResponse.json({ error: "Clip no encontrado" }, { status: 404 });
    }

    const source = await findAudioById(clip.sourceAudioId);
    if (!source) {
      return NextResponse.json({ error: "Audio origen no encontrado" }, { status: 404 });
    }

    const previewPath = await ensurePublicClipPreview({
      clip,
      sourcePath: source.path
    });

    return createAudioStreamResponse({
      request,
      filePath: previewPath,
      contentType: "audio/mp4"
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    return NextResponse.json({ error: `No se pudo generar el preview público: ${message}` }, { status: 500 });
  }
}
