import { NextRequest, NextResponse } from "next/server";
import { createCollection, getCollectionsData } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

interface CreateBody {
  name?: string;
  slug?: string | null;
}

export async function GET(): Promise<NextResponse> {
  try {
    const collections = await getCollectionsData();
    return NextResponse.json(
      { collections },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate"
        }
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    return NextResponse.json({ error: `No se pudieron cargar las colecciones: ${message}` }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as CreateBody;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const slug = typeof body.slug === "string" ? body.slug : null;

    if (!name) {
      return NextResponse.json({ error: "El nombre de la colección es obligatorio" }, { status: 400 });
    }

    const collection = await createCollection({ name, slug });
    return NextResponse.json({ collection });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    return NextResponse.json({ error: `No se pudo crear la colección: ${message}` }, { status: 500 });
  }
}

