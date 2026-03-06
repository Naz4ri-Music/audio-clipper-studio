import { NextRequest, NextResponse } from "next/server";
import { deleteCollectionById, updateCollection } from "@/lib/storage";

export const runtime = "nodejs";

interface UpdateBody {
  name?: string;
  slug?: string;
}

export async function PATCH(
  request: NextRequest,
  context: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const body = (await request.json()) as UpdateBody;
    const collection = await updateCollection({
      collectionId: context.params.id,
      name: typeof body.name === "string" ? body.name : undefined,
      slug: typeof body.slug === "string" ? body.slug : undefined
    });

    return NextResponse.json({ collection });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    return NextResponse.json({ error: `No se pudo actualizar la colección: ${message}` }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  context: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const deleted = await deleteCollectionById(context.params.id);
    if (!deleted) {
      return NextResponse.json({ error: "Colección no encontrada" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    return NextResponse.json({ error: `No se pudo eliminar la colección: ${message}` }, { status: 500 });
  }
}

