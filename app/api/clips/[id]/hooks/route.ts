import { NextRequest, NextResponse } from "next/server";
import { addHookToClip } from "@/lib/storage";

export const runtime = "nodejs";

interface Body {
  type?: "spoken" | "text";
  text?: string;
  isDisabled?: boolean;
}

export async function POST(
  request: NextRequest,
  context: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const body = (await request.json()) as Body;
    if (body.type !== "spoken" && body.type !== "text") {
      return NextResponse.json({ error: "El tipo de hook es obligatorio" }, { status: 400 });
    }

    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) {
      return NextResponse.json({ error: "El texto del hook es obligatorio" }, { status: 400 });
    }

    const hook = await addHookToClip({
      clipId: context.params.id,
      type: body.type,
      text,
      isDisabled: body.isDisabled === true
    });

    return NextResponse.json({ hook });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    return NextResponse.json({ error: `No se pudo crear el hook: ${message}` }, { status: 500 });
  }
}
