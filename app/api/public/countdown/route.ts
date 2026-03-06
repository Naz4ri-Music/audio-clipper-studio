import { access } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { createAudioStreamResponse } from "@/lib/audio-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const countdownPath = path.join(process.cwd(), "cuenta atras.wav");

  try {
    await access(countdownPath);
  } catch {
    return NextResponse.json(
      { error: "No existe el archivo 'cuenta atras.wav' en la raíz del proyecto" },
      { status: 404 }
    );
  }

  return createAudioStreamResponse({
    request,
    filePath: countdownPath,
    contentType: "audio/wav"
  });
}

