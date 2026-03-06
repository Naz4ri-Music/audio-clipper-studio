import { NextRequest, NextResponse } from "next/server";
import { moveSongToFolder } from "@/lib/storage";

export const runtime = "nodejs";

interface MoveBody {
  folderId?: string | null;
}

export async function POST(
  request: NextRequest,
  context: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const body = (await request.json()) as MoveBody;
    const folderId = typeof body.folderId === "string" ? body.folderId : body.folderId === null ? null : null;

    const song = await moveSongToFolder({
      songId: context.params.id,
      folderId
    });

    return NextResponse.json({ song });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    return NextResponse.json({ error: `No se pudo mover la canción: ${message}` }, { status: 500 });
  }
}
