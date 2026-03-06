import { access } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { createAudioStreamResponse } from "@/lib/audio-response";
import { findAudioById } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(
  request: NextRequest,
  context: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const record = await findAudioById(context.params.id);

    if (!record) {
      return NextResponse.json({ error: "Audio no encontrado" }, { status: 404 });
    }

    await access(record.path);

    const shouldDownload = request.nextUrl.searchParams.get("download") === "1";
    const requestedName = request.nextUrl.searchParams.get("name") || record.originalName;

    return createAudioStreamResponse({
      request,
      filePath: record.path,
      contentType: record.mimeType,
      downloadName: shouldDownload ? requestedName : undefined
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    return NextResponse.json({ error: `No se pudo leer el archivo: ${message}` }, { status: 500 });
  }
}
