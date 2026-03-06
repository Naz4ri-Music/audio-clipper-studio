import { NextRequest, NextResponse } from "next/server";
import { deleteSongById, renameSong } from "@/lib/storage";

export const runtime = "nodejs";

interface SongBody {
  name?: string;
}

export async function PATCH(
  request: NextRequest,
  context: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const body = (await request.json()) as SongBody;
    const name = typeof body.name === "string" ? body.name : "";

    const song = await renameSong({
      songId: context.params.id,
      name
    });

    return NextResponse.json({ song });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    return NextResponse.json({ error: `No se pudo renombrar la canción: ${message}` }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  context: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const deleted = await deleteSongById(context.params.id);
    if (!deleted) {
      return NextResponse.json({ error: "Canción no encontrada" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    return NextResponse.json({ error: `No se pudo eliminar la canción: ${message}` }, { status: 500 });
  }
}
