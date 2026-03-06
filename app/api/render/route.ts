import { stat } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { withBasePath } from "@/lib/base-path";
import { BinaryExecutionError, renderClip } from "@/lib/ffmpeg";
import {
  addGeneratedAudio,
  findAudioById,
  getGeneratedDir,
  sanitizeFilenameStem,
  SourceType
} from "@/lib/storage";

export const runtime = "nodejs";

interface RenderBody {
  sourceId?: string;
  clipName?: string;
  startSec?: number;
  endSec?: number | null;
  includeCountdown?: boolean;
  delaySec?: number;
}

function isValidNumber(input: unknown): input is number {
  return typeof input === "number" && Number.isFinite(input);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as RenderBody;

    if (!body.sourceId) {
      return NextResponse.json({ error: "Falta sourceId" }, { status: 400 });
    }

    const sourceRecord = await findAudioById(body.sourceId);
    if (!sourceRecord) {
      return NextResponse.json({ error: "Audio origen no encontrado" }, { status: 404 });
    }

    const startSec = isValidNumber(body.startSec) ? Math.max(0, body.startSec) : 0;
    const endSec = body.endSec === null ? null : isValidNumber(body.endSec) ? Math.max(body.endSec, startSec) : null;
    const includeCountdown = Boolean(body.includeCountdown);
    const delaySec = isValidNumber(body.delaySec) ? Math.max(0, Math.floor(body.delaySec)) : 0;

    const outputStem = sanitizeFilenameStem(body.clipName || "clip");
    const countdownPath = path.join(process.cwd(), "cuenta atras.wav");

    const renderedPath = await renderClip({
      sourcePath: sourceRecord.path,
      startSec,
      endSec,
      includeCountdown,
      delaySec,
      countdownPath,
      outputDir: getGeneratedDir(),
      outputStem
    });

    const outputStats = await stat(renderedPath);
    const outputName = `${outputStem}.mp3`;

    const generated = await addGeneratedAudio({
      sourceType: sourceRecord.sourceType as SourceType,
      path: renderedPath,
      mimeType: "audio/mpeg",
      originalName: outputName,
      sizeBytes: outputStats.size
    });

    const downloadName = encodeURIComponent(generated.originalName);

    return NextResponse.json({
      audio: {
        id: generated.id,
        name: generated.originalName,
        url: withBasePath(`/api/files/${generated.id}?download=1&name=${downloadName}`)
      }
    });
  } catch (error) {
    if (error instanceof BinaryExecutionError) {
      return NextResponse.json(
        {
          error:
            "No se pudo procesar el audio con ffmpeg/ffprobe. Verifica que estén instalados y accesibles desde terminal."
        },
        { status: 500 }
      );
    }

    const message = error instanceof Error ? error.message : "Error inesperado";
    return NextResponse.json({ error: `No se pudo renderizar el clip: ${message}` }, { status: 500 });
  }
}
