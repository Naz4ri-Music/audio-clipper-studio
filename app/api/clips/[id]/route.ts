import { NextRequest, NextResponse } from "next/server";
import { deleteClipById, updateClip } from "@/lib/storage";

export const runtime = "nodejs";

interface RenameBody {
  name?: string;
  startSec?: number;
  endSec?: number | null;
}

export async function PATCH(
  request: NextRequest,
  context: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const body = (await request.json()) as RenameBody;
    const clip = await updateClip({
      clipId: context.params.id,
      name: typeof body.name === "string" ? body.name : undefined,
      startSec: typeof body.startSec === "number" && Number.isFinite(body.startSec) ? body.startSec : undefined,
      endSec:
        body.endSec === null
          ? null
          : typeof body.endSec === "number" && Number.isFinite(body.endSec)
            ? body.endSec
            : undefined
    });

    return NextResponse.json({ clip });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    return NextResponse.json({ error: `No se pudo actualizar el clip: ${message}` }, { status: 500 });
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
