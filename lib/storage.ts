import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { withBasePath } from "@/lib/base-path";
import { getPublicPreviewUrlPath } from "@/lib/public-preview";

export type AudioKind = "upload" | "generated";
export type SourceType = "master" | "clip";
export type CollectionHookType = "spoken" | "text";

export interface AudioRecord {
  id: string;
  kind: AudioKind;
  sourceType: SourceType;
  path: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  durationSec: number | null;
  createdAt: string;
}

export interface FolderRecord {
  id: string;
  name: string;
  createdAt: string;
}

export interface SongRecord {
  id: string;
  name: string;
  folderId: string | null;
  masterAudioId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClipRecord {
  id: string;
  songId: string;
  name: string;
  sourceAudioId: string;
  startSec: number;
  endSec: number | null;
  createdAt: string;
}

export interface CollectionRecord {
  id: string;
  name: string;
  slug: string;
  allowDownloads: boolean;
  allowHooks: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionClipRecord {
  id: string;
  collectionId: string;
  clipId: string;
  sortOrder: number;
  createdAt: string;
}

export interface CollectionHookRecord {
  id: string;
  collectionClipId: string;
  type: CollectionHookType;
  text: string;
  isDisabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface LegacyStore {
  records?: Array<{
    id: string;
    kind: AudioKind;
    sourceType: SourceType;
    path: string;
    originalName: string;
    mimeType: string;
    sizeBytes: number;
    createdAt: string;
  }>;
}

interface AudioStore {
  version: 5;
  records: AudioRecord[];
  folders: FolderRecord[];
  songs: SongRecord[];
  clips: ClipRecord[];
  collections: CollectionRecord[];
  collectionClips: CollectionClipRecord[];
  collectionHooks: CollectionHookRecord[];
}

export interface LibraryAudioItem {
  id: string;
  name: string;
  url: string;
  mimeType: string;
  durationSec: number | null;
  sourceType: SourceType;
}

export interface LibraryClipItem {
  id: string;
  name: string;
  sourceId: string;
  url: string;
  startSec: number;
  endSec: number | null;
  createdAt: string;
}

export interface LibrarySongItem {
  id: string;
  name: string;
  folderId: string | null;
  master: LibraryAudioItem | null;
  clips: LibraryClipItem[];
  createdAt: string;
  updatedAt: string;
}

export interface LibraryFolderItem {
  id: string;
  name: string;
  songs: LibrarySongItem[];
}

export interface LibraryData {
  folders: LibraryFolderItem[];
  rootSongs: LibrarySongItem[];
}

export interface CollectionClipItem {
  id: string;
  clipId: string;
  songId: string;
  songName: string;
  clipName: string;
  sourceId: string;
  url: string;
  playbackUrl: string;
  downloadUrl: string;
  startSec: number;
  endSec: number | null;
  sortOrder: number;
  hooks: CollectionHookItem[];
}

export interface CollectionHookItem {
  id: string;
  type: CollectionHookType;
  text: string;
  isDisabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionItem {
  id: string;
  name: string;
  slug: string;
  allowDownloads: boolean;
  allowHooks: boolean;
  createdAt: string;
  updatedAt: string;
  clips: CollectionClipItem[];
}

const DATA_DIR = path.join(process.cwd(), "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const GENERATED_DIR = path.join(DATA_DIR, "generated");
const STORE_PATH = path.join(DATA_DIR, "store.json");

const EMPTY_STORE: AudioStore = {
  version: 5,
  records: [],
  folders: [],
  songs: [],
  clips: [],
  collections: [],
  collectionClips: [],
  collectionHooks: []
};

type CollectionRecordInput = Omit<CollectionRecord, "allowDownloads" | "allowHooks"> & {
  allowDownloads?: boolean;
  allowHooks?: boolean;
};

function normalizeCollectionRecords(records: CollectionRecordInput[]): CollectionRecord[] {
  return records.map((record) => ({
    ...record,
    allowDownloads: record.allowDownloads === true,
    allowHooks: record.allowHooks === true
  }));
}

type CollectionHookRecordInput = Omit<CollectionHookRecord, "isDisabled"> & {
  isDisabled?: boolean;
};

function normalizeCollectionHookRecords(records: CollectionHookRecordInput[]): CollectionHookRecord[] {
  return records
    .map((record) => {
      if (record.type !== "spoken" && record.type !== "text") {
        return null;
      }

      const text = sanitizeName(record.text || "");
      if (!text) {
        return null;
      }

      return {
        ...record,
        type: record.type,
        text,
        isDisabled: record.isDisabled === true
      };
    })
    .filter((record): record is CollectionHookRecord => record !== null);
}

function normalizeExtension(originalName: string, mimeType: string): string {
  const ext = path.extname(originalName || "").toLowerCase();
  if (ext) {
    return ext;
  }
  if (mimeType.includes("wav")) {
    return ".wav";
  }
  if (mimeType.includes("ogg")) {
    return ".ogg";
  }
  if (mimeType.includes("aac")) {
    return ".aac";
  }
  return ".mp3";
}

function sanitizeName(name: string): string {
  return name.replace(/[\u0000-\u001F\u007F]/g, "").trim();
}

function sanitizeRequiredName(name: string, fallback: string): string {
  const normalized = sanitizeName(name);
  return normalized || fallback;
}

function stripExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}

function normalizeFolderId(folderId: string | null | undefined): string | null {
  if (!folderId || folderId === "root") {
    return null;
  }
  return folderId;
}

function uniqueSongName(base: string, existing: Set<string>): string {
  if (!existing.has(base.toLowerCase())) {
    return base;
  }

  let idx = 2;
  while (existing.has(`${base} ${idx}`.toLowerCase())) {
    idx += 1;
  }
  return `${base} ${idx}`;
}

async function ensureStoreFile(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(UPLOAD_DIR, { recursive: true });
  await mkdir(GENERATED_DIR, { recursive: true });

  try {
    await readFile(STORE_PATH, "utf-8");
  } catch {
    await writeFile(STORE_PATH, JSON.stringify(EMPTY_STORE, null, 2), "utf-8");
  }
}

function migrateLegacyStore(parsed: LegacyStore): AudioStore {
  const legacyRecords = (parsed.records ?? []).map((record) => ({
    ...record,
    durationSec: null
  }));

  const songs: SongRecord[] = [];
  const clips: ClipRecord[] = [];
  const usedNames = new Set<string>();

  for (const record of legacyRecords) {
    const baseName = sanitizeName(stripExtension(record.originalName)) || "Cancion";
    const songName = uniqueSongName(baseName, usedNames);
    usedNames.add(songName.toLowerCase());

    const songId = randomUUID();
    const timestamp = record.createdAt || new Date().toISOString();

    const song: SongRecord = {
      id: songId,
      name: songName,
      folderId: null,
      masterAudioId: record.sourceType === "master" ? record.id : null,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    songs.push(song);

    if (record.sourceType === "clip") {
      clips.push({
        id: randomUUID(),
        songId,
        name: baseName || "Clip",
        sourceAudioId: record.id,
        startSec: 0,
        endSec: null,
        createdAt: timestamp
      });
    }
  }

  return {
    version: 5,
    records: legacyRecords,
    folders: [],
    songs,
    clips,
    collections: [],
    collectionClips: [],
    collectionHooks: []
  };
}

function parseStore(raw: string): AudioStore {
  try {
    const parsed = JSON.parse(raw) as Partial<AudioStore> | LegacyStore;

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as Partial<AudioStore>).version === 5 &&
      Array.isArray((parsed as Partial<AudioStore>).records) &&
      Array.isArray((parsed as Partial<AudioStore>).folders) &&
      Array.isArray((parsed as Partial<AudioStore>).songs) &&
      Array.isArray((parsed as Partial<AudioStore>).clips) &&
      Array.isArray((parsed as Partial<AudioStore>).collections) &&
      Array.isArray((parsed as Partial<AudioStore>).collectionClips) &&
      Array.isArray((parsed as Partial<AudioStore>).collectionHooks)
    ) {
      const normalizedCollections = normalizeCollectionRecords(
        (parsed as Partial<AudioStore>).collections as CollectionRecordInput[]
      );
      const normalizedHooks = normalizeCollectionHookRecords(
        (parsed as Partial<AudioStore>).collectionHooks as CollectionHookRecordInput[]
      );

      return {
        ...(parsed as AudioStore),
        collections: normalizedCollections,
        collectionHooks: normalizedHooks
      };
    }

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { version?: number }).version === 4 &&
      Array.isArray((parsed as Partial<AudioStore>).records) &&
      Array.isArray((parsed as Partial<AudioStore>).folders) &&
      Array.isArray((parsed as Partial<AudioStore>).songs) &&
      Array.isArray((parsed as Partial<AudioStore>).clips) &&
      Array.isArray((parsed as Partial<AudioStore>).collections) &&
      Array.isArray((parsed as Partial<AudioStore>).collectionClips)
    ) {
      const migratedV4 = parsed as unknown as {
        records: AudioRecord[];
        folders: FolderRecord[];
        songs: SongRecord[];
        clips: ClipRecord[];
        collections: CollectionRecordInput[];
        collectionClips: CollectionClipRecord[];
      };

      return {
        version: 5,
        records: migratedV4.records,
        folders: migratedV4.folders,
        songs: migratedV4.songs,
        clips: migratedV4.clips,
        collections: normalizeCollectionRecords(migratedV4.collections),
        collectionClips: migratedV4.collectionClips,
        collectionHooks: []
      };
    }

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { version?: number }).version === 3 &&
      Array.isArray((parsed as Partial<AudioStore>).records) &&
      Array.isArray((parsed as Partial<AudioStore>).folders) &&
      Array.isArray((parsed as Partial<AudioStore>).songs) &&
      Array.isArray((parsed as Partial<AudioStore>).clips) &&
      Array.isArray((parsed as Partial<AudioStore>).collections) &&
      Array.isArray((parsed as Partial<AudioStore>).collectionClips)
    ) {
      const migratedV3 = parsed as unknown as {
        records: AudioRecord[];
        folders: FolderRecord[];
        songs: SongRecord[];
        clips: ClipRecord[];
        collections: CollectionRecordInput[];
        collectionClips: CollectionClipRecord[];
      };

      return {
        version: 5,
        records: migratedV3.records,
        folders: migratedV3.folders,
        songs: migratedV3.songs,
        clips: migratedV3.clips,
        collections: normalizeCollectionRecords(migratedV3.collections),
        collectionClips: migratedV3.collectionClips,
        collectionHooks: []
      };
    }

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { version?: number }).version === 2 &&
      Array.isArray((parsed as Partial<AudioStore>).records) &&
      Array.isArray((parsed as Partial<AudioStore>).folders) &&
      Array.isArray((parsed as Partial<AudioStore>).songs) &&
      Array.isArray((parsed as Partial<AudioStore>).clips)
    ) {
      const migrated = parsed as unknown as {
        records: AudioRecord[];
        folders: FolderRecord[];
        songs: SongRecord[];
        clips: ClipRecord[];
      };

      return {
        version: 5,
        records: migrated.records,
        folders: migrated.folders,
        songs: migrated.songs,
        clips: migrated.clips,
        collections: [],
        collectionClips: [],
        collectionHooks: []
      };
    }

    return migrateLegacyStore(parsed as LegacyStore);
  } catch {
    return EMPTY_STORE;
  }
}

