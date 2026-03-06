import { NextRequest, NextResponse } from "next/server";
import { createSongClip } from "@/lib/storage";

export const runtime = "nodejs";

interface ClipBody {
  songId?: string;
  sourceAudioId?: string;
  name?: string;
  startSec?: number;
  endSec?: number | null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as ClipBody;

    if (!body.songId || !body.sourceAudioId) {
      return NextResponse.json({ error: "songId y sourceAudioId son obligatorios" }, { status: 400 });
    }

    const clip = await createSongClip({
      songId: body.songId,
      sourceAudioId: body.sourceAudioId,
      name: typeof body.name === "string" ? body.name : "Clip",
      startSec: typeof body.startSec === "number" && Number.isFinite(body.startSec) ? body.startSec : 0,
      endSec: numberOrNull(body.endSec)
    });

    return NextResponse.json({ clip });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    return NextResponse.json({ error: `No se pudo crear el clip: ${message}` }, { status: 500 });
  }
}
