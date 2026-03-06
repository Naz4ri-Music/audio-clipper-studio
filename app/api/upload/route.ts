import { NextRequest, NextResponse } from "next/server";
import { withBasePath } from "@/lib/base-path";
import { probeDurationSec } from "@/lib/ffmpeg";
import {
  registerUploadedAudioToSong,
  saveUploadedAudio,
  setAudioDuration,
  SourceType
} from "@/lib/storage";

export const runtime = "nodejs";

function normalizeSourceType(value: FormDataEntryValue | null): SourceType {
  return value === "clip" ? "clip" : "master";
}

function asOptionalString(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const formData = await request.formData();
    const file = formData.get("audio");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No se encontró el archivo de audio" }, { status: 400 });
    }

    if (!file.type.startsWith("audio/")) {
      return NextResponse.json({ error: "El archivo debe ser un audio válido" }, { status: 400 });
    }

    const sourceType = normalizeSourceType(formData.get("sourceType"));
    const songId = asOptionalString(formData.get("songId"));
    const songName = asOptionalString(formData.get("songName"));
    const folderId = asOptionalString(formData.get("folderId"));
    const clipName = asOptionalString(formData.get("clipName"));

    const record = await saveUploadedAudio(file, sourceType);
    const durationSec = await probeDurationSec(record.path);
    await setAudioDuration(record.id, durationSec);

    const linked = await registerUploadedAudioToSong({
      songId,
      songName,
      folderId,
      sourceType,
      audioId: record.id,
      clipName,
      clipEndSec: sourceType === "clip" ? durationSec : null
    });

    return NextResponse.json({
      audio: {
        id: record.id,
        name: record.originalName,
        url: withBasePath(`/api/files/${record.id}`),
        sourceType,
        durationSec
      },
      song: {
        id: linked.song.id,
        name: linked.song.name
      },
      clipId: linked.clipId
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    return NextResponse.json({ error: `No se pudo subir el audio: ${message}` }, { status: 500 });
  }
}
