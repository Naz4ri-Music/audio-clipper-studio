import { NextRequest, NextResponse } from "next/server";
import { removeCollectionClipHook, updateCollectionClipHook } from "@/lib/storage";

export const runtime = "nodejs";

interface Body {
  text?: string;
  isDisabled?: boolean;
}

export async function PATCH(
  request: NextRequest,
  context: { params: { id: string; clipId: string; hookId: string } }
): Promise<NextResponse> {
  try {
    const body = (await request.json()) as Body;
    const hook = await updateCollectionClipHook({
      collectionId: context.params.id,
      clipId: context.params.clipId,
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
  context: { params: { id: string; clipId: string; hookId: string } }
): Promise<NextResponse> {
  try {
    const removed = await removeCollectionClipHook({
      collectionId: context.params.id,
      clipId: context.params.clipId,
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
