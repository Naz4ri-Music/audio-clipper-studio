"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { withBasePath } from "@/lib/base-path";
import { copyTextToClipboard } from "@/lib/clipboard";

type PlaybackPhase = "idle" | "loading" | "delay" | "countdown" | "clip";
type CollectionHookType = "spoken" | "text";

interface PublicCollectionClip {
  id: string;
  clipId: string;
  songId: string;
  songName: string;
  clipName: string;
  sourceId: string;
  url: string;
  playbackUrl?: string;
  downloadUrl: string;
  startSec: number;
  endSec: number | null;
  sortOrder: number;
  hooks: PublicCollectionHook[];
}

interface PublicCollectionHook {
  id: string;
  type: CollectionHookType;
  text: string;
  isDisabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface PublicCollection {
  id: string;
  name: string;
  slug: string;
  allowDownloads: boolean;
  allowHooks: boolean;
  clips: PublicCollectionClip[];
}

interface PlaybackState {
  clipId: string | null;
  phase: PlaybackPhase;
  remainingDelay: number;
}

interface PlaybackRuntime {
  context: AudioContext;
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

function extractFilename(contentDisposition: string | null): string | null {
  if (!contentDisposition) {
    return null;
  }

  const encodedMatch = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition);
  if (encodedMatch?.[1]) {
    try {
      return decodeURIComponent(encodedMatch[1]);
    } catch {
      // Ignore malformed encoding.
    }
  }

  const plainMatch = /filename="?([^";]+)"?/i.exec(contentDisposition);
  return plainMatch?.[1] ?? null;
}

