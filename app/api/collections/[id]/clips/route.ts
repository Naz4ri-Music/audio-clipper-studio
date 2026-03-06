import { NextRequest, NextResponse } from "next/server";
import { addClipToCollection } from "@/lib/storage";

export const runtime = "nodejs";

interface Body {
  clipId?: string;
}

export async function POST(
  request: NextRequest,
  context: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const body = (await request.json()) as Body;
    if (!body.clipId) {
      return NextResponse.json({ error: "clipId es obligatorio" }, { status: 400 });
    }

    const item = await addClipToCollection({
      collectionId: context.params.id,
      clipId: body.clipId
    });

    return NextResponse.json({ item });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    return NextResponse.json({ error: `No se pudo añadir el clip: ${message}` }, { status: 500 });
  }
}

