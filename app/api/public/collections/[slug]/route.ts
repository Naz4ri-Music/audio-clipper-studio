import { NextResponse } from "next/server";
import { getPublicCollectionBySlug } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(
  _request: Request,
  context: { params: { slug: string } }
): Promise<NextResponse> {
  try {
    const collection = await getPublicCollectionBySlug(context.params.slug);
    if (!collection) {
      return NextResponse.json({ error: "Colección no encontrada" }, { status: 404 });
    }

    return NextResponse.json(
      { collection },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate"
        }
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    return NextResponse.json({ error: `No se pudo cargar la colección pública: ${message}` }, { status: 500 });
  }
}