function collectionHookLabel(type: CollectionHookType): string {
  return type === "spoken" ? "Hooks hablados" : "Hooks de texto";
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
  const [showDownloads, setShowDownloads] = useState(false);
  const [showHooks, setShowHooks] = useState(false);
  const [downloadingClipId, setDownloadingClipId] = useState<string | null>(null);
  const [updatingHookId, setUpdatingHookId] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const [playback, setPlayback] = useState<PlaybackState>(IDLE_PLAYBACK);

  const playbackControllerRef = useRef<AbortController | null>(null);
  const playbackRuntimeRef = useRef<PlaybackRuntime | null>(null);
  const audioPayloadCacheRef = useRef<Map<string, Promise<ArrayBuffer>>>(new Map());
  const audioShieldRef = useRef<HTMLAudioElement | null>(null);
  const audioShieldStartedRef = useRef(false);
  const toastTimeoutRef = useRef<number | null>(null);

  const orderedClips = useMemo(
    () => [...(collection?.clips ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
    [collection?.clips]
  );

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
    if (toastTimeoutRef.current !== null) {
      window.clearTimeout(toastTimeoutRef.current);
    }
    toastTimeoutRef.current = window.setTimeout(() => {
      setToastMessage(null);
      toastTimeoutRef.current = null;
    }, 2200);
  }, []);

  const configureAudioSession = useCallback(() => {
    const navWithSession = navigator as Navigator & { audioSession?: AudioSessionLike };
    try {
      if (navWithSession.audioSession) {
        navWithSession.audioSession.type = "playback";
      }
    } catch {
      // Ignore unsupported browsers.
    }
  }, []);

  const shouldUseAudioShield = useCallback((): boolean => {
    if (typeof navigator === "undefined") {
      return false;
    }

    const ua = navigator.userAgent || "";
    const isIOSDevice = /iPad|iPhone|iPod/i.test(ua);
    const isTouchMac = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
    return isIOSDevice || isTouchMac;
  }, []);

  const ensureAudioShield = useCallback((): HTMLAudioElement => {
    const existing = audioShieldRef.current;
    if (existing) {
      return existing;
    }

    const shield = new Audio(withBasePath("/api/public/audio-shield"));
    shield.preload = "auto";
    shield.loop = true;
    shield.volume = 0.00001;
    shield.setAttribute("playsinline", "true");
    audioShieldRef.current = shield;
    return shield;
  }, []);

  const startAudioShield = useCallback(async (): Promise<void> => {
    if (!shouldUseAudioShield()) {
      return;
    }

    configureAudioSession();
    const shield = ensureAudioShield();
    if (!shield.paused) {
      return;
    }

    try {
      await shield.play();
      audioShieldStartedRef.current = true;
    } catch {
      // Requires user gesture; it will be retried on next Play tap.
    }
  }, [configureAudioSession, ensureAudioShield, shouldUseAudioShield]);

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
        // Ignore already-stopped sources.
      }
      source.disconnect();
    });

    const { context } = runtime;
    playbackRuntimeRef.current = null;
    void context.close().catch(() => {
      // Ignore close errors.
    });
  }, []);

  const stopPlayback = useCallback(() => {
    playbackControllerRef.current?.abort();
    playbackControllerRef.current = null;
    clearPlaybackRuntime();
    setPlayback(IDLE_PLAYBACK);
  }, [clearPlaybackRuntime]);

  const getCachedAudioPayload = useCallback((cacheKey: string, url: string): Promise<ArrayBuffer> => {
    const cached = audioPayloadCacheRef.current.get(cacheKey);
    if (cached) {
      return cached;
    }

    const loadPromise = (async () => {
      const response = await fetchWithTimeout(url, 45000);
      if (!response.ok) {
        throw new Error(`No se pudo cargar audio (${response.status}).`);
      }
      return response.arrayBuffer();
    })();

    audioPayloadCacheRef.current.set(cacheKey, loadPromise);
    void loadPromise.catch(() => {
      const current = audioPayloadCacheRef.current.get(cacheKey);
      if (current === loadPromise) {
        audioPayloadCacheRef.current.delete(cacheKey);
      }
    });

    return loadPromise;
  }, []);

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
    if (!collection?.allowDownloads) {
      setShowDownloads(false);
    }
  }, [collection?.allowDownloads]);

  useEffect(() => {
    if (!collection?.allowHooks) {
      setShowHooks(false);
    }
  }, [collection?.allowHooks]);

  useEffect(() => {
    if (!orderedClips.length) {
      return;
    }

    let cancelled = false;
    const warmUp = async (): Promise<void> => {
      await getCachedAudioPayload("countdown", "/api/public/countdown").catch(() => {
        // Best effort cache.
      });
      for (const clip of orderedClips) {
        if (cancelled) {
          break;
        }
        await getCachedAudioPayload(`audio:${clip.clipId}`, clip.playbackUrl || clip.url).catch(() => {
          // Best effort cache.
        });
      }
    };

    void warmUp();
    return () => {
      cancelled = true;
    };
  }, [getCachedAudioPayload, orderedClips]);

  useEffect(() => {
    const onPageShow = () => {
      configureAudioSession();
    };

    const onFocus = () => {
      configureAudioSession();
    };

    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("focus", onFocus);

    return () => {
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("focus", onFocus);
    };
  }, [configureAudioSession]);

  useEffect(() => {
    return () => {
      stopPlayback();
      audioPayloadCacheRef.current.clear();
      if (toastTimeoutRef.current !== null) {
        window.clearTimeout(toastTimeoutRef.current);
      }
      const shield = audioShieldRef.current;
      if (shield) {
        shield.pause();
        shield.src = "";
        shield.load();
      }
      audioShieldRef.current = null;
      audioShieldStartedRef.current = false;
    };
  }, [stopPlayback]);

  const downloadClip = useCallback(
    async (clip: PublicCollectionClip) => {
      if (!collection?.allowDownloads) {
        return;
      }

      setDownloadingClipId(clip.clipId);
      setErrorMessage(null);

      try {
        const response = await fetchWithTimeout(clip.downloadUrl, 60000);
        if (!response.ok) {
          const details = await response.text();
          throw new Error(
            `No se pudo descargar el audio (${response.status})${details ? `: ${details.slice(0, 120)}` : ""}`
          );
        }

        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        const fallbackName = `${clip.songName}_${clip.clipName}.mp3`;
        const filename = extractFilename(response.headers.get("content-disposition")) || fallbackName;

        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();

        window.setTimeout(() => {
          URL.revokeObjectURL(objectUrl);
        }, 2000);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "No se pudo descargar el audio");
      } finally {
        setDownloadingClipId(null);
      }
    },
    [collection?.allowDownloads]
  );

  const copyHook = useCallback(
    async (hookText: string) => {
      try {
        await copyTextToClipboard(hookText);
        showToast("Hook copiado");
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "No se pudo copiar el hook");
        showToast("No se pudo copiar");
      }
    },
    [showToast]
  );

  const toggleHookDisabled = useCallback(
    async (clip: PublicCollectionClip, hook: PublicCollectionHook, isDisabled: boolean) => {
      if (!collection?.allowHooks) {
        return;
      }

      setUpdatingHookId(hook.id);
      setErrorMessage(null);

      try {
        const response = await fetch(withBasePath(`/api/public/collections/${props.params.slug}/clips/${clip.clipId}/hooks/${hook.id}`), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isDisabled })
        });
        const data = (await response.json()) as { hook?: { id: string; isDisabled: boolean }; error?: string };
        if (!response.ok || !data.hook) {
          throw new Error(data.error || "No se pudo actualizar el hook");
        }

        setCollection((current) => {
          if (!current) {
            return current;
          }

          return {
            ...current,
            clips: current.clips.map((currentClip) =>
              currentClip.clipId !== clip.clipId
                ? currentClip
                : {
                    ...currentClip,
                    hooks: currentClip.hooks.map((currentHook) =>
                      currentHook.id === hook.id ? { ...currentHook, isDisabled: data.hook!.isDisabled } : currentHook
                    )
                  }
            )
          };
        });
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "No se pudo actualizar el hook");
      } finally {
        setUpdatingHookId(null);
      }
    },
    [collection?.allowHooks, props.params.slug]
  );

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
        context: new AudioContext(),
        sources: [],
        timeoutIds: [],
        intervalId: null
      };
      playbackRuntimeRef.current = runtime;
      const context = runtime.context;

      const ensureActive = () => {
        if (signal.aborted || playbackControllerRef.current !== controller) {
          throw new DOMException("Cancelled", "AbortError");
        }
      };

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
        await startAudioShield();
        configureAudioSession();
        if (context.state !== "running") {
          await context.resume();
        }
        ensureActive();

        const decodeBuffer = async (cacheKey: string, url: string): Promise<AudioBuffer> => {
          const payload = await getCachedAudioPayload(cacheKey, url);
          ensureActive();
          return context.decodeAudioData(payload.slice(0));
        };

        const clipPlaybackUrl = clip.playbackUrl || clip.url;
        let clipBuffer: AudioBuffer;
        try {
          clipBuffer = await decodeBuffer(`audio:${clip.clipId}`, clipPlaybackUrl);
        } catch (previewError) {
          if (!clip.playbackUrl || clipPlaybackUrl === clip.url) {
            throw previewError;
          }
          clipBuffer = await decodeBuffer(`audio:${clip.clipId}:fallback`, clip.url);
        }
        ensureActive();

        let countdownBuffer: AudioBuffer | null = null;
        let countdownDurationSec = 0;
        if (useCountdown) {
          countdownBuffer = await decodeBuffer("countdown", "/api/public/countdown");
          countdownDurationSec = countdownBuffer.duration;
          ensureActive();
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
          ensureActive();
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
          const typed = error as { name?: string };
          if (typed?.name === "NotAllowedError") {
            setErrorMessage("Pulsa Play de nuevo para activar el audio en iPhone.");
          } else {
            setErrorMessage(error instanceof Error ? error.message : "No se pudo reproducir");
          }
        }
      } finally {
        if (playbackControllerRef.current === controller) {
          playbackControllerRef.current = null;
          clearPlaybackRuntime();
          setPlayback(IDLE_PLAYBACK);
        }
      }
    },
    [
      clearPlaybackRuntime,
      configureAudioSession,
      delaySec,
      getCachedAudioPayload,
      startAudioShield,
      stopPlayback,
      useCountdown
    ]
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
        <div className="number-stepper">
          <button
            type="button"
            className="btn btn-ghost stepper-btn"
            aria-label="Restar un segundo de delay"
            onClick={() => setDelaySec((current) => Math.max(0, current - 1))}
          >
            -
          </button>
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
          <button
            type="button"
            className="btn btn-ghost stepper-btn"
            aria-label="Sumar un segundo de delay"
            onClick={() => setDelaySec((current) => current + 1)}
          >
            +
          </button>
        </div>

        {collection?.allowDownloads && (
          <label className="checkbox-line">
            <input type="checkbox" checked={showDownloads} onChange={(event) => setShowDownloads(event.target.checked)} />
            Downloads
          </label>
        )}

        {collection?.allowHooks && (
          <label className="checkbox-line">
            <input type="checkbox" checked={showHooks} onChange={(event) => setShowHooks(event.target.checked)} />
            Hooks
          </label>
        )}
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
                    Inicio: <strong>{clip.startSec.toFixed(2)}s</strong> · Fin: <strong>{clip.endSec?.toFixed(2) ?? "final"}s</strong> ·
                    Duración: <strong>{formatSeconds(duration)}</strong>
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

                    {collection?.allowDownloads && showDownloads && (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={downloadingClipId === clip.clipId}
                        onClick={() => void downloadClip(clip)}
                      >
                        {downloadingClipId === clip.clipId ? "Preparando..." : "Descargar"}
                      </button>
                    )}
                  </div>

                  {collection?.allowHooks && showHooks && (
                    <div className="clip-hooks">
                      {(["spoken", "text"] as const).map((hookType) => {
                        const hooks = clip.hooks.filter((hook) => hook.type === hookType);

                        return (
                          <details key={hookType} className="hook-dropdown">
                            <summary>
                              {collectionHookLabel(hookType)} <span className="small-note">({hooks.length})</span>
                            </summary>

                            {hooks.length === 0 ? (
                              <p className="small-note">No hay hooks en este bloque.</p>
                            ) : (
                              <ul className="hook-list">
                                {hooks.map((hook) => (
                                  <li key={hook.id} className={`hook-item ${hook.isDisabled ? "is-disabled" : ""}`}>
                                    <button
                                      type="button"
                                      className="hook-copy-button"
                                      onClick={() => void copyHook(hook.text)}
                                    >
                                      {hook.text}
                                    </button>
                                    <button
                                      type="button"
                                      className="btn btn-ghost"
                                      disabled={updatingHookId === hook.id}
                                      onClick={() => void toggleHookDisabled(clip, hook, !hook.isDisabled)}
                                    >
                                      {updatingHookId === hook.id
                                        ? "Guardando..."
                                        : hook.isDisabled
                                          ? "Activar"
                                          : "Desactivar"}
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </details>
                        );
                      })}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}

        {errorMessage && <p className="error-text">{errorMessage}</p>}
      </section>

      {toastMessage && (
        <div className="floating-toast" role="status" aria-live="polite">
          {toastMessage}
        </div>
      )}
    </main>
  );
}
