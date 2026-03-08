import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-static";
export const revalidate = 60 * 60 * 24;

const SAMPLE_RATE = 22050;
const DURATION_SEC = 45;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

function buildShieldWav(): Buffer {
  const frameCount = SAMPLE_RATE * DURATION_SEC;
  const bytesPerSample = BITS_PER_SAMPLE / 8;
  const dataSize = frameCount * CHANNELS * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * CHANNELS * bytesPerSample, 28);
  buffer.writeUInt16LE(CHANNELS * bytesPerSample, 32);
  buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Ultra-low-level noise keeps audio session alive while remaining imperceptible.
  let seed = 0x1234abcd;
  for (let i = 0; i < frameCount; i += 1) {
    seed = (1664525 * seed + 1013904223) >>> 0;
    const random = (seed / 0xffffffff) * 2 - 1;
    const sample = Math.trunc(random * 2);
    buffer.writeInt16LE(sample, 44 + i * bytesPerSample);
  }

  return buffer;
}

const SHIELD_WAV = buildShieldWav();

export async function GET(): Promise<NextResponse> {
  return new NextResponse(SHIELD_WAV, {
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(SHIELD_WAV.byteLength),
      "Cache-Control": "public, max-age=86400, immutable"
    }
  });
}
