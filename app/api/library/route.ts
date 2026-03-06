import { NextResponse } from "next/server";
import { getLibraryData } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  try {
    const library = await getLibraryData();
    return NextResponse.json({ library });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    return NextResponse.json({ error: `No se pudo cargar la biblioteca: ${message}` }, { status: 500 });
  }
}
