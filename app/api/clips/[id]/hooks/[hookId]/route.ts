import { NextRequest, NextResponse } from "next/server";
import { removeClipHook, updateClipHook } from "@/lib/storage";

export const runtime = "nodejs";

interface Body {
  text?: string;
  isDisabled?: boolean;
}

export async function PATCH(
  request: NextRequest,
  context: { params: { id: string; hookId: string } }
): Promise<NextResponse> {
  try {
    const body = (await request.json()) as Body;
    const hook = await updateClipHook({
      clipId: context.params.id,
      hookId: context.params.hookId,
      text: typeof body.text === "string" ? body.text : undefined,
      isDisabled: typeof body.isDisabled === "boolean" ? body.isDisabled : undefined
    });

    return NextResponse.json({ hook });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    return NextResponse.json({ error: `No se pudo actualizar el hook: ${message}` }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  context: { params: { id: string; hookId: string } }
): Promise<NextResponse> {
  try {
    const removed = await removeClipHook({
      clipId: context.params.id,
      hookId: context.params.hookId
    });

    if (!removed) {
      return NextResponse.json({ error: "Hook no encontrado" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    return NextResponse.json({ error: `No se pudo eliminar el hook: ${message}` }, { status: 500 });
  }
}
