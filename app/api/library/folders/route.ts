import { NextRequest, NextResponse } from "next/server";
import { createFolder } from "@/lib/storage";

export const runtime = "nodejs";

interface FolderBody {
  name?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as FolderBody;
    const name = typeof body.name === "string" ? body.name.trim() : "";

    if (!name) {
      return NextResponse.json({ error: "El nombre de la carpeta es obligatorio" }, { status: 400 });
    }

    const folder = await createFolder(name);
    return NextResponse.json({ folder });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    return NextResponse.json({ error: `No se pudo crear la carpeta: ${message}` }, { status: 500 });
  }
}
