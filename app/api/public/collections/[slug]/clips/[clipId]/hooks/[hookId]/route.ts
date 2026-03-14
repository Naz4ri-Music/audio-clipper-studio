import { NextRequest, NextResponse } from "next/server";
import { updatePublicCollectionHookBySlug } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

interface Body {
  isDisabled?: boolean;
}

export async function PATCH(
  request: NextRequest,
  context: { params: { slug: string; clipId: string; hookId: string } }
): Promise<NextResponse> {
  try {
    const body = (await request.json()) as Body;
    if (typeof body.isDisabled !== "boolean") {
      return NextResponse.json({ error: "El estado del hook es obligatorio" }, { status: 400 });
    }

    const hook = await updatePublicCollectionHookBySlug({
      slug: context.params.slug,
      clipId: context.params.clipId,
      hookId: context.params.hookId,
      isDisabled: body.isDisabled
    });

    return NextResponse.json({ hook });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    return NextResponse.json({ error: `No se pudo actualizar el hook: ${message}` }, { status: 500 });
  }
}
