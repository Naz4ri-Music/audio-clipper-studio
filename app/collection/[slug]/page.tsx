"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { withBasePath } from "@/lib/base-path";

type PlaybackPhase = "idle" | "loading" | "delay" | "countdown" | "clip";

interface PublicCollectionClip {
  id: string;
  clipId: string;
  songId: string;
  songName: string;
  clipName: string;
  sourceId: string;
  url: string;
  playbackUrl?: string;
  startSec: number;
  endSec: number | null;
  sortOrder: number;
}

interface PublicCollection {
  id: string;
  name: string;
  slug: string;
  clips: PublicCollectionClip[];
}

interface PlaybackState {
  clipId: string | null;
  phase: PlaybackPhase;
  remainingDelay: number;
}

interface PlaybackRuntime {
  sources: AudioBufferSourceNode[];
  timeoutIds: number[];
  intervalId: number | null;
}

interface AudioSessionLike {
  type?: string;
}

const IDLE_PLAYBACK: PlaybackState = {
  clipId: null,
  phase: "idle",
  remainingDelay: 0
};

function formatSeconds(totalSeconds: number | null): string {
  if (totalSeconds === null || !Number.isFinite(totalSeconds)) {
    return "--:--";
  }

  const seconds = Math.max(0, Math.floor(totalSeconds));
  const mm = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const ss = (seconds % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function fetchWithTimeout(url: string, timeoutMs = 45000): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(withBasePath(url), {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal
    });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export default function CollectionPage(props: { params: { slug: string } }): JSX.Element {
  const [collection, setCollection] = useState<PublicCollection | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [useCountdown, setUseCountdown] = useState(true);
  const [delaySec, setDelaySec] = useState(0);
  const [playback, setPlayback] = useState<PlaybackState>(IDLE_PLAYBACK);

  const playbackControllerRef = useRef<AbortController | null>(null);
  const playbackRuntimeRef = useRef<PlaybackRuntime | null>(null);
  const playbackContextRef = useRef<AudioContext | null>(null);
  const audioBufferCacheRef = useRef<Map<string, Promise<AudioBuffer>>>(new Map());

  const orderedClips = useMemo(
    () => [...(collection?.clips ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
    [collection?.clips]
  );

  const clearPlaybackRuntime = useCallback(() => {
    const runtime = playbackRuntimeRef.current;
    if (!runtime) {
      return;
    }

    runtime.timeoutIds.forEach((id) => window.clearTimeout(id));
    if (runtime.intervalId !== null) {
      window.clearInterval(runtime.intervalId);
    }

    runtime.sources.forEach((source) => {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Ignore.
      }
      source.disconnect();
    });

    playbackRuntimeRef.current = null;
  }, []);

  const stopPlayback = useCallback(() => {
    playbackControllerRef.current?.abort();
    playbackControllerRef.current = null;
    clearPlaybackRuntime();
    setPlayback(IDLE_PLAYBACK);
  }, [clearPlaybackRuntime]);

  const getPlaybackContext = useCallback((): AudioContext => {
    const existing = playbackContextRef.current;
    if (existing) {
      return existing;
    }

    const created = new AudioContext();
    playbackContextRef.current = created;
    return created;
  }, []);

  const unlockPlaybackContext = useCallback(async (): Promise<AudioContext> => {
    // On iOS Safari this can force media playback even when the hardware silent switch is enabled.
    const navWithSession = navigator as Navigator & { audioSession?: AudioSessionLike };
    try {
      if (navWithSession.audioSession) {
        navWithSession.audioSession.type = "playback";
      }
    } catch {
      // Ignore if not supported or blocked by the browser.
    }

    const context = getPlaybackContext();
    if (context.state !== "running") {
      await context.resume();
    }

    // iOS Safari can require a real source start on user gesture to fully unlock audio output.
    const unlockSource = context.createBufferSource();
    unlockSource.buffer = context.createBuffer(1, 1, context.sampleRate);
    unlockSource.connect(context.destination);
    unlockSource.start();
    unlockSource.stop(context.currentTime + 0.001);
    unlockSource.disconnect();

    return context;
  }, [getPlaybackContext]);

  const getCachedAudioBuffer = useCallback(
    (cacheKey: string, url: string): Promise<AudioBuffer> => {
      const cached = audioBufferCacheRef.current.get(cacheKey);
      if (cached) {
        return cached;
      }

      const loadPromise = (async () => {
        const response = await fetchWithTimeout(url, 45000);
        if (!response.ok) {
          throw new Error(`No se pudo cargar audio (${response.status}).`);
        }
        const buffer = await response.arrayBuffer();
        return getPlaybackContext().decodeAudioData(buffer.slice(0));
      })();

      audioBufferCacheRef.current.set(cacheKey, loadPromise);
      void loadPromise.catch(() => {
        const current = audioBufferCacheRef.current.get(cacheKey);
        if (current === loadPromise) {
          audioBufferCacheRef.current.delete(cacheKey);
        }
      });

      return loadPromise;
    },
    [getPlaybackContext]
  );

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setErrorMessage(null);

    void fetchWithTimeout(`/api/public/collections/${props.params.slug}`, 15000)
      .then(async (response) => {
        const data = (await response.json()) as {
          collection?: PublicCollection;
          error?: string;
        };
        if (!response.ok || !data.collection) {
          throw new Error(data.error || "No se pudo cargar la colección");
        }
        if (!cancelled) {
          setCollection(data.collection);
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setErrorMessage(error instanceof Error ? error.message : "Error inesperado");
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [props.params.slug]);

  useEffect(() => {
    if (!useCountdown) {
      return;
    }
    void getCachedAudioBuffer("countdown", "/api/public/countdown").catch(() => {
      // Preload best effort.
    });
  }, [getCachedAudioBuffer, useCountdown]);

  useEffect(() => {
    if (!orderedClips.length) {
      return;
    }

    let cancelled = false;
    const prebuffer = async (): Promise<void> => {
      for (const clip of orderedClips) {
        if (cancelled) {
          break;
        }
        const clipPlaybackUrl = clip.playbackUrl || clip.url;
        try {
          await getCachedAudioBuffer(`audio:${clip.clipId}`, clipPlaybackUrl);
        } catch {
          // Best effort cache.
        }
      }
    };

    void prebuffer();
    return () => {
      cancelled = true;
    };
  }, [getCachedAudioBuffer, orderedClips]);

  useEffect(() => {
    return () => {
      stopPlayback();
      audioBufferCacheRef.current.clear();
      const context = playbackContextRef.current;
      playbackContextRef.current = null;
      if (context) {
        void context.close().catch(() => {
          // Ignore.
        });
      }
    };
  }, [stopPlayback]);

  const playClip = useCallback(
    async (clip: PublicCollectionClip) => {
      stopPlayback();
      setErrorMessage(null);
      setPlayback({
        clipId: clip.clipId,
        phase: "loading",
        remainingDelay: 0
      });

      const controller = new AbortController();
      playbackControllerRef.current = controller;
      const signal = controller.signal;

      const runtime: PlaybackRuntime = {
        sources: [],
        timeoutIds: [],
        intervalId: null
      };
      playbackRuntimeRef.current = runtime;

      const context = await unlockPlaybackContext();
      try {
        if (context.state !== "running") {
          throw new Error("Pulsa Play de nuevo para activar el audio del navegador.");
        }
      } catch {
        throw new Error("No se pudo activar el audio en este dispositivo.");
      }

      const setPlaybackIfActive = (next: PlaybackState) => {
        if (playbackControllerRef.current === controller) {
          setPlayback(next);
        }
      };

      const scheduleTimeout = (delayMs: number, callback: () => void) => {
        const timeoutId = window.setTimeout(callback, Math.max(0, delayMs));
        runtime.timeoutIds.push(timeoutId);
      };

      try {
        const clipPlaybackUrl = clip.playbackUrl || clip.url;
        let clipBuffer: AudioBuffer;
        try {
          clipBuffer = await getCachedAudioBuffer(`audio:${clip.clipId}`, clipPlaybackUrl);
        } catch (previewError) {
          if (!clip.playbackUrl || clipPlaybackUrl === clip.url) {
            throw previewError;
          }
          clipBuffer = await getCachedAudioBuffer(`audio:${clip.clipId}:fallback`, clip.url);
        }
        if (signal.aborted) {
          throw new DOMException("Cancelled", "AbortError");
        }

        let countdownBuffer: AudioBuffer | null = null;
        let countdownDurationSec = 0;
        if (useCountdown) {
          countdownBuffer = await getCachedAudioBuffer("countdown", "/api/public/countdown");
          countdownDurationSec = countdownBuffer.duration;
        }

        if (signal.aborted) {
          throw new DOMException("Cancelled", "AbortError");
        }

        const usesTrimmedPreview = Boolean(clip.playbackUrl);
        const clipStartSec = usesTrimmedPreview
          ? 0
          : clamp(clip.startSec, 0, Math.max(0, clipBuffer.duration - 0.01));
        const requestedClipEndSec =
          usesTrimmedPreview || clip.endSec === null
            ? clipBuffer.duration
            : Math.max(clip.endSec, clipStartSec + 0.01);
        const clipEndSec = clamp(requestedClipEndSec, clipStartSec + 0.01, clipBuffer.duration);
        const clipDurationSec = Math.max(0.01, clipEndSec - clipStartSec);

        const playbackStartAt = context.currentTime + delaySec;
        const clipStartAt = playbackStartAt + countdownDurationSec;

        if (delaySec > 0) {
          setPlaybackIfActive({
            clipId: clip.clipId,
            phase: "delay",
            remainingDelay: Math.max(1, Math.ceil(delaySec))
          });

          runtime.intervalId = window.setInterval(() => {
            if (signal.aborted || playbackControllerRef.current !== controller) {
              return;
            }
            const remaining = Math.max(0, Math.ceil(playbackStartAt - context.currentTime));
            if (remaining <= 0) {
              if (runtime.intervalId !== null) {
                window.clearInterval(runtime.intervalId);
                runtime.intervalId = null;
              }
              return;
            }
            setPlayback({
              clipId: clip.clipId,
              phase: "delay",
              remainingDelay: remaining
            });
          }, 120);

          scheduleTimeout(delaySec * 1000, () => {
            setPlaybackIfActive({
              clipId: clip.clipId,
              phase: useCountdown ? "countdown" : "clip",
              remainingDelay: 0
            });
          });
        } else {
          setPlaybackIfActive({
            clipId: clip.clipId,
            phase: useCountdown ? "countdown" : "clip",
            remainingDelay: 0
          });
        }

        if (useCountdown) {
          scheduleTimeout((delaySec + countdownDurationSec) * 1000, () => {
            setPlaybackIfActive({
              clipId: clip.clipId,
              phase: "clip",
              remainingDelay: 0
            });
          });
        }

        if (context.state !== "running") {
          await context.resume();
        }

        if (countdownBuffer) {
          const countdownSource = context.createBufferSource();
          countdownSource.buffer = countdownBuffer;
          countdownSource.connect(context.destination);
          runtime.sources.push(countdownSource);
          countdownSource.start(playbackStartAt, 0, countdownDurationSec);
        }

        const clipSource = context.createBufferSource();
        clipSource.buffer = clipBuffer;
        clipSource.connect(context.destination);
        runtime.sources.push(clipSource);

        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            signal.removeEventListener("abort", onAbort);
            reject(new DOMException("Cancelled", "AbortError"));
          };

          signal.addEventListener("abort", onAbort, { once: true });
          clipSource.onended = () => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          };

          clipSource.start(clipStartAt, clipStartSec, clipDurationSec);
        });
      } catch (error) {
        if (!isAbortError(error)) {
          setErrorMessage(error instanceof Error ? error.message : "No se pudo reproducir");
        }
      } finally {
        if (playbackControllerRef.current === controller) {
          playbackControllerRef.current = null;
          clearPlaybackRuntime();
          setPlayback(IDLE_PLAYBACK);
        }
      }
    },
    [clearPlaybackRuntime, delaySec, getCachedAudioBuffer, stopPlayback, unlockPlaybackContext, useCountdown]
  );

  return (
    <main className="studio-shell public-collection-shell">
      <section className="hero-panel">
        <p className="kicker">Colección Pública</p>
        <h1>{collection?.name ?? "Colección"}</h1>
        <p>Play/Stop de clips para grabar contenido rápido con delay y cuenta atrás opcional.</p>
      </section>

      <section className="panel settings-panel">
        <h2>Ajustes globales</h2>
        <label className="checkbox-line">
          <input type="checkbox" checked={useCountdown} onChange={(event) => setUseCountdown(event.target.checked)} />
          Reproducir cuenta atrás antes del clip
        </label>

        <label className="field-label" htmlFor="public-delay">
          Delay extra (segundos)
        </label>
        <input
          id="public-delay"
          type="number"
          min={0}
          step={1}
          className="number-input"
          value={delaySec}
          onChange={(event) => {
            const next = Number.parseInt(event.target.value, 10);
            setDelaySec(Number.isFinite(next) && next >= 0 ? next : 0);
          }}
        />
      </section>

      <section className="panel">
        <h2>Clips</h2>
        {isLoading && <p className="small-note">Cargando colección...</p>}
        {!isLoading && orderedClips.length === 0 && <p className="small-note">No hay clips en esta colección.</p>}

        {orderedClips.length > 0 && (
          <div className="clip-list">
            {orderedClips.map((clip) => {
              const isCurrent = playback.clipId === clip.clipId && playback.phase !== "idle";
              const duration = clip.endSec === null ? null : Math.max(0, clip.endSec - clip.startSec);
              const status =
                isCurrent && playback.phase === "loading"
                  ? "Cargando audio..."
                  : isCurrent && playback.phase === "delay"
                    ? `Empieza en ${playback.remainingDelay}...`
                    : isCurrent && playback.phase === "countdown"
                      ? "Reproduciendo cuenta atrás..."
                      : isCurrent && playback.phase === "clip"
                        ? "Reproduciendo clip..."
                        : null;

              return (
                <article className="clip-card" key={clip.id}>
                  <div className="clip-head">
                    <h3>{clip.clipName}</h3>
                    <small>{clip.songName}</small>
                  </div>
                  <p className="clip-meta-row">
                    Inicio: <strong>{clip.startSec.toFixed(2)}s</strong> · Fin:{" "}
                    <strong>{clip.endSec?.toFixed(2) ?? "final"}s</strong> · Duración:{" "}
                    <strong>{formatSeconds(duration)}</strong>
                    {status && <span className="playback-pill inline">{status}</span>}
                  </p>
                  <div className="clip-actions">
                    {isCurrent ? (
                      <button type="button" className="btn btn-warning" onClick={stopPlayback}>
                        Stop
                      </button>
                    ) : (
                      <button type="button" className="btn btn-primary" onClick={() => void playClip(clip)}>
                        Play
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {errorMessage && (
        <section className="panel feedback-panel">
          <p className="error-text">{errorMessage}</p>
        </section>
      )}
    </main>
  );
}