async function readStore(): Promise<AudioStore> {
  await ensureStoreFile();
  const raw = await readFile(STORE_PATH, "utf-8");
  const store = parseStore(raw);
  let requiresMigrationWrite = false;
  try {
    const parsed = JSON.parse(raw) as {
      version?: number;
      collections?: CollectionRecordInput[];
      collectionHooks?: CollectionHookRecordInput[];
    };
    const hasInvalidCollections =
      Array.isArray(parsed.collections) &&
      parsed.collections.some(
        (collection) =>
          typeof collection.allowDownloads !== "boolean" || typeof collection.allowHooks !== "boolean"
      );
    const hasInvalidHooks =
      !Array.isArray(parsed.collectionHooks) ||
      parsed.collectionHooks.some(
        (hook) =>
          (hook.type !== "spoken" && hook.type !== "text") ||
          typeof hook.text !== "string" ||
          typeof hook.isDisabled !== "boolean"
      );
    requiresMigrationWrite = parsed.version !== 5 || hasInvalidCollections || hasInvalidHooks;
  } catch {
    requiresMigrationWrite = true;
  }

  if (requiresMigrationWrite) {
    await writeStore(store);
  }

  return store;
}

async function writeStore(store: AudioStore): Promise<void> {
  await ensureStoreFile();
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

function isAudioReferenced(store: AudioStore, audioId: string): boolean {
  return store.songs.some((song) => song.masterAudioId === audioId) || store.clips.some((clip) => clip.sourceAudioId === audioId);
}

async function removeRecordAndFileByAudioId(store: AudioStore, audioId: string): Promise<void> {
  const index = store.records.findIndex((record) => record.id === audioId);
  if (index < 0) {
    return;
  }

  const [removed] = store.records.splice(index, 1);
  await rm(removed.path, { force: true });
}

async function cleanupOrphanAudioRecords(store: AudioStore, candidateIds: Iterable<string>): Promise<void> {
  const uniqueIds = new Set(candidateIds);

  for (const audioId of uniqueIds) {
    if (!isAudioReferenced(store, audioId)) {
      await removeRecordAndFileByAudioId(store, audioId);
    }
  }
}

function mapAudioRecord(record: AudioRecord | undefined): LibraryAudioItem | null {
  if (!record) {
    return null;
  }

  return {
    id: record.id,
    name: record.originalName,
    url: withBasePath(`/api/files/${record.id}`),
    mimeType: record.mimeType,
    durationSec: record.durationSec,
    sourceType: record.sourceType
  };
}

function mapSongForLibrary(song: SongRecord, recordsById: Map<string, AudioRecord>, clipRecords: ClipRecord[]): LibrarySongItem {
  const master = mapAudioRecord(song.masterAudioId ? recordsById.get(song.masterAudioId) : undefined);

  const clips = clipRecords
    .filter((clip) => clip.songId === song.id)
    .map((clip) => {
      const audio = recordsById.get(clip.sourceAudioId);
      return {
        id: clip.id,
        name: clip.name,
        sourceId: clip.sourceAudioId,
        url: audio ? withBasePath(`/api/files/${audio.id}`) : "",
        startSec: clip.startSec,
        endSec: clip.endSec,
        createdAt: clip.createdAt
      };
    })
    .filter((clip) => Boolean(clip.url))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

  return {
    id: song.id,
    name: song.name,
    folderId: song.folderId,
    master,
    clips,
    createdAt: song.createdAt,
    updatedAt: song.updatedAt
  };
}

export async function getLibraryData(): Promise<LibraryData> {
  const store = await readStore();
  const recordsById = new Map(store.records.map((record) => [record.id, record]));

  const songsSorted = [...store.songs].sort((a, b) => a.name.localeCompare(b.name, "es"));

  const rootSongs = songsSorted
    .filter((song) => !song.folderId)
    .map((song) => mapSongForLibrary(song, recordsById, store.clips));

  const folders = store.folders
    .map((folder) => ({
      id: folder.id,
      name: folder.name,
      songs: songsSorted
        .filter((song) => song.folderId === folder.id)
        .map((song) => mapSongForLibrary(song, recordsById, store.clips))
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "es"));

  return {
    folders,
    rootSongs
  };
}

function slugify(input: string): string {
  const normalized = input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "collection";
}

function uniqueCollectionSlug(base: string, existing: Set<string>): string {
  if (!existing.has(base)) {
    return base;
  }

  let idx = 2;
  while (existing.has(`${base}-${idx}`)) {
    idx += 1;
  }
  return `${base}-${idx}`;
}

function mapCollectionForOutput(params: {
  collection: CollectionRecord;
  collectionClips: CollectionClipRecord[];
  collectionHooks: CollectionHookRecord[];
  clipsById: Map<string, ClipRecord>;
  songsById: Map<string, SongRecord>;
  recordsById: Map<string, AudioRecord>;
}): CollectionItem {
  const clips = params.collectionClips
    .filter((item) => item.collectionId === params.collection.id)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((item) => {
      const clip = params.clipsById.get(item.clipId);
      if (!clip) {
        return null;
      }
      const song = params.songsById.get(clip.songId);
      const audio = params.recordsById.get(clip.sourceAudioId);
      if (!song || !audio) {
        return null;
      }

      const hooks = params.collectionHooks
        .filter((hook) => hook.collectionClipId === item.id)
        .sort((a, b) => {
          if (a.type === b.type) {
            return a.createdAt < b.createdAt ? -1 : 1;
          }
          return a.type === "spoken" ? -1 : 1;
        })
        .map(
          (hook) =>
            ({
              id: hook.id,
              type: hook.type,
              text: hook.text,
              isDisabled: hook.isDisabled,
              createdAt: hook.createdAt,
              updatedAt: hook.updatedAt
            }) satisfies CollectionHookItem
        );

      return {
        id: item.id,
        clipId: clip.id,
        songId: song.id,
        songName: song.name,
        clipName: clip.name,
        sourceId: clip.sourceAudioId,
        url: withBasePath(`/api/public/collections/${params.collection.slug}/clips/${clip.id}/source`),
        playbackUrl: withBasePath(getPublicPreviewUrlPath(clip.id)),
        downloadUrl: withBasePath(`/api/public/collections/${params.collection.slug}/clips/${clip.id}/download`),
        startSec: clip.startSec,
        endSec: clip.endSec,
        sortOrder: item.sortOrder,
        hooks
      } satisfies CollectionClipItem;
    })
    .filter((clip): clip is CollectionClipItem => clip !== null);

  return {
    id: params.collection.id,
    name: params.collection.name,
    slug: params.collection.slug,
    allowDownloads: params.collection.allowDownloads,
    allowHooks: params.collection.allowHooks,
    createdAt: params.collection.createdAt,
    updatedAt: params.collection.updatedAt,
    clips
  };
}

export async function getCollectionsData(): Promise<CollectionItem[]> {
  const store = await readStore();
  const clipsById = new Map(store.clips.map((clip) => [clip.id, clip]));
  const songsById = new Map(store.songs.map((song) => [song.id, song]));
  const recordsById = new Map(store.records.map((record) => [record.id, record]));

  return [...store.collections]
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    .map((collection) =>
      mapCollectionForOutput({
        collection,
        collectionClips: store.collectionClips,
        collectionHooks: store.collectionHooks,
        clipsById,
        songsById,
        recordsById
      })
    );
}

export async function getPublicCollectionBySlug(slug: string): Promise<CollectionItem | null> {
  const store = await readStore();
  const collection = store.collections.find((item) => item.slug === slug);
  if (!collection) {
    return null;
  }

  const clipsById = new Map(store.clips.map((clip) => [clip.id, clip]));
  const songsById = new Map(store.songs.map((song) => [song.id, song]));
  const recordsById = new Map(store.records.map((record) => [record.id, record]));

  return mapCollectionForOutput({
    collection,
    collectionClips: store.collectionClips,
    collectionHooks: store.collectionHooks,
    clipsById,
    songsById,
    recordsById
  });
}

export interface PublicCollectionClipAudioAccess {
  collection: CollectionRecord;
  clip: ClipRecord;
  song: SongRecord;
  audio: AudioRecord;
}

export async function findPublicCollectionClipAudioBySlug(params: {
  slug: string;
  clipId: string;
}): Promise<PublicCollectionClipAudioAccess | null> {
  const store = await readStore();
  const collection = store.collections.find((item) => item.slug === params.slug);
  if (!collection) {
    return null;
  }

  const includedClip = store.collectionClips.some(
    (item) => item.collectionId === collection.id && item.clipId === params.clipId
  );
  if (!includedClip) {
    return null;
  }

  const clip = store.clips.find((item) => item.id === params.clipId);
  if (!clip) {
    return null;
  }

  const song = store.songs.find((item) => item.id === clip.songId);
  if (!song) {
    return null;
  }

  const audio = store.records.find((item) => item.id === clip.sourceAudioId);
  if (!audio) {
    return null;
  }

  return {
    collection,
    clip,
    song,
    audio
  };
}

export async function createCollection(params: {
  name: string;
  slug?: string | null;
  allowDownloads?: boolean;
  allowHooks?: boolean;
}): Promise<CollectionRecord> {
  const store = await readStore();
  const name = sanitizeRequiredName(params.name, "Colección");

  const slugBase = slugify(params.slug ? sanitizeName(params.slug) : name);
  const existingSlugs = new Set(store.collections.map((item) => item.slug));
  const slug = uniqueCollectionSlug(slugBase, existingSlugs);

  const now = new Date().toISOString();
  const collection: CollectionRecord = {
    id: randomUUID(),
    name,
    slug,
    allowDownloads: params.allowDownloads === true,
    allowHooks: params.allowHooks === true,
    createdAt: now,
    updatedAt: now
  };

  store.collections.push(collection);
  await writeStore(store);
  return collection;
}

export async function updateCollection(params: {
  collectionId: string;
  name?: string | null;
  slug?: string | null;
  allowDownloads?: boolean;
  allowHooks?: boolean;
}): Promise<CollectionRecord> {
  const store = await readStore();
  const collection = store.collections.find((item) => item.id === params.collectionId);
  if (!collection) {
    throw new Error("Colección no encontrada");
  }

  if (typeof params.name === "string") {
    collection.name = sanitizeRequiredName(params.name, collection.name);
  }

  if (typeof params.slug === "string") {
    const requested = slugify(params.slug);
    const existingSlugs = new Set(store.collections.filter((item) => item.id !== collection.id).map((item) => item.slug));
    collection.slug = uniqueCollectionSlug(requested, existingSlugs);
  }

  if (typeof params.allowDownloads === "boolean") {
    collection.allowDownloads = params.allowDownloads;
  }

  if (typeof params.allowHooks === "boolean") {
    collection.allowHooks = params.allowHooks;
  }

  collection.updatedAt = new Date().toISOString();
  await writeStore(store);
  return collection;
}

export async function deleteCollectionById(collectionId: string): Promise<boolean> {
  const store = await readStore();
  const index = store.collections.findIndex((item) => item.id === collectionId);
  if (index < 0) {
    return false;
  }

  store.collections.splice(index, 1);
  const removedCollectionClipIds = new Set(
    store.collectionClips.filter((item) => item.collectionId === collectionId).map((item) => item.id)
  );
  store.collectionClips = store.collectionClips.filter((item) => item.collectionId !== collectionId);
  store.collectionHooks = store.collectionHooks.filter((hook) => !removedCollectionClipIds.has(hook.collectionClipId));
  await writeStore(store);
  return true;
}

export async function addClipToCollection(params: {
  collectionId: string;
  clipId: string;
}): Promise<CollectionClipRecord> {
  const store = await readStore();
  const collection = store.collections.find((item) => item.id === params.collectionId);
  if (!collection) {
    throw new Error("Colección no encontrada");
  }
  const clip = store.clips.find((item) => item.id === params.clipId);
  if (!clip) {
    throw new Error("Clip no encontrado");
  }

  const existing = store.collectionClips.find(
    (item) => item.collectionId === params.collectionId && item.clipId === params.clipId
  );
  if (existing) {
    return existing;
  }

  const maxSort = store.collectionClips
    .filter((item) => item.collectionId === params.collectionId)
    .reduce((max, item) => Math.max(max, item.sortOrder), 0);

  const record: CollectionClipRecord = {
    id: randomUUID(),
    collectionId: params.collectionId,
    clipId: params.clipId,
    sortOrder: maxSort + 1,
    createdAt: new Date().toISOString()
  };

  store.collectionClips.push(record);
  collection.updatedAt = new Date().toISOString();
  await writeStore(store);
  return record;
}

export async function removeClipFromCollection(params: {
  collectionId: string;
  clipId: string;
}): Promise<boolean> {
  const store = await readStore();
  const removedCollectionClipIds = new Set(
    store.collectionClips
      .filter((item) => item.collectionId === params.collectionId && item.clipId === params.clipId)
      .map((item) => item.id)
  );
  const before = store.collectionClips.length;
  store.collectionClips = store.collectionClips.filter(
    (item) => !(item.collectionId === params.collectionId && item.clipId === params.clipId)
  );
  if (store.collectionClips.length === before) {
    return false;
  }

  store.collectionHooks = store.collectionHooks.filter((hook) => !removedCollectionClipIds.has(hook.collectionClipId));

  const collection = store.collections.find((item) => item.id === params.collectionId);
  if (collection) {
    collection.updatedAt = new Date().toISOString();
  }

  await writeStore(store);
  return true;
}

function resolveCollectionClipForHook(params: {
  store: AudioStore;
  collectionId: string;
  clipId: string;
}): { collection: CollectionRecord; collectionClip: CollectionClipRecord } {
  const collection = params.store.collections.find((item) => item.id === params.collectionId);
  if (!collection) {
    throw new Error("Colección no encontrada");
  }

  const collectionClip = params.store.collectionClips.find(
    (item) => item.collectionId === params.collectionId && item.clipId === params.clipId
  );
  if (!collectionClip) {
    throw new Error("Clip no encontrado en la colección");
  }

  return { collection, collectionClip };
}

export async function addHookToCollectionClip(params: {
  collectionId: string;
  clipId: string;
  type: CollectionHookType;
  text: string;
  isDisabled?: boolean;
}): Promise<CollectionHookRecord> {
  const store = await readStore();
  const { collection, collectionClip } = resolveCollectionClipForHook({
    store,
    collectionId: params.collectionId,
    clipId: params.clipId
  });

  if (params.type !== "spoken" && params.type !== "text") {
    throw new Error("Tipo de hook no válido");
  }

  const text = sanitizeName(params.text);
  if (!text) {
    throw new Error("El texto del hook es obligatorio");
  }

  const now = new Date().toISOString();
  const hook: CollectionHookRecord = {
    id: randomUUID(),
    collectionClipId: collectionClip.id,
    type: params.type,
    text,
    isDisabled: params.isDisabled === true,
    createdAt: now,
    updatedAt: now
  };

  store.collectionHooks.push(hook);
  collection.updatedAt = now;
  await writeStore(store);
  return hook;
}

export async function updateCollectionClipHook(params: {
  collectionId: string;
  clipId: string;
  hookId: string;
  text?: string | null;
  isDisabled?: boolean;
}): Promise<CollectionHookRecord> {
  const store = await readStore();
  const { collection, collectionClip } = resolveCollectionClipForHook({
    store,
    collectionId: params.collectionId,
    clipId: params.clipId
  });

  const hook = store.collectionHooks.find(
    (item) => item.id === params.hookId && item.collectionClipId === collectionClip.id
  );
  if (!hook) {
    throw new Error("Hook no encontrado");
  }

  if (typeof params.text === "string") {
    hook.text = sanitizeRequiredName(params.text, hook.text);
  }

  if (typeof params.isDisabled === "boolean") {
    hook.isDisabled = params.isDisabled;
  }

  const now = new Date().toISOString();
  hook.updatedAt = now;
  collection.updatedAt = now;
  await writeStore(store);
  return hook;
}

export async function updatePublicCollectionHookBySlug(params: {
  slug: string;
  clipId: string;
  hookId: string;
  isDisabled?: boolean;
}): Promise<CollectionHookRecord> {
  const store = await readStore();
  const collection = store.collections.find((item) => item.slug === params.slug);
  if (!collection) {
    throw new Error("Colección no encontrada");
  }
  if (!collection.allowHooks) {
    throw new Error("Los hooks no están habilitados para esta colección");
  }

  const collectionClip = store.collectionClips.find(
    (item) => item.collectionId === collection.id && item.clipId === params.clipId
  );
  if (!collectionClip) {
    throw new Error("Clip no encontrado en la colección");
  }

  const hook = store.collectionHooks.find(
    (item) => item.id === params.hookId && item.collectionClipId === collectionClip.id
  );
  if (!hook) {
    throw new Error("Hook no encontrado");
  }

  if (typeof params.isDisabled === "boolean") {
    hook.isDisabled = params.isDisabled;
  }

  const now = new Date().toISOString();
  hook.updatedAt = now;
  collection.updatedAt = now;
  await writeStore(store);
  return hook;
}

export async function removeCollectionClipHook(params: {
  collectionId: string;
  clipId: string;
  hookId: string;
}): Promise<boolean> {
  const store = await readStore();
  const { collection, collectionClip } = resolveCollectionClipForHook({
    store,
    collectionId: params.collectionId,
    clipId: params.clipId
  });

  const before = store.collectionHooks.length;
  store.collectionHooks = store.collectionHooks.filter(
    (item) => !(item.id === params.hookId && item.collectionClipId === collectionClip.id)
  );
  if (store.collectionHooks.length === before) {
    return false;
  }

  collection.updatedAt = new Date().toISOString();
  await writeStore(store);
  return true;
}

export async function createFolder(name: string): Promise<FolderRecord> {
  const store = await readStore();
  const normalizedName = sanitizeRequiredName(name, "Proyecto");

  if (!normalizedName) {
    throw new Error("El nombre de la carpeta es obligatorio");
  }

  const existing = store.folders.find((folder) => folder.name.toLowerCase() === normalizedName.toLowerCase());
  if (existing) {
    return existing;
  }

  const folder: FolderRecord = {
    id: randomUUID(),
    name: normalizedName,
    createdAt: new Date().toISOString()
  };

  store.folders.push(folder);
  await writeStore(store);
  return folder;
}

export async function renameFolder(params: {
  folderId: string;
  name: string;
}): Promise<FolderRecord> {
  const store = await readStore();
  const folder = store.folders.find((item) => item.id === params.folderId);

  if (!folder) {
    throw new Error("Carpeta no encontrada");
  }

  const normalizedName = sanitizeRequiredName(params.name, folder.name);
  const existing = store.folders.find(
    (item) => item.id !== folder.id && item.name.toLowerCase() === normalizedName.toLowerCase()
  );
  if (existing) {
    throw new Error("Ya existe otra carpeta con ese nombre");
  }

  folder.name = normalizedName;
  await writeStore(store);
  return folder;
}

export async function findSongById(songId: string): Promise<SongRecord | null> {
  const store = await readStore();
  return store.songs.find((song) => song.id === songId) ?? null;
}

export async function moveSongToFolder(params: {
  songId: string;
  folderId: string | null;
}): Promise<SongRecord> {
  const store = await readStore();
  const song = store.songs.find((item) => item.id === params.songId);

  if (!song) {
    throw new Error("Canción no encontrada");
  }

  const normalizedFolderId = normalizeFolderId(params.folderId);
  if (normalizedFolderId && !store.folders.some((folder) => folder.id === normalizedFolderId)) {
    throw new Error("La carpeta destino no existe");
  }

  song.folderId = normalizedFolderId;
  song.updatedAt = new Date().toISOString();
  await writeStore(store);

  return song;
}

export async function renameSong(params: {
  songId: string;
  name: string;
}): Promise<SongRecord> {
  const store = await readStore();
  const song = store.songs.find((item) => item.id === params.songId);

  if (!song) {
    throw new Error("Canción no encontrada");
  }

  const normalizedName = sanitizeRequiredName(params.name, song.name);
  const existing = store.songs.find(
    (item) =>
      item.id !== song.id &&
      item.folderId === song.folderId &&
      item.name.toLowerCase() === normalizedName.toLowerCase()
  );
  if (existing) {
    throw new Error("Ya existe otra canción con ese nombre en la misma carpeta");
  }

  song.name = normalizedName;
  song.updatedAt = new Date().toISOString();
  await writeStore(store);

  return song;
}

async function resolveSongTarget(store: AudioStore, params: {
  songId?: string | null;
  songName?: string | null;
  folderId?: string | null;
}): Promise<SongRecord> {
  const normalizedFolderId = normalizeFolderId(params.folderId);

  if (params.songId) {
    const existing = store.songs.find((song) => song.id === params.songId);
    if (!existing) {
      throw new Error("La canción seleccionada no existe");
    }
    return existing;
  }

  const rawName = sanitizeName(params.songName || "");
  if (!rawName) {
    throw new Error("Debes seleccionar o crear una canción destino");
  }

  const sameSong = store.songs.find(
    (song) => song.folderId === normalizedFolderId && song.name.toLowerCase() === rawName.toLowerCase()
  );

  if (sameSong) {
    return sameSong;
  }

  if (normalizedFolderId && !store.folders.some((folder) => folder.id === normalizedFolderId)) {
    throw new Error("La carpeta/proyecto seleccionada no existe");
  }

  const now = new Date().toISOString();
  const created: SongRecord = {
    id: randomUUID(),
    name: rawName,
    folderId: normalizedFolderId,
    masterAudioId: null,
    createdAt: now,
    updatedAt: now
  };

  store.songs.push(created);
  return created;
}

export async function saveUploadedAudio(file: File, sourceType: SourceType): Promise<AudioRecord> {
  await ensureStoreFile();

  const id = randomUUID();
  const extension = normalizeExtension(file.name, file.type || "");
  const savedName = `${id}${extension}`;
  const targetPath = path.join(UPLOAD_DIR, savedName);
  const arrayBuffer = await file.arrayBuffer();
  const sizeBytes = arrayBuffer.byteLength;

  await writeFile(targetPath, Buffer.from(arrayBuffer));

  const record: AudioRecord = {
    id,
    kind: "upload",
    sourceType,
    path: targetPath,
    originalName: sanitizeName(file.name || `audio-${id}${extension}`),
    mimeType: file.type || "audio/mpeg",
    sizeBytes,
    durationSec: null,
    createdAt: new Date().toISOString()
  };

  const store = await readStore();
  store.records.push(record);
  await writeStore(store);

  return record;
}

export async function setAudioDuration(audioId: string, durationSec: number | null): Promise<void> {
  const store = await readStore();
  const record = store.records.find((item) => item.id === audioId);

  if (!record) {
    return;
  }

  record.durationSec = durationSec;
  await writeStore(store);
}

export async function addGeneratedAudio(params: {
  sourceType: SourceType;
  path: string;
  mimeType: string;
  originalName: string;
  sizeBytes: number;
}): Promise<AudioRecord> {
  const id = randomUUID();
  const record: AudioRecord = {
    id,
    kind: "generated",
    sourceType: params.sourceType,
    path: params.path,
    mimeType: params.mimeType,
    originalName: sanitizeName(params.originalName),
    sizeBytes: params.sizeBytes,
    durationSec: null,
    createdAt: new Date().toISOString()
  };

  const store = await readStore();
  store.records.push(record);
  await writeStore(store);

  return record;
}

export async function findAudioById(id: string): Promise<AudioRecord | null> {
  const store = await readStore();
  return store.records.find((record) => record.id === id) ?? null;
}

export async function findClipById(id: string): Promise<ClipRecord | null> {
  const store = await readStore();
  return store.clips.find((clip) => clip.id === id) ?? null;
}

export async function registerUploadedAudioToSong(params: {
  songId?: string | null;
  songName?: string | null;
  folderId?: string | null;
  sourceType: SourceType;
  audioId: string;
  clipName?: string | null;
  clipEndSec?: number | null;
}): Promise<{ song: SongRecord; clipId: string | null }> {
  const store = await readStore();
  const song = await resolveSongTarget(store, {
    songId: params.songId,
    songName: params.songName,
    folderId: params.folderId
  });

  const now = new Date().toISOString();
  let clipId: string | null = null;

  if (params.sourceType === "master") {
    song.masterAudioId = params.audioId;
    song.updatedAt = now;
  } else {
    const clipName = sanitizeName(params.clipName || `Clip ${store.clips.length + 1}`) || `Clip ${store.clips.length + 1}`;
    const clip: ClipRecord = {
      id: randomUUID(),
      songId: song.id,
      name: clipName,
      sourceAudioId: params.audioId,
      startSec: 0,
      endSec: params.clipEndSec ?? null,
      createdAt: now
    };

    store.clips.push(clip);
    song.updatedAt = now;
    clipId = clip.id;
  }

  await writeStore(store);
  return { song, clipId };
}

export async function createSongClip(params: {
  songId: string;
  name: string;
  sourceAudioId: string;
  startSec: number;
  endSec: number | null;
}): Promise<ClipRecord> {
  const store = await readStore();
  const song = store.songs.find((item) => item.id === params.songId);

  if (!song) {
    throw new Error("Canción no encontrada");
  }

  const sourceRecord = store.records.find((item) => item.id === params.sourceAudioId);
  if (!sourceRecord) {
    throw new Error("Audio de origen no encontrado");
  }

  const clip: ClipRecord = {
    id: randomUUID(),
    songId: params.songId,
    name: sanitizeName(params.name) || `Clip ${store.clips.length + 1}`,
    sourceAudioId: params.sourceAudioId,
    startSec: Math.max(0, params.startSec),
    endSec: params.endSec !== null ? Math.max(params.endSec, params.startSec) : null,
    createdAt: new Date().toISOString()
  };

  store.clips.push(clip);
  song.updatedAt = new Date().toISOString();
  await writeStore(store);

  return clip;
}

export async function renameClip(params: {
  clipId: string;
  name: string;
}): Promise<ClipRecord> {
  const store = await readStore();
  const clip = store.clips.find((item) => item.id === params.clipId);

  if (!clip) {
    throw new Error("Clip no encontrado");
  }

  clip.name = sanitizeRequiredName(params.name, clip.name);
  const song = store.songs.find((item) => item.id === clip.songId);
  if (song) {
    song.updatedAt = new Date().toISOString();
  }

  await writeStore(store);
  return clip;
}

export async function updateClip(params: {
  clipId: string;
  name?: string;
  startSec?: number;
  endSec?: number | null;
}): Promise<ClipRecord> {
  const store = await readStore();
  const clip = store.clips.find((item) => item.id === params.clipId);
  if (!clip) {
    throw new Error("Clip no encontrado");
  }

  if (typeof params.name === "string") {
    clip.name = sanitizeRequiredName(params.name, clip.name);
  }

  if (typeof params.startSec === "number" && Number.isFinite(params.startSec)) {
    clip.startSec = Math.max(0, params.startSec);
  }

  if (params.endSec === null) {
    clip.endSec = null;
  } else if (typeof params.endSec === "number" && Number.isFinite(params.endSec)) {
    clip.endSec = Math.max(params.endSec, clip.startSec);
  }

  const song = store.songs.find((item) => item.id === clip.songId);
  if (song) {
    song.updatedAt = new Date().toISOString();
  }

  await writeStore(store);
  return clip;
}

export async function deleteClipById(clipId: string): Promise<boolean> {
  const store = await readStore();
  const index = store.clips.findIndex((clip) => clip.id === clipId);

  if (index < 0) {
    return false;
  }

  const [removed] = store.clips.splice(index, 1);
  const removedCollectionClipIds = new Set(
    store.collectionClips.filter((item) => item.clipId === removed.id).map((item) => item.id)
  );
  store.collectionClips = store.collectionClips.filter((item) => item.clipId !== removed.id);
  store.collectionHooks = store.collectionHooks.filter((hook) => !removedCollectionClipIds.has(hook.collectionClipId));
  const song = store.songs.find((item) => item.id === removed.songId);
  if (song) {
    song.updatedAt = new Date().toISOString();
  }

  await cleanupOrphanAudioRecords(store, [removed.sourceAudioId]);
  await writeStore(store);
  return true;
}

async function deleteSongInStore(store: AudioStore, songId: string): Promise<boolean> {
  const songIndex = store.songs.findIndex((song) => song.id === songId);
  if (songIndex < 0) {
    return false;
  }

  const [song] = store.songs.splice(songIndex, 1);
  const removedClips = store.clips.filter((clip) => clip.songId === songId);
  store.clips = store.clips.filter((clip) => clip.songId !== songId);
  const removedClipIds = new Set(removedClips.map((clip) => clip.id));
  store.collectionClips = store.collectionClips.filter((item) => !removedClipIds.has(item.clipId));

  const candidateAudioIds = new Set<string>();
  if (song.masterAudioId) {
    candidateAudioIds.add(song.masterAudioId);
  }
  removedClips.forEach((clip) => {
    candidateAudioIds.add(clip.sourceAudioId);
  });

  await cleanupOrphanAudioRecords(store, candidateAudioIds);
  return true;
}

export async function deleteSongById(songId: string): Promise<boolean> {
  const store = await readStore();
  const deleted = await deleteSongInStore(store, songId);
  if (!deleted) {
    return false;
  }

  await writeStore(store);
  return true;
}

export async function deleteFolderById(folderId: string): Promise<boolean> {
  const store = await readStore();
  const folderIndex = store.folders.findIndex((folder) => folder.id === folderId);
  if (folderIndex < 0) {
    return false;
  }

  const songIds = store.songs.filter((song) => song.folderId === folderId).map((song) => song.id);
  for (const songId of songIds) {
    await deleteSongInStore(store, songId);
  }

  store.folders.splice(folderIndex, 1);
  await writeStore(store);
  return true;
}

export function getGeneratedDir(): string {
  return GENERATED_DIR;
}

export function sanitizeFilenameStem(input: string): string {
  const cleaned = input.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned || "clip";
}
