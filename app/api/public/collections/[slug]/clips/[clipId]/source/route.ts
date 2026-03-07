import { access } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { createAudioStreamResponse } from "@/lib/audio-response";
import { findPublicCollectionClipAudioBySlug } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

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

    await access(resolved.audio.path);
    return createAudioStreamResponse({
      request,
      filePath: resolved.audio.path,
      contentType: resolved.audio.mimeType
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    return NextResponse.json({ error: `No se pudo leer el audio de la colección: ${message}` }, { status: 500 });
  }
}
