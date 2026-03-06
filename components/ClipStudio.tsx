"use client";

import { type DragEvent as ReactDragEvent, type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { withBasePath } from "@/lib/base-path";

type SourceType = "master" | "clip";
type PlaybackPhase = "idle" | "loading" | "delay" | "countdown" | "clip";

interface LibraryAudio {
  id: string;
  name: string;
  url: string;
  mimeType: string;
  durationSec: number | null;
  sourceType: SourceType;
}

interface LibraryClip {
  id: string;
  name: string;
  sourceId: string;
  url: string;
  startSec: number;
  endSec: number | null;
  createdAt: string;
}

interface LibrarySong {
  id: string;
  name: string;
  folderId: string | null;
  master: LibraryAudio | null;
  clips: LibraryClip[];
  createdAt: string;
  updatedAt: string;
}

interface LibraryFolder {
  id: string;
  name: string;
  songs: LibrarySong[];
}

interface LibraryPayload {
  folders: LibraryFolder[];
  rootSongs: LibrarySong[];
}

interface CollectionClipLink {
  id: string;
  clipId: string;
  songId: string;
  songName: string;
  clipName: string;
  sourceId: string;
  url: string;
  startSec: number;
  endSec: number | null;
  sortOrder: number;
}

interface CollectionItem {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
  clips: CollectionClipLink[];
}

interface PlaybackState {
  clipId: string | null;
  phase: PlaybackPhase;
  remainingDelay: number;
}

interface SongContextMenuState {
  songId: string;
  x: number;
  y: number;
}

type WaveDragMode = "start" | "end" | "range";
type StudioView = "library" | "createClip";

const IDLE_PLAYBACK: PlaybackState = {
  clipId: null,
  phase: "idle",
  remainingDelay: 0
};

const NEW_SONG_OPTION = "__new__";

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

function safeDuration(endSec: number | null, startSec: number): number | null {
  if (endSec === null) {
    return null;
  }
  return Math.max(0, endSec - startSec);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 25000
): Promise<Response> {
  const controller = new AbortController();
  const externalSignal = init.signal;

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }

  const timeoutId = window.setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      credentials: "same-origin",
      signal: controller.signal
    });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const raw = await response.text();
  if (!raw) {
    return {} as T;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Respuesta inválida del servidor (${response.status})`);
  }
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw new DOMException("Cancelled", "AbortError");
  }

  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new DOMException("Cancelled", "AbortError"));
    };

    signal.addEventListener("abort", onAbort, { once: true });

    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function baseName(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}

function flattenSongs(library: LibraryPayload | null): LibrarySong[] {
  if (!library) {
    return [];
  }

  return [...library.rootSongs, ...library.folders.flatMap((folder) => folder.songs)];
}

async function extractWaveform(buffer: ArrayBuffer): Promise<{ peaks: number[]; durationSec: number }> {
  const context = new AudioContext();

  try {
    const decoded = await context.decodeAudioData(buffer.slice(0));
    const channel = decoded.getChannelData(0);
    const samples = 700;
    const blockSize = Math.max(1, Math.floor(channel.length / samples));
    const peaks = new Array<number>(samples).fill(0);

    let maxPeak = 0;
    for (let i = 0; i < samples; i += 1) {
      const start = i * blockSize;
      const end = Math.min(start + blockSize, channel.length);
      let localPeak = 0;

      for (let j = start; j < end; j += 1) {
        const value = Math.abs(channel[j] || 0);
        if (value > localPeak) {
          localPeak = value;
        }
      }

      peaks[i] = localPeak;
      if (localPeak > maxPeak) {
        maxPeak = localPeak;
      }
    }

    const normalized = maxPeak > 0 ? peaks.map((value) => value / maxPeak) : peaks;
    return { peaks: normalized, durationSec: decoded.duration };
  } finally {
    await context.close();
  }
}

interface PlaybackRuntime {
  sources: AudioBufferSourceNode[];
  timeoutIds: number[];
  intervalId: number | null;
}

function detectEffectiveDuration(buffer: AudioBuffer): number {
  const threshold = 0.0016;
  const sampleRate = buffer.sampleRate;
  const channels = buffer.numberOfChannels;

  let lastIndex = buffer.length - 1;
  while (lastIndex >= 0) {
    let audible = false;
    for (let channel = 0; channel < channels; channel += 1) {
      if (Math.abs(buffer.getChannelData(channel)[lastIndex] || 0) >= threshold) {
        audible = true;
        break;
      }
    }
    if (audible) {
      return Math.max(0.05, (lastIndex + 1) / sampleRate);
    }
    lastIndex -= 1;
  }

  return Math.max(0.05, buffer.duration);
}

export function ClipStudio(): JSX.Element {
  const [library, setLibrary] = useState<LibraryPayload | null>(null);
  const [collections, setCollections] = useState<CollectionItem[]>([]);
  const [isLoadingCollections, setIsLoadingCollections] = useState(true);
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(true);
  const [studioView, setStudioView] = useState<StudioView>("library");

  const [selectedSongId, setSelectedSongId] = useState<string | null>(null);
  const [draggingSongId, setDraggingSongId] = useState<string | null>(null);
  const [dragOverTargetId, setDragOverTargetId] = useState<string | null>(null);
  const [songContextMenu, setSongContextMenu] = useState<SongContextMenuState | null>(null);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [sourceType, setSourceType] = useState<SourceType>("master");
  const [isUploading, setIsUploading] = useState(false);
  const [clipUploadName, setClipUploadName] = useState("");

  const [selectedUploadFolderId, setSelectedUploadFolderId] = useState<string>("root");
  const [selectedTargetSongId, setSelectedTargetSongId] = useState<string>(NEW_SONG_OPTION);
  const [newSongName, setNewSongName] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [isUploadDragOver, setIsUploadDragOver] = useState(false);

  const [waveform, setWaveform] = useState<number[]>([]);
  const [waveDurationSec, setWaveDurationSec] = useState(0);
  const [isAnalyzingWave, setIsAnalyzingWave] = useState(false);
  const [waveformSourceKey, setWaveformSourceKey] = useState<string | null>(null);

  const [startSec, setStartSec] = useState(0);
  const [endSec, setEndSec] = useState(15);
  const [clipName, setClipName] = useState("Clip 1");
  const [isCreatingClip, setIsCreatingClip] = useState(false);
  const [editingClipId, setEditingClipId] = useState<string | null>(null);

  const [newCollectionName, setNewCollectionName] = useState("");
  const [newCollectionSlug, setNewCollectionSlug] = useState("");
  const [isCreatingCollection, setIsCreatingCollection] = useState(false);
  const [selectedCollectionIdForAdd, setSelectedCollectionIdForAdd] = useState<string>("");

  const [useCountdown, setUseCountdown] = useState(true);
  const [delaySec, setDelaySec] = useState(0);
  const [downloadingClipId, setDownloadingClipId] = useState<string | null>(null);

  const [playback, setPlayback] = useState<PlaybackState>(IDLE_PLAYBACK);
  const playbackControllerRef = useRef<AbortController | null>(null);
  const playbackRuntimeRef = useRef<PlaybackRuntime | null>(null);
  const playbackContextRef = useRef<AudioContext | null>(null);
  const audioBufferCacheRef = useRef<Map<string, Promise<AudioBuffer>>>(new Map());

  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const [previewPositionSec, setPreviewPositionSec] = useState(0);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewPlayingRef = useRef(false);
  const previewRangeRef = useRef({ start: 0, end: 0.1 });

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const waveDragStateRef = useRef<{
    mode: WaveDragMode;
    durationSec: number;
    offsetSec: number;
    rectLeft: number;
    rectWidth: number;
  } | null>(null);
  const suppressWaveClickRef = useRef(false);
  const previousSelectedSongRef = useRef<string | null>(null);

  const allSongs = useMemo(() => flattenSongs(library), [library]);
  const selectedSong = useMemo(
    () => allSongs.find((song) => song.id === selectedSongId) ?? null,
    [allSongs, selectedSongId]
  );
  const currentMaster = selectedSong?.master ?? null;
  const allClipsForCollections = useMemo(
    () =>
      allSongs.flatMap((song) =>
        song.clips.map((clip) => ({
          clipId: clip.id,
          songId: song.id,
          label: `${song.name} · ${clip.name}`
        }))
      ),
    [allSongs]
  );
  const selectedCollectionForAdd = useMemo(
    () => collections.find((collection) => collection.id === selectedCollectionIdForAdd) ?? null,
    [collections, selectedCollectionIdForAdd]
  );

  const uploadFolderSongs = useMemo(() => {
    if (!library) {
      return [] as LibrarySong[];
    }

    if (selectedUploadFolderId === "root") {
      return library.rootSongs;
    }

    const folder = library.folders.find((item) => item.id === selectedUploadFolderId);
    return folder?.songs ?? [];
  }, [library, selectedUploadFolderId]);

  const resolvedDurationSec = useMemo(() => {
    if (currentMaster?.durationSec && Number.isFinite(currentMaster.durationSec)) {
      return currentMaster.durationSec;
    }
    return waveDurationSec;
  }, [currentMaster?.durationSec, waveDurationSec]);

  const stopPreview = useCallback(
    (resetToStart: boolean) => {
      const audio = previewAudioRef.current;
      previewPlayingRef.current = false;
      setIsPreviewPlaying(false);

      if (!audio) {
        if (resetToStart) {
          setPreviewPositionSec(startSec);
        }
        return;
      }

      audio.pause();

      if (resetToStart) {
        const target = clamp(startSec, 0, Math.max(startSec + 0.1, endSec));
        audio.currentTime = target;
        setPreviewPositionSec(target);
      } else {
        setPreviewPositionSec(audio.currentTime);
      }
    },
    [endSec, startSec]
  );

  const clearPlaybackRuntime = useCallback(() => {
    const runtime = playbackRuntimeRef.current;
    if (!runtime) {
      return;
    }

    runtime.timeoutIds.forEach((id) => {
      window.clearTimeout(id);
    });
    if (runtime.intervalId !== null) {
      window.clearInterval(runtime.intervalId);
    }
    runtime.sources.forEach((source) => {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
      source.disconnect();
    });

    playbackRuntimeRef.current = null;
  }, []);

  const getPlaybackContext = useCallback((): AudioContext => {
    const existing = playbackContextRef.current;
    if (existing) {
      return existing;
    }

    const created = new AudioContext();
    playbackContextRef.current = created;
    return created;
  }, []);

  const getCachedAudioBuffer = useCallback(
    (cacheKey: string, url: string): Promise<AudioBuffer> => {
      const cached = audioBufferCacheRef.current.get(cacheKey);
      if (cached) {
        return cached;
      }

      const loadPromise = (async () => {
        const context = getPlaybackContext();
        const response = await fetchWithTimeout(url, { cache: "no-store" }, 45000);
        if (!response.ok) {
          const details = await response.text();
          throw new Error(
            `No se pudo cargar el audio (${response.status})${details ? `: ${details.slice(0, 120)}` : ""}`
          );
        }

        const payload = await response.arrayBuffer();
        return context.decodeAudioData(payload.slice(0));
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

  const stopPlayback = useCallback(() => {
    playbackControllerRef.current?.abort();
    playbackControllerRef.current = null;
    clearPlaybackRuntime();
    setPlayback(IDLE_PLAYBACK);
  }, [clearPlaybackRuntime]);

  const ensurePreviewAudio = useCallback((): HTMLAudioElement | null => {
    if (!currentMaster) {
      return null;
    }

    const resolvedMasterUrl = withBasePath(currentMaster.url);
    const current = previewAudioRef.current;
    if (current && current.src.endsWith(resolvedMasterUrl)) {
      return current;
    }

    if (current) {
      current.pause();
      current.currentTime = 0;
    }

    const next = new Audio(resolvedMasterUrl);
    next.preload = "auto";
    previewAudioRef.current = next;
    return next;
  }, [currentMaster]);

  const startPreviewLoop = useCallback(async () => {
    if (!selectedSong || !currentMaster) {
      return;
    }

    stopPlayback();
    setErrorMessage(null);

    const audio = ensurePreviewAudio();
    if (!audio) {
      return;
    }

    previewRangeRef.current = {
      start: clamp(startSec, 0, Math.max(startSec, endSec - 0.1)),
      end: Math.max(startSec + 0.1, endSec)
    };

    audio.ontimeupdate = () => {
      if (!previewPlayingRef.current) {
        return;
      }

      const range = previewRangeRef.current;
      if (audio.currentTime < range.start || audio.currentTime >= range.end) {
        audio.currentTime = range.start;
        setPreviewPositionSec(range.start);
        return;
      }

      setPreviewPositionSec(audio.currentTime);
    };

    audio.onended = () => {
      if (!previewPlayingRef.current) {
        return;
      }

      const range = previewRangeRef.current;
      audio.currentTime = range.start;
      setPreviewPositionSec(range.start);
      void audio.play();
    };

    audio.onerror = () => {
      setErrorMessage("No se pudo reproducir la preview del rango.");
      stopPreview(true);
    };

    audio.currentTime = previewRangeRef.current.start;
    setPreviewPositionSec(previewRangeRef.current.start);

    previewPlayingRef.current = true;
    setIsPreviewPlaying(true);

    try {
      await audio.play();
    } catch (error) {
      previewPlayingRef.current = false;
      setIsPreviewPlaying(false);
      const message = error instanceof Error ? error.message : "No se pudo arrancar la preview";
      setErrorMessage(message);
    }
  }, [currentMaster, endSec, ensurePreviewAudio, selectedSong, startSec, stopPlayback, stopPreview]);

  const seekPreview = useCallback(
    (nextSec: number) => {
      const normalized = clamp(nextSec, previewRangeRef.current.start, previewRangeRef.current.end);
      setPreviewPositionSec(normalized);

      const audio = previewAudioRef.current;
      if (!audio) {
        return;
      }

      audio.currentTime = normalized;
      if (previewPlayingRef.current && audio.paused) {
        void audio.play();
      }
    },
    []
  );

  const nudgePreview = useCallback(
    (deltaSec: number) => {
      seekPreview(previewPositionSec + deltaSec);
    },
    [previewPositionSec, seekPreview]
  );

  const resetMessages = () => {
    setErrorMessage(null);
    setInfoMessage(null);
  };

  const refreshCollections = useCallback(async () => {
    const response = await fetchWithTimeout(withBasePath("/api/collections"), { cache: "no-store" }, 15000);
    const data = await parseJsonResponse<{
      collections?: CollectionItem[];
      error?: string;
    }>(response);

    if (!response.ok || !Array.isArray(data.collections)) {
      throw new Error(data.error || "No se pudieron cargar las colecciones");
    }

    setCollections(data.collections);
    setSelectedCollectionIdForAdd((current) => {
      if (current && data.collections?.some((collection) => collection.id === current)) {
        return current;
      }
      return data.collections?.[0]?.id ?? "";
    });
  }, []);

  const refreshLibrary = useCallback(
    async (preferredSongId?: string) => {
      const response = await fetchWithTimeout(withBasePath("/api/library"), { cache: "no-store" }, 15000);
      const data = await parseJsonResponse<{
        library?: LibraryPayload;
        error?: string;
      }>(response);

      if (!response.ok || !data.library) {
        throw new Error(data.error || "No se pudo cargar la biblioteca");
      }

      setLibrary(data.library);

      const availableSongIds = new Set(flattenSongs(data.library).map((song) => song.id));
      const candidate = preferredSongId || selectedSongId;

      if (candidate && availableSongIds.has(candidate)) {
        setSelectedSongId(candidate);
      } else {
        setSelectedSongId(null);
      }
    },
    [selectedSongId]
  );

  const moveSong = useCallback(
    async (songId: string, folderId: string | null) => {
      const response = await fetch(withBasePath(`/api/songs/${songId}/move`), {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ folderId })
      });

      const data = (await response.json()) as { song?: { id: string }; error?: string };
      if (!response.ok || !data.song) {
        throw new Error(data.error || "No se pudo mover la canción");
      }

      await refreshLibrary(selectedSongId ?? undefined);
      setInfoMessage("Canción movida correctamente.");
    },
    [refreshLibrary, selectedSongId]
  );

  const handleSongDrop = useCallback(
    async (targetFolderId: string | null, event: ReactDragEvent<HTMLElement>) => {
      event.preventDefault();
      setDragOverTargetId(null);

      const droppedSongId = event.dataTransfer.getData("text/plain") || draggingSongId;
      if (!droppedSongId) {
        return;
      }

      try {
        resetMessages();
        await moveSong(droppedSongId, targetFolderId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "No se pudo mover la canción";
        setErrorMessage(message);
      } finally {
        setDraggingSongId(null);
      }
    },
    [draggingSongId, moveSong]
  );

  useEffect(() => {
    let cancelled = false;
    setIsLoadingLibrary(true);

    void refreshLibrary()
      .catch((error) => {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : "Error inesperado";
        setErrorMessage(message);
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingLibrary(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [refreshLibrary]);

  useEffect(() => {
    let cancelled = false;
    setIsLoadingCollections(true);

    void refreshCollections()
      .catch((error) => {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : "Error inesperado";
        setErrorMessage(message);
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingCollections(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [refreshCollections]);

  useEffect(() => {
    if (selectedUploadFolderId === "root") {
      return;
    }

    const exists = (library?.folders ?? []).some((folder) => folder.id === selectedUploadFolderId);
    if (!exists) {
      setSelectedUploadFolderId("root");
    }
  }, [library, selectedUploadFolderId]);

  useEffect(() => {
    if (selectedTargetSongId !== NEW_SONG_OPTION) {
      const stillExists = uploadFolderSongs.some((song) => song.id === selectedTargetSongId);
      if (!stillExists) {
        setSelectedTargetSongId(NEW_SONG_OPTION);
      }
    }
  }, [selectedTargetSongId, uploadFolderSongs]);

  useEffect(() => {
    if (!songContextMenu) {
      return;
    }

    const exists = allSongs.some((song) => song.id === songContextMenu.songId);
    if (!exists) {
      setSongContextMenu(null);
    }
  }, [allSongs, songContextMenu]);

  useEffect(() => {
    if (!songContextMenu) {
      return;
    }

    const close = () => {
      setSongContextMenu(null);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };

    window.addEventListener("click", close);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [songContextMenu]);

  useEffect(() => {
    if (!currentMaster) {
      setWaveform([]);
      setWaveDurationSec(0);
      setWaveformSourceKey(null);
      stopPreview(false);
      return;
    }

    if (waveformSourceKey === currentMaster.id) {
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setIsAnalyzingWave(true);
    setErrorMessage(null);

    void (async () => {
      try {
        const waveformResponse = await fetchWithTimeout(
          withBasePath(`/api/waveform/${currentMaster.id}?samples=700`),
          { cache: "no-store", signal: controller.signal },
          60000
        );
        const waveformPayload = await parseJsonResponse<{
          peaks?: unknown;
          durationSec?: number | null;
          error?: string;
        }>(waveformResponse);

        if (!waveformResponse.ok || !Array.isArray(waveformPayload.peaks)) {
          throw new Error(
            waveformPayload.error || `No se pudo cargar la forma de onda (${waveformResponse.status})`
          );
        }

        if (cancelled) {
          return;
        }

        const normalizedPeaks = waveformPayload.peaks
          .map((value) => (typeof value === "number" && Number.isFinite(value) ? value : 0))
          .slice(0, 700);
        const safePeaks = normalizedPeaks.length > 0 ? normalizedPeaks : new Array<number>(700).fill(0);
        const durationSec =
          typeof waveformPayload.durationSec === "number" && Number.isFinite(waveformPayload.durationSec)
            ? waveformPayload.durationSec
            : currentMaster.durationSec ?? 0;

        setWaveform(safePeaks);
        setWaveDurationSec(durationSec);
        setWaveformSourceKey(currentMaster.id);
        return;
      } catch (waveformError) {
        if (cancelled || isAbortError(waveformError)) {
          return;
        }

        try {
          const response = await fetchWithTimeout(
            withBasePath(currentMaster.url),
            { cache: "no-store", signal: controller.signal },
            45000
          );
          if (!response.ok) {
            const details = await response.text();
            throw new Error(
              `No se pudo cargar el audio del master (${response.status})${details ? `: ${details.slice(0, 120)}` : ""}`
            );
          }
          const buffer = await response.arrayBuffer();
          const result = await extractWaveform(buffer);

          if (cancelled) {
            return;
          }

          setWaveform(result.peaks);
          setWaveDurationSec(result.durationSec);
          setWaveformSourceKey(currentMaster.id);
          return;
        } catch (fallbackError) {
          if (cancelled || isAbortError(fallbackError)) {
            return;
          }

          const message =
            fallbackError instanceof Error
              ? fallbackError.message
              : waveformError instanceof Error
                ? waveformError.message
                : "No se pudo analizar la forma de onda del master";
          setErrorMessage(message);
          setWaveform([]);
          setWaveDurationSec(currentMaster.durationSec ?? 0);
        }
      } finally {
        if (!cancelled) {
          setIsAnalyzingWave(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [currentMaster, stopPreview, waveformSourceKey]);

  useEffect(() => {
    previewRangeRef.current = {
      start: clamp(startSec, 0, Math.max(startSec, endSec - 0.1)),
      end: Math.max(startSec + 0.1, endSec)
    };

    setPreviewPositionSec((previous) =>
      clamp(previous, previewRangeRef.current.start, previewRangeRef.current.end)
    );
  }, [endSec, startSec]);

  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas) {
      return;
    }

    const draw = () => {
      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;

      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return;
      }

      ctx.scale(ratio, ratio);
      ctx.clearRect(0, 0, width, height);

      const bgGradient = ctx.createLinearGradient(0, 0, width, height);
      bgGradient.addColorStop(0, "#101e36");
      bgGradient.addColorStop(1, "#122b22");
      ctx.fillStyle = bgGradient;
      ctx.fillRect(0, 0, width, height);

      if (waveform.length === 0) {
        return;
      }

      const centerY = height / 2;
      const barGap = 1;
      const barWidth = Math.max(1, (width - waveform.length * barGap) / waveform.length);

      ctx.fillStyle = "rgba(203, 255, 95, 0.95)";
      waveform.forEach((peak, index) => {
        const x = index * (barWidth + barGap);
        const barHeight = Math.max(2, peak * (height * 0.9));
        const y = centerY - barHeight / 2;
        ctx.fillRect(x, y, barWidth, barHeight);
      });
    };

    draw();
    window.addEventListener("resize", draw);

    return () => {
      window.removeEventListener("resize", draw);
    };
  }, [studioView, waveform]);

  useEffect(() => {
    const prevSongId = previousSelectedSongRef.current;
    if (prevSongId === selectedSongId) {
      return;
    }

    previousSelectedSongRef.current = selectedSongId;
    stopPlayback();
    stopPreview(true);

    if (!selectedSong || !selectedSong.master) {
      setStartSec(0);
      setEndSec(15);
      setPreviewPositionSec(0);
      return;
    }

    const duration = selectedSong.master.durationSec ?? 20;
    const safeEnd = duration > 0 ? Math.min(duration, 20) : 20;
    setStartSec(0);
    setEndSec(Math.max(1, safeEnd));
    setPreviewPositionSec(0);
  }, [selectedSongId, selectedSong, stopPlayback, stopPreview]);

  useEffect(() => {
    if (!selectedSong?.master) {
      return;
    }

    void getCachedAudioBuffer(`audio:${selectedSong.master.id}`, withBasePath(selectedSong.master.url)).catch(() => {
      // Keep UX resilient even if preload fails; playback path handles explicit errors.
    });
  }, [getCachedAudioBuffer, selectedSong?.master]);

  useEffect(() => {
    if (!useCountdown) {
      return;
    }

    void getCachedAudioBuffer("countdown", withBasePath("/api/countdown")).catch(() => {
      // Optional preload; runtime playback will report the error if needed.
    });
  }, [getCachedAudioBuffer, useCountdown]);

  useEffect(() => {
    return () => {
      stopPlayback();
      const audio = previewAudioRef.current;
      if (audio) {
        audio.pause();
        audio.currentTime = 0;
        audio.ontimeupdate = null;
        audio.onended = null;
        audio.onerror = null;
      }
      previewAudioRef.current = null;
      previewPlayingRef.current = false;

      audioBufferCacheRef.current.clear();
      const context = playbackContextRef.current;
      playbackContextRef.current = null;
      if (context) {
        void context.close().catch(() => {
          // Context could already be closed.
        });
      }
    };
  }, [stopPlayback]);

  const renameFolderAction = async (folderId: string, currentName: string) => {
    const name = window.prompt("Nuevo nombre de la carpeta:", currentName)?.trim();
    if (!name) {
      return;
    }

    try {
      resetMessages();
      const response = await fetch(withBasePath(`/api/library/folders/${folderId}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      const data = (await response.json()) as { folder?: { id: string }; error?: string };
      if (!response.ok || !data.folder) {
        throw new Error(data.error || "No se pudo renombrar la carpeta");
      }

      await refreshLibrary(selectedSongId ?? undefined);
      setInfoMessage("Carpeta renombrada.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo renombrar la carpeta";
      setErrorMessage(message);
    }
  };

  const deleteFolderAction = async (folderId: string, folderName: string) => {
    const confirmed = window.confirm(
      `Eliminar carpeta "${folderName}" y todo su contenido (canciones, masters y clips)?`
    );
    if (!confirmed) {
      return;
    }

    try {
      resetMessages();
      const response = await fetch(withBasePath(`/api/library/folders/${folderId}`), { method: "DELETE" });
      const data = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) {
        throw new Error(data.error || "No se pudo eliminar la carpeta");
      }

      await refreshLibrary();
      await refreshCollections();
      setInfoMessage("Carpeta eliminada en cascada.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo eliminar la carpeta";
      setErrorMessage(message);
    }
  };

  const renameSongAction = async (songId: string, currentName: string) => {
    const name = window.prompt("Nuevo nombre de la canción:", currentName)?.trim();
    if (!name) {
      return;
    }

    try {
      resetMessages();
      const response = await fetch(withBasePath(`/api/songs/${songId}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      const data = (await response.json()) as { song?: { id: string }; error?: string };
      if (!response.ok || !data.song) {
        throw new Error(data.error || "No se pudo renombrar la canción");
      }

      await refreshLibrary(songId);
      setInfoMessage("Canción renombrada.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo renombrar la canción";
      setErrorMessage(message);
    }
  };

  const deleteSongAction = async (songId: string, songName: string) => {
    const confirmed = window.confirm(
      `Eliminar "${songName}" en cascada (master + clips + audios asociados)?`
    );
    if (!confirmed) {
      return;
    }

    try {
      resetMessages();
      const response = await fetch(withBasePath(`/api/songs/${songId}`), { method: "DELETE" });
      const data = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) {
        throw new Error(data.error || "No se pudo eliminar la canción");
      }

      await refreshLibrary();
      await refreshCollections();
      setInfoMessage("Canción eliminada en cascada.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo eliminar la canción";
      setErrorMessage(message);
    }
  };

  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name) {
      setErrorMessage("Escribe un nombre de carpeta/proyecto.");
      return;
    }

    setIsCreatingFolder(true);
    resetMessages();

    try {
      const response = await fetch(withBasePath("/api/library/folders"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ name })
      });

      const data = (await response.json()) as {
        folder?: { id: string; name: string };
        error?: string;
      };

      if (!response.ok || !data.folder) {
        throw new Error(data.error || "No se pudo crear la carpeta");
      }

      await refreshLibrary(selectedSongId ?? undefined);
      setSelectedUploadFolderId(data.folder.id);
      setNewFolderName("");
      setInfoMessage(`Carpeta creada: ${data.folder.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Error al crear carpeta";
      setErrorMessage(message);
    } finally {
      setIsCreatingFolder(false);
    }
  };

  const renameClipAction = async (clipId: string, currentName: string) => {
    const name = window.prompt("Nuevo nombre del clip:", currentName)?.trim();
    if (!name) {
      return;
    }

    try {
      resetMessages();
      const response = await fetch(withBasePath(`/api/clips/${clipId}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      const data = (await response.json()) as { clip?: { id: string }; error?: string };
      if (!response.ok || !data.clip) {
        throw new Error(data.error || "No se pudo renombrar el clip");
      }

      if (selectedSong) {
        await refreshLibrary(selectedSong.id);
      } else {
        await refreshLibrary();
      }
      setInfoMessage("Clip renombrado.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo renombrar el clip";
      setErrorMessage(message);
    }
  };

  const handleCreateCollection = async () => {
    const name = newCollectionName.trim();
    if (!name) {
      setErrorMessage("Escribe un nombre para la colección.");
      return;
    }

    setIsCreatingCollection(true);
    resetMessages();

    try {
      const response = await fetch(withBasePath("/api/collections"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          slug: newCollectionSlug.trim() || null
        })
      });
      const data = (await response.json()) as { collection?: { id: string }; error?: string };
      if (!response.ok || !data.collection) {
        throw new Error(data.error || "No se pudo crear la colección");
      }

      await refreshCollections();
      setSelectedCollectionIdForAdd(data.collection.id);
      setNewCollectionName("");
      setNewCollectionSlug("");
      setInfoMessage("Colección creada.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo crear la colección";
      setErrorMessage(message);
    } finally {
      setIsCreatingCollection(false);
    }
  };

  const renameCollectionAction = async (collection: CollectionItem) => {
    const name = window.prompt("Nuevo nombre de colección:", collection.name)?.trim();
    if (!name) {
      return;
    }

    try {
      resetMessages();
      const response = await fetch(withBasePath(`/api/collections/${collection.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      const data = (await response.json()) as { collection?: { id: string }; error?: string };
      if (!response.ok || !data.collection) {
        throw new Error(data.error || "No se pudo renombrar la colección");
      }
      await refreshCollections();
      setInfoMessage("Colección renombrada.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo renombrar la colección";
      setErrorMessage(message);
    }
  };

  const deleteCollectionAction = async (collection: CollectionItem) => {
    const confirmed = window.confirm(`Eliminar colección "${collection.name}"?`);
    if (!confirmed) {
      return;
    }

    try {
      resetMessages();
      const response = await fetch(withBasePath(`/api/collections/${collection.id}`), { method: "DELETE" });
      const data = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) {
        throw new Error(data.error || "No se pudo eliminar la colección");
      }
      await refreshCollections();
      setInfoMessage("Colección eliminada.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo eliminar la colección";
      setErrorMessage(message);
    }
  };

  const addClipToCollectionAction = async (collectionId: string, clipId: string) => {
    try {
      resetMessages();
      const response = await fetch(withBasePath(`/api/collections/${collectionId}/clips`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clipId })
      });
      const data = (await response.json()) as { item?: { id: string }; error?: string };
      if (!response.ok || !data.item) {
        throw new Error(data.error || "No se pudo añadir el clip");
      }
      await refreshCollections();
      setInfoMessage("Clip añadido a la colección.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo añadir el clip";
      setErrorMessage(message);
    }
  };

  const removeClipFromCollectionAction = async (collectionId: string, clipId: string) => {
    try {
      resetMessages();
      const response = await fetch(withBasePath(`/api/collections/${collectionId}/clips/${clipId}`), {
        method: "DELETE"
      });
      const data = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) {
        throw new Error(data.error || "No se pudo quitar el clip");
      }
      await refreshCollections();
      setInfoMessage("Clip eliminado de la colección.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo quitar el clip";
      setErrorMessage(message);
    }
  };

  const copyCollectionLink = async (slug: string) => {
    try {
      const relativePath = withBasePath(`/collection/${slug}`);
      const absoluteUrl = `${window.location.origin}${relativePath}`;
      await navigator.clipboard.writeText(absoluteUrl);
      setInfoMessage(`Enlace copiado: ${absoluteUrl}`);
      setErrorMessage(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo copiar el enlace";
      setErrorMessage(message);
    }
  };

  const handleUpload = async () => {
    if (!selectedFile) {
      setErrorMessage("Selecciona un audio antes de subir.");
      return;
    }

    if (selectedTargetSongId === NEW_SONG_OPTION && !newSongName.trim()) {
      setErrorMessage("Debes indicar el nombre de la canción destino.");
      return;
    }

    resetMessages();
    setIsUploading(true);

    try {
      const formData = new FormData();
      formData.append("audio", selectedFile);
      formData.append("sourceType", sourceType);
      formData.append("folderId", selectedUploadFolderId);

      if (selectedTargetSongId === NEW_SONG_OPTION) {
        formData.append("songName", newSongName.trim());
      } else {
        formData.append("songId", selectedTargetSongId);
      }

      if (sourceType === "clip") {
        formData.append("clipName", clipUploadName.trim() || baseName(selectedFile.name) || "Clip");
      }

      const response = await fetch(withBasePath("/api/upload"), {
        method: "POST",
        body: formData
      });

      const data = (await response.json()) as {
        song?: { id: string; name: string };
        error?: string;
      };

      if (!response.ok || !data.song) {
        throw new Error(data.error || "No se pudo subir el audio");
      }

      await refreshLibrary(data.song.id);
      setSelectedSongId(data.song.id);
      setSelectedTargetSongId(data.song.id);
      setSelectedFile(null);
      setClipUploadName("");
      setSourceType("master");
      setIsUploadModalOpen(false);
      setStudioView("library");
      setInfoMessage("Audio subido y asociado correctamente.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Error al subir audio";
      setErrorMessage(message);
    } finally {
      setIsUploading(false);
    }
  };

  const handleUploadFilePick = (file: File | null) => {
    setSelectedFile(file);
    if (!file) {
      return;
    }

    if (sourceType === "clip") {
      setClipUploadName(baseName(file.name));
    }
  };

  const saveClipFromMaster = async () => {
    if (!selectedSong || !selectedSong.master) {
      setErrorMessage("Selecciona una canción con master para crear clips.");
      return;
    }

    setIsCreatingClip(true);
    resetMessages();

    try {
      const method = editingClipId ? "PATCH" : "POST";
      const endpoint = editingClipId ? withBasePath(`/api/clips/${editingClipId}`) : withBasePath("/api/clips");

      const response = await fetchWithTimeout(endpoint, {
        method,
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          name: clipName.trim() || `Clip ${selectedSong.clips.length + 1}`,
          songId: selectedSong.id,
          sourceAudioId: selectedSong.master.id,
          startSec,
          endSec
        })
      }, 20000);

      const data = await parseJsonResponse<{
        clip?: { id: string };
        error?: string;
      }>(response);

      if (!response.ok || !data.clip) {
        throw new Error(data.error || "No se pudo guardar el clip");
      }

      await refreshLibrary(selectedSong.id);
      await refreshCollections();
      setClipName(`Clip ${selectedSong.clips.length + 2}`);
      setEditingClipId(null);
      setStudioView("library");
      setInfoMessage(editingClipId ? "Clip actualizado." : "Clip guardado en la biblioteca.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Error guardando clip";
      setErrorMessage(message);
    } finally {
      setIsCreatingClip(false);
    }
  };

  const removeClip = async (clipId: string) => {
    if (playback.clipId === clipId) {
      stopPlayback();
    }

    resetMessages();

    try {
      const response = await fetch(withBasePath(`/api/clips/${clipId}`), {
        method: "DELETE"
      });

      const data = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) {
        throw new Error(data.error || "No se pudo eliminar el clip");
      }

      if (selectedSong) {
        await refreshLibrary(selectedSong.id);
      }
      await refreshCollections();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Error eliminando clip";
      setErrorMessage(message);
    }
  };

  const playClip = useCallback(
    async (clip: LibraryClip) => {
      stopPreview(true);
      stopPlayback();
      setErrorMessage(null);
      setPlayback({
        clipId: clip.id,
        phase: "loading",
        remainingDelay: 0
      });

      const controller = new AbortController();
      playbackControllerRef.current = controller;
      const signal = controller.signal;
      const context = getPlaybackContext();
      const runtime: PlaybackRuntime = {
        sources: [],
        timeoutIds: [],
        intervalId: null
      };
      playbackRuntimeRef.current = runtime;

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
        const clipBufferPromise = getCachedAudioBuffer(`audio:${clip.sourceId}`, withBasePath(clip.url));
        const countdownBufferPromise = useCountdown
          ? getCachedAudioBuffer("countdown", withBasePath("/api/countdown"))
          : Promise.resolve(null);

        const clipBuffer = await awaitWithAbort(clipBufferPromise, signal);

        if (clipBuffer.duration <= 0.01) {
          throw new Error("El clip es demasiado corto para reproducir.");
        }

        const clipStartSec = clamp(clip.startSec, 0, Math.max(0, clipBuffer.duration - 0.01));
        const requestedClipEndSec = clip.endSec !== null ? Math.max(clip.endSec, clipStartSec + 0.01) : clipBuffer.duration;
        const clipEndSec = clamp(requestedClipEndSec, clipStartSec + 0.01, clipBuffer.duration);
        const clipDurationSec = Math.max(0.01, clipEndSec - clipStartSec);

        let countdownBuffer: AudioBuffer | null = null;
        let countdownDurationSec = 0;

        if (useCountdown) {
          countdownBuffer = await awaitWithAbort(countdownBufferPromise, signal);
          if (!countdownBuffer) {
            throw new Error("No se pudo cargar la cuenta atrás.");
          }
          countdownDurationSec = Math.min(countdownBuffer.duration, detectEffectiveDuration(countdownBuffer));
        }

        if (signal.aborted) {
          throw new DOMException("Cancelled", "AbortError");
        }

        const playbackStartAt = context.currentTime + delaySec;
        const clipStartAt = playbackStartAt + countdownDurationSec;

        if (delaySec > 0) {
          setPlaybackIfActive({
            clipId: clip.id,
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
              clipId: clip.id,
              phase: "delay",
              remainingDelay: remaining
            });
          }, 120);

          scheduleTimeout(delaySec * 1000, () => {
            setPlaybackIfActive({
              clipId: clip.id,
              phase: useCountdown ? "countdown" : "clip",
              remainingDelay: 0
            });
          });
        } else {
          setPlaybackIfActive({
            clipId: clip.id,
            phase: useCountdown ? "countdown" : "clip",
            remainingDelay: 0
          });
        }

        if (useCountdown) {
          scheduleTimeout((delaySec + countdownDurationSec) * 1000, () => {
            setPlaybackIfActive({
              clipId: clip.id,
              phase: "clip",
              remainingDelay: 0
            });
          });
        }

        await context.resume();

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
          const message = error instanceof Error ? error.message : "No se pudo reproducir el clip";
          setErrorMessage(message);
        }
      } finally {
        if (playbackControllerRef.current === controller) {
          playbackControllerRef.current = null;
          clearPlaybackRuntime();
          setPlayback(IDLE_PLAYBACK);
        }
      }
    },
    [clearPlaybackRuntime, delaySec, getCachedAudioBuffer, getPlaybackContext, stopPlayback, stopPreview, useCountdown]
  );

  const downloadClip = async (clip: LibraryClip, applyGlobalSettings: boolean) => {
    setDownloadingClipId(clip.id);
    setErrorMessage(null);

    try {
      const response = await fetch(withBasePath("/api/render"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          sourceId: clip.sourceId,
          clipName: clip.name,
          startSec: clip.startSec,
          endSec: clip.endSec,
          includeCountdown: applyGlobalSettings ? useCountdown : false,
          delaySec: applyGlobalSettings ? delaySec : 0
        })
      });

      const data = (await response.json()) as {
        audio?: { id: string; name: string; url: string };
        error?: string;
      };

      if (!response.ok || !data.audio) {
        throw new Error(data.error || "No se pudo generar la descarga");
      }

      const link = document.createElement("a");
      link.href = data.audio.url;
      link.download = data.audio.name;
      document.body.append(link);
      link.click();
      link.remove();

      setInfoMessage(`Descarga preparada: ${data.audio.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Error al descargar";
      setErrorMessage(message);
    } finally {
      setDownloadingClipId(null);
    }
  };

  const toSecondFromClientX = useCallback(
    (clientX: number, rectLeft: number, rectWidth: number) => {
      if (!resolvedDurationSec || rectWidth <= 0) {
        return 0;
      }
      const ratio = (clientX - rectLeft) / rectWidth;
      return clamp(ratio * resolvedDurationSec, 0, resolvedDurationSec);
    },
    [resolvedDurationSec]
  );

  const handleWaveMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (!resolvedDurationSec || resolvedDurationSec <= 0) {
      return;
    }

    const target = event.target as HTMLElement;
    const rect = event.currentTarget.getBoundingClientRect();
    const selectedSec = toSecondFromClientX(event.clientX, rect.left, rect.width);
    const selectionDuration = Math.max(0.1, endSec - startSec);

    let mode: WaveDragMode | null = null;
    if (target.dataset.dragRole === "start") {
      mode = "start";
    } else if (target.dataset.dragRole === "end") {
      mode = "end";
    } else if (target.dataset.dragRole === "range") {
      mode = "range";
    } else if (selectedSec >= startSec && selectedSec <= endSec) {
      mode = "range";
    }

    if (!mode) {
      return;
    }

    suppressWaveClickRef.current = true;
    event.preventDefault();
    const shouldRestartPreview = isPreviewPlaying;

    waveDragStateRef.current = {
      mode,
      durationSec: selectionDuration,
      offsetSec: selectedSec - startSec,
      rectLeft: rect.left,
      rectWidth: rect.width
    };

    const onMove = (moveEvent: globalThis.MouseEvent) => {
      const dragState = waveDragStateRef.current;
      if (!dragState) {
        return;
      }

      const nextSec = toSecondFromClientX(moveEvent.clientX, dragState.rectLeft, dragState.rectWidth);
      if (dragState.mode === "start") {
        const nextStart = clamp(nextSec, 0, endSec - 0.1);
        setStartSec(nextStart);
        return;
      }

      if (dragState.mode === "end") {
        const nextEnd = clamp(nextSec, startSec + 0.1, resolvedDurationSec);
        setEndSec(nextEnd);
        return;
      }

      const maxStart = Math.max(0, resolvedDurationSec - dragState.durationSec);
      const desiredStart = nextSec - dragState.offsetSec;
      const nextStart = clamp(desiredStart, 0, maxStart);
      setStartSec(nextStart);
      setEndSec(nextStart + dragState.durationSec);
    };

    const onUp = () => {
      waveDragStateRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (shouldRestartPreview) {
        stopPreview(true);
        void startPreviewLoop();
      }
      window.setTimeout(() => {
        suppressWaveClickRef.current = false;
      }, 0);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const handleWaveClick = (event: MouseEvent<HTMLDivElement>) => {
    if (suppressWaveClickRef.current) {
      return;
    }

    if (!resolvedDurationSec || resolvedDurationSec <= 0) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const selectedSec = toSecondFromClientX(event.clientX, rect.left, rect.width);

    const startDistance = Math.abs(selectedSec - startSec);
    const endDistance = Math.abs(selectedSec - endSec);

    if (startDistance <= endDistance) {
      setStartSec(Math.min(selectedSec, endSec - 0.1));
      return;
    }

    setEndSec(Math.max(selectedSec, startSec + 0.1));
  };

  const handleSongDragStart = (songId: string, event: ReactDragEvent<HTMLButtonElement>) => {
    setDraggingSongId(songId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", songId);
  };

  const handleSongDragEnd = () => {
    setDraggingSongId(null);
    setDragOverTargetId(null);
  };

  const handleSongContextMenu = (songId: string, event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setSongContextMenu({
      songId,
      x: event.clientX,
      y: event.clientY
    });
  };

  const handleContextMoveSong = async (folderId: string | null) => {
    if (!songContextMenu) {
      return;
    }

    try {
      resetMessages();
      await moveSong(songContextMenu.songId, folderId);
      setSongContextMenu(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo mover la canción";
      setErrorMessage(message);
    }
  };

  const openCreateClipView = (song: LibrarySong, clipToEdit?: LibraryClip) => {
    if (!song.master) {
      setErrorMessage("Esta canción no tiene master. Sube un master para crear clips.");
      return;
    }

    if (clipToEdit && clipToEdit.sourceId !== song.master.id) {
      setErrorMessage("Solo se pueden editar aquí clips basados en el master de la canción.");
      return;
    }

    resetMessages();
    setSelectedSongId(song.id);
    if (clipToEdit) {
      setEditingClipId(clipToEdit.id);
      setClipName(clipToEdit.name);
      setStartSec(clipToEdit.startSec);
      const masterDuration = song.master.durationSec ?? 20;
      const fallbackEnd = Math.max(clipToEdit.startSec + 0.1, masterDuration > 0 ? masterDuration : 20);
      setEndSec(clipToEdit.endSec ?? fallbackEnd);
    } else {
      setEditingClipId(null);
      setClipName(`Clip ${song.clips.length + 1}`);
    }
    setStudioView("createClip");
  };

  const renderSongChip = (song: LibrarySong) => {
    const isExpanded = selectedSongId === song.id;

    return (
      <div className="song-entry" key={song.id}>
        <button
          type="button"
          className={`song-chip ${isExpanded ? "active" : ""}`}
          draggable
          onClick={() => {
            setSelectedSongId((current) => (current === song.id ? null : song.id));
          }}
          onContextMenu={(event) => handleSongContextMenu(song.id, event)}
          onDragStart={(event) => handleSongDragStart(song.id, event)}
          onDragEnd={handleSongDragEnd}
        >
          <span>{song.name}</span>
          <small>{song.master ? "master" : "sin master"} · {song.clips.length} clips</small>
        </button>

        {isExpanded && (
          <div className="song-expand">
            <p>
              Master: <strong>{song.master?.name ?? "pendiente"}</strong> · Clips: <strong>{song.clips.length}</strong>
            </p>

            <div className="song-actions">
              <button type="button" className="btn btn-ghost" onClick={() => void renameSongAction(song.id, song.name)}>
                Renombrar canción
              </button>
              <button type="button" className="btn btn-warning" onClick={() => void deleteSongAction(song.id, song.name)}>
                Eliminar canción (cascada)
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!song.master}
                onClick={() => openCreateClipView(song)}
              >
                Crear clip desde master
              </button>
            </div>

            {song.clips.length === 0 && <p className="small-note">No hay clips todavía.</p>}

            {song.clips.length > 0 && (
              <div className="clip-list">
                {song.clips.map((clip) => {
                  const isCurrent = playback.clipId === clip.id && playback.phase !== "idle";
                  const clipDuration = safeDuration(clip.endSec, clip.startSec);
                  const playbackStatus =
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
                        <h3>{clip.name}</h3>
                        <div className="clip-head-actions">
                          <button
                            type="button"
                            className="btn btn-ghost"
                            disabled={!song.master || clip.sourceId !== song.master.id}
                            onClick={() => openCreateClipView(song, clip)}
                          >
                            Editar
                          </button>
                          <button type="button" className="btn btn-ghost" onClick={() => void renameClipAction(clip.id, clip.name)}>
                            Renombrar
                          </button>
                          <button type="button" className="btn btn-ghost" onClick={() => void removeClip(clip.id)}>
                            Eliminar
                          </button>
                        </div>
                      </div>

                      <p className="clip-meta-row">
                        Inicio: <strong>{clip.startSec.toFixed(2)}s</strong> · Fin: <strong>{clip.endSec?.toFixed(2) ?? "final"}s</strong>
                        {" · "}
                        Duración: <strong>{formatSeconds(clipDuration)}</strong>
                        {playbackStatus && <span className="playback-pill inline">{playbackStatus}</span>}
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

                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={downloadingClipId === clip.id}
                          onClick={() => void downloadClip(clip, false)}
                        >
                          Descargar clip
                        </button>

                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={downloadingClipId === clip.id}
                          onClick={() => void downloadClip(clip, true)}
                        >
                          Descargar con cuenta atrás
                        </button>

                        <button
                          type="button"
                          className="btn btn-ghost"
                          disabled={!selectedCollectionIdForAdd}
                          onClick={() => void addClipToCollectionAction(selectedCollectionIdForAdd, clip.id)}
                        >
                          Añadir a colección
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const startPercent = resolvedDurationSec > 0 ? (startSec / resolvedDurationSec) * 100 : 0;
  const endPercent = resolvedDurationSec > 0 ? (endSec / resolvedDurationSec) * 100 : 0;
  const contextSong = songContextMenu
    ? allSongs.find((song) => song.id === songContextMenu.songId) ?? null
    : null;

  return (
    <main className="studio-shell">
      <section className="hero-panel">
        <p className="kicker">Audio Clipper Studio</p>
        <h1>Biblioteca persistente de proyectos, masters y clips</h1>
        <p>
          Al recargar, seguirás viendo carpetas, canciones, masters y clips. Puedes subir clips primero y añadir el
          master de esa canción más adelante.
        </p>
      </section>

      <section className="panel settings-panel">
        <h2>Ajustes globales de reproducción</h2>
        <label className="checkbox-line">
          <input
            type="checkbox"
            checked={useCountdown}
            onChange={(event) => setUseCountdown(event.target.checked)}
          />
          Reproducir cuenta atrás antes del clip
        </label>

        <label className="field-label" htmlFor="delay-sec">
          Delay extra (segundos)
        </label>
        <input
          id="delay-sec"
          type="number"
          min={0}
          step={1}
          className="number-input"
          value={delaySec}
          onChange={(event) => {
            const nextValue = Number.parseInt(event.target.value, 10);
            setDelaySec(Number.isFinite(nextValue) && nextValue >= 0 ? nextValue : 0);
          }}
        />

        <div className="small-note">
          Stop corta todo. El siguiente Play vuelve a empezar desde cero (delay + cuenta atrás + clip).
        </div>
      </section>

      {studioView === "library" && (
        <section className="panel library-panel">
          <div className="library-head">
            <h2>Biblioteca</h2>
            <div className="library-head-actions">
              {isLoadingLibrary && <span>Cargando...</span>}
              <button type="button" className="btn btn-primary" onClick={() => setIsUploadModalOpen(true)}>
                Subir clip/master
              </button>
            </div>
          </div>

          <div className="inline-row">
            <input
              type="text"
              className="text-input"
              placeholder="Nueva carpeta / proyecto"
              value={newFolderName}
              onChange={(event) => setNewFolderName(event.target.value)}
            />
            <button type="button" className="btn btn-ghost" onClick={() => void handleCreateFolder()} disabled={isCreatingFolder}>
              {isCreatingFolder ? "Creando..." : "Crear carpeta"}
            </button>
          </div>

          {library && (
            <div className="library-groups">
              <div
                className={`library-group drop-zone ${dragOverTargetId === "root" ? "active" : ""}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragOverTargetId("root");
                }}
                onDragLeave={() => setDragOverTargetId(null)}
                onDrop={(event) => void handleSongDrop(null, event)}
              >
                <h3>Raíz</h3>
                {library.rootSongs.length === 0 && <p className="small-note">Sin canciones en raíz.</p>}
                {library.rootSongs.map((song) => renderSongChip(song))}
              </div>

              {library.folders.map((folder) => (
                <details
                  key={folder.id}
                  open
                  className={`library-folder drop-zone ${dragOverTargetId === folder.id ? "active" : ""}`}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragOverTargetId(folder.id);
                  }}
                  onDragLeave={() => setDragOverTargetId(null)}
                  onDrop={(event) => void handleSongDrop(folder.id, event)}
                >
                  <summary>
                    <span>
                      {folder.name} <small>({folder.songs.length} canciones)</small>
                    </span>
                    <span className="folder-actions" onClick={(event) => event.stopPropagation()}>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => void renameFolderAction(folder.id, folder.name)}
                      >
                        Renombrar
                      </button>
                      <button
                        type="button"
                        className="btn btn-warning"
                        onClick={() => void deleteFolderAction(folder.id, folder.name)}
                      >
                        Eliminar
                      </button>
                    </span>
                  </summary>
                  <div className="library-folder-list">
                    {folder.songs.length === 0 && <p className="small-note">Sin canciones.</p>}
                    {folder.songs.map((song) => renderSongChip(song))}
                  </div>
                </details>
              ))}
            </div>
          )}

          <div className="collections-admin">
            <h3>Colecciones públicas</h3>
            <p className="small-note">
              Comparte enlaces públicos de entrenamiento: <code>{withBasePath("/collection/[slug]")}</code>
            </p>

            <div className="collections-create-grid">
              <input
                type="text"
                className="text-input"
                placeholder="Nombre colección"
                value={newCollectionName}
                onChange={(event) => setNewCollectionName(event.target.value)}
              />
              <input
                type="text"
                className="text-input"
                placeholder="Slug opcional (ej: set-abril)"
                value={newCollectionSlug}
                onChange={(event) => setNewCollectionSlug(event.target.value)}
              />
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void handleCreateCollection()}
                disabled={isCreatingCollection}
              >
                {isCreatingCollection ? "Creando..." : "Crear colección"}
              </button>
            </div>

            <div className="collections-add-inline">
              <select
                className="number-input"
                value={selectedCollectionIdForAdd}
                onChange={(event) => setSelectedCollectionIdForAdd(event.target.value)}
              >
                <option value="">Selecciona colección...</option>
                {collections.map((collection) => (
                  <option key={collection.id} value={collection.id}>
                    {collection.name}
                  </option>
                ))}
              </select>

              <span className="small-note">
                {isLoadingCollections
                  ? "Cargando colecciones..."
                  : selectedCollectionForAdd
                    ? `URL pública: ${withBasePath(`/collection/${selectedCollectionForAdd.slug}`)}`
                    : "No hay colección seleccionada."}
              </span>
            </div>

            <div className="collection-list">
              {collections.length === 0 && <p className="small-note">Aún no hay colecciones públicas.</p>}
              {collections.map((collection) => (
                <article key={collection.id} className="collection-card">
                  <div className="collection-head">
                    <strong>{collection.name}</strong>
                    <span className="small-note">/{collection.slug}</span>
                  </div>

                  <div className="collection-actions">
                    <button type="button" className="btn btn-ghost" onClick={() => void renameCollectionAction(collection)}>
                      Renombrar
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => void copyCollectionLink(collection.slug)}>
                      Copiar enlace
                    </button>
                    <button type="button" className="btn btn-warning" onClick={() => void deleteCollectionAction(collection)}>
                      Eliminar
                    </button>
                  </div>

                  <p className="small-note">Clips: {collection.clips.length}</p>

                  {collection.clips.length > 0 && (
                    <ul className="collection-clip-items">
                      {collection.clips.map((item) => (
                        <li key={item.id}>
                          <span>{item.songName} · {item.clipName}</span>
                          <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={() => void removeClipFromCollectionAction(collection.id, item.clipId)}
                          >
                            Quitar
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="collections-add-inline">
                    <select
                      className="number-input"
                      defaultValue=""
                      onChange={(event) => {
                        const clipId = event.target.value;
                        if (!clipId) {
                          return;
                        }
                        void addClipToCollectionAction(collection.id, clipId);
                        event.target.value = "";
                      }}
                    >
                      <option value="">Añadir clip...</option>
                      {allClipsForCollections.map((clipOption) => (
                        <option key={clipOption.clipId} value={clipOption.clipId}>
                          {clipOption.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>
      )}

      {studioView === "createClip" && (
        <section className="panel editor-panel">
          <div className="editor-head">
            <h2>{editingClipId ? "Editar clip" : "Crear clips desde master"}</h2>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setEditingClipId(null);
                setStudioView("library");
              }}
            >
              Volver a biblioteca
            </button>
          </div>

          {!selectedSong?.master && <p className="small-note">Selecciona una canción con master desde la biblioteca.</p>}

          {selectedSong?.master && (
            <>
              <p>
                Canción: <strong>{selectedSong.name}</strong> · Master: <strong>{selectedSong.master.name}</strong>
              </p>

              <div className="preview-panel">
                <div className="preview-head">
                  <strong>Preview del rango seleccionado</strong>
                  <span>
                    {startSec.toFixed(2)}s - {endSec.toFixed(2)}s
                  </span>
                </div>

                <div className="preview-controls">
                  {isPreviewPlaying ? (
                    <button type="button" className="btn btn-warning" onClick={() => stopPreview(true)}>
                      Stop
                    </button>
                  ) : (
                    <button type="button" className="btn btn-primary" onClick={() => void startPreviewLoop()}>
                      Play
                    </button>
                  )}

                  <button type="button" className="btn btn-ghost" onClick={() => nudgePreview(-1)}>
                    -1s
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => nudgePreview(1)}>
                    +1s
                  </button>
                </div>

                <label className="preview-seek">
                  Duración del clip seleccionado: {formatSeconds(Math.max(0, endSec - startSec))}
                  <input
                    type="range"
                    min={previewRangeRef.current.start}
                    max={previewRangeRef.current.end}
                    step={0.01}
                    value={clamp(previewPositionSec, previewRangeRef.current.start, previewRangeRef.current.end)}
                    onChange={(event) => {
                      const next = Number.parseFloat(event.target.value);
                      seekPreview(next);
                    }}
                  />
                </label>
              </div>

              <div className="wave-shell" onClick={handleWaveClick} onMouseDown={handleWaveMouseDown}>
                <canvas ref={waveformCanvasRef} className="wave-canvas" />

                {resolvedDurationSec > 0 && (
                  <>
                    <div
                      data-drag-role="range"
                      className="selection-overlay draggable"
                      style={{ left: `${startPercent}%`, width: `${endPercent - startPercent}%` }}
                    />
                    <div data-drag-role="start" className="selection-handle start draggable" style={{ left: `${startPercent}%` }} />
                    <div data-drag-role="end" className="selection-handle end draggable" style={{ left: `${endPercent}%` }} />
                  </>
                )}
              </div>

              <div className="status-list">
                <p>
                  <strong>Duración detectada del master:</strong> {formatSeconds(resolvedDurationSec)}
                </p>
                {isAnalyzingWave && <p>Analizando forma de onda...</p>}
              </div>

              <div className="range-grid">
                <label>
                  Inicio: {startSec.toFixed(2)}s
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0.1, resolvedDurationSec || 0.1)}
                    step={0.01}
                    value={startSec}
                    onChange={(event) => {
                      const next = Number.parseFloat(event.target.value);
                      setStartSec(Math.min(next, endSec - 0.1));
                    }}
                  />
                </label>

                <label>
                  Fin: {endSec.toFixed(2)}s
                  <input
                    type="range"
                    min={0.1}
                    max={Math.max(0.1, resolvedDurationSec || 0.1)}
                    step={0.01}
                    value={endSec}
                    onChange={(event) => {
                      const next = Number.parseFloat(event.target.value);
                      setEndSec(Math.max(next, startSec + 0.1));
                    }}
                  />
                </label>
              </div>

              <div className="add-clip-row">
                <input
                  type="text"
                  className="text-input"
                  placeholder="Nombre del clip"
                  value={clipName}
                  onChange={(event) => setClipName(event.target.value)}
                />
                <button type="button" className="btn btn-primary" onClick={() => void saveClipFromMaster()} disabled={isCreatingClip}>
                  {isCreatingClip ? "Guardando..." : editingClipId ? "Guardar cambios" : "Guardar clip"}
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {isUploadModalOpen && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!isUploading) {
              setIsUploadModalOpen(false);
              setIsUploadDragOver(false);
            }
          }}
        >
          <section className="modal-panel" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h3>Subir clip o master</h3>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setIsUploadModalOpen(false);
                  setIsUploadDragOver(false);
                }}
                disabled={isUploading}
              >
                Cerrar
              </button>
            </div>

            <label className="field-label" htmlFor="upload-folder">
              Proyecto / carpeta
            </label>
            <select
              id="upload-folder"
              className="number-input"
              value={selectedUploadFolderId}
              onChange={(event) => setSelectedUploadFolderId(event.target.value)}
            >
              <option value="root">Raíz</option>
              {(library?.folders ?? []).map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.name}
                </option>
              ))}
            </select>

            <label className="field-label" htmlFor="target-song">
              Canción destino
            </label>
            <select
              id="target-song"
              className="number-input"
              value={selectedTargetSongId}
              onChange={(event) => setSelectedTargetSongId(event.target.value)}
            >
              <option value={NEW_SONG_OPTION}>Nueva canción</option>
              {uploadFolderSongs.map((song) => (
                <option key={song.id} value={song.id}>
                  {song.name}
                </option>
              ))}
            </select>

            {selectedTargetSongId === NEW_SONG_OPTION && (
              <input
                type="text"
                className="text-input"
                placeholder="Nombre de la canción"
                value={newSongName}
                onChange={(event) => setNewSongName(event.target.value)}
              />
            )}

            <div
              className={`upload-drop-zone ${isUploadDragOver ? "active" : ""}`}
              onDragOver={(event) => {
                event.preventDefault();
                setIsUploadDragOver(true);
              }}
              onDragLeave={(event) => {
                event.preventDefault();
                setIsUploadDragOver(false);
              }}
              onDrop={(event) => {
                event.preventDefault();
                setIsUploadDragOver(false);
                const file = event.dataTransfer.files?.[0] ?? null;
                handleUploadFilePick(file);
              }}
            >
              <p>Arrastra aquí el audio o usa el selector</p>
              <input
                id="audio-file"
                className="file-input"
                type="file"
                accept="audio/*"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  handleUploadFilePick(file);
                }}
              />
              <small>{selectedFile ? `Seleccionado: ${selectedFile.name}` : "Ningún archivo seleccionado"}</small>
            </div>

            <div className="source-toggle">
              <label>
                <input
                  type="radio"
                  name="source-type"
                  checked={sourceType === "master"}
                  onChange={() => setSourceType("master")}
                />
                Subir master
              </label>
              <label>
                <input
                  type="radio"
                  name="source-type"
                  checked={sourceType === "clip"}
                  onChange={() => {
                    setSourceType("clip");
                    if (selectedFile) {
                      setClipUploadName(baseName(selectedFile.name));
                    }
                  }}
                />
                Subir clip
              </label>
            </div>

            {sourceType === "clip" && (
              <input
                type="text"
                className="text-input"
                placeholder="Nombre del clip"
                value={clipUploadName}
                onChange={(event) => setClipUploadName(event.target.value)}
              />
            )}

            <button className="btn btn-primary" type="button" onClick={() => void handleUpload()} disabled={!selectedFile || isUploading}>
              {isUploading ? "Subiendo..." : "Subir audio"}
            </button>
          </section>
        </div>
      )}

      {songContextMenu && library && (
        <div className="context-menu" style={{ top: songContextMenu.y, left: songContextMenu.x }}>
          {contextSong && (
            <>
              <button type="button" onClick={() => void renameSongAction(contextSong.id, contextSong.name)}>
                Renombrar canción
              </button>
              <button type="button" onClick={() => void deleteSongAction(contextSong.id, contextSong.name)}>
                Eliminar master/canción (cascada)
              </button>
            </>
          )}
          <button type="button" onClick={() => void handleContextMoveSong(null)}>
            Mover a raíz
          </button>
          {library.folders.map((folder) => (
            <button key={folder.id} type="button" onClick={() => void handleContextMoveSong(folder.id)}>
              Mover a: {folder.name}
            </button>
          ))}
        </div>
      )}

      {(errorMessage || infoMessage) && (
        <section className="panel feedback-panel">
          {errorMessage && <p className="error-text">{errorMessage}</p>}
          {infoMessage && <p className="info-text">{infoMessage}</p>}
        </section>
      )}
    </main>
  );
}
