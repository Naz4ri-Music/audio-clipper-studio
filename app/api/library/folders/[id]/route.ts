import { NextRequest, NextResponse } from "next/server";
import { deleteFolderById, renameFolder } from "@/lib/storage";

export const runtime = "nodejs";

interface FolderBody {
  name?: string;
}

export async function PATCH(
  request: NextRequest,
  context: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const body = (await request.json()) as FolderBody;
    const name = typeof body.name === "string" ? body.name : "";

    const folder = await renameFolder({
      folderId: context.params.id,
      name
    });

    return NextResponse.json({ folder });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    return NextResponse.json({ error: `No se pudo renombrar la carpeta: ${message}` }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  context: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const deleted = await deleteFolderById(context.params.id);
    if (!deleted) {
      return NextResponse.json({ error: "Carpeta no encontrada" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    return NextResponse.json({ error: `No se pudo eliminar la carpeta: ${message}` }, { status: 500 });
  }
}
