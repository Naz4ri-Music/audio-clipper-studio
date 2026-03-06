import { NextRequest, NextResponse } from "next/server";
import { deleteClipById, renameClip } from "@/lib/storage";

export const runtime = "nodejs";

interface RenameBody {
  name?: string;
}

export async function PATCH(
  request: NextRequest,
  context: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const body = (await request.json()) as RenameBody;
    const name = typeof body.name === "string" ? body.name : "";

    const clip = await renameClip({
      clipId: context.params.id,
      name
    });

    return NextResponse.json({ clip });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    return NextResponse.json({ error: `No se pudo renombrar el clip: ${message}` }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  context: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const deleted = await deleteClipById(context.params.id);

    if (!deleted) {
      return NextResponse.json({ error: "Clip no encontrado" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    return NextResponse.json({ error: `No se pudo eliminar el clip: ${message}` }, { status: 500 });
  }
}
