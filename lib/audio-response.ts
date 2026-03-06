import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";

function parseRange(rangeHeader: string, fileSize: number): { start: number; end: number } | null {
  const matches = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!matches) {
    return null;
  }

  const startRaw = matches[1];
  const endRaw = matches[2];

  const start = startRaw ? Number.parseInt(startRaw, 10) : 0;
  const end = endRaw ? Number.parseInt(endRaw, 10) : fileSize - 1;

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end >= fileSize) {
    return null;
  }

  return { start, end };
}

function buildContentDisposition(downloadName: string): string {
  const encoded = encodeURIComponent(downloadName);
  return `attachment; filename*=UTF-8''${encoded}`;
}

export async function createAudioStreamResponse(params: {
  request: NextRequest;
  filePath: string;
  contentType: string;
  downloadName?: string;
}): Promise<NextResponse> {
  const fileStats = await stat(params.filePath);
  const rangeHeader = params.request.headers.get("range");

  if (rangeHeader) {
    const parsed = parseRange(rangeHeader, fileStats.size);

    if (!parsed) {
      return new NextResponse("Range inválido", {
        status: 416,
        headers: {
          "Content-Range": `bytes */${fileStats.size}`
        }
      });
    }

    const stream = createReadStream(params.filePath, { start: parsed.start, end: parsed.end });
    const headers = new Headers({
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${parsed.start}-${parsed.end}/${fileStats.size}`,
      "Content-Length": String(parsed.end - parsed.start + 1),
      "Content-Type": params.contentType,
      "Cache-Control": "no-store"
    });

    if (params.downloadName) {
      headers.set("Content-Disposition", buildContentDisposition(params.downloadName));
    }

    return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers
    });
  }

  const stream = createReadStream(params.filePath);
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Content-Length": String(fileStats.size),
    "Content-Type": params.contentType,
    "Cache-Control": "no-store"
  });

  if (params.downloadName) {
    headers.set("Content-Disposition", buildContentDisposition(params.downloadName));
  }

  return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
    headers
  });
}
