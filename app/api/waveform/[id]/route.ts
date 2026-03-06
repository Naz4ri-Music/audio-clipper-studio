import { access } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { extractWaveformPeaks, probeDurationSec } from "@/lib/ffmpeg";
import { findAudioById } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

function parseSamples(value: string | null): number {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed)) {
    return 700;
  }
  return Math.min(4000, Math.max(64, parsed));
}

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

    const samples = parseSamples(request.nextUrl.searchParams.get("samples"));
    const [peaks, durationSec] = await Promise.all([
      extractWaveformPeaks({ filePath: record.path, samples }),
      record.durationSec === null ? probeDurationSec(record.path) : Promise.resolve(record.durationSec)
    ]);

    return NextResponse.json(
      {
        peaks,
        durationSec
      },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate"
        }
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    return NextResponse.json({ error: `No se pudo generar la forma de onda: ${message}` }, { status: 500 });
  }
}

