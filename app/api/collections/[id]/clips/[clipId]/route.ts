import { NextRequest, NextResponse } from "next/server";
import { removeClipFromCollection } from "@/lib/storage";

export const runtime = "nodejs";

export async function DELETE(
  _request: NextRequest,
  context: { params: { id: string; clipId: string } }
): Promise<NextResponse> {
  try {
    const removed = await removeClipFromCollection({
      collectionId: context.params.id,
      clipId: context.params.clipId
    });

    if (!removed) {
      return NextResponse.json({ error: "El clip no está en la colección" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    return NextResponse.json({ error: `No se pudo eliminar el clip de la colección: ${message}` }, { status: 500 });
  }
}

