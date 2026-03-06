# Audio Clipper Studio

Aplicación Next.js para gestionar una biblioteca de audio por proyectos, canciones, masters y clips.

Incluye:
- Persistencia de biblioteca en `data/store.json` (visible tras recargar)
- Estructura `Proyecto/Carpeta -> Canción -> Master + Clips`
- Subida de clips aunque no exista master todavía
- Asignación de master posterior a una canción ya creada
- Editor visual para crear clips desde master con preview en bucle
- Reproducción de clips con delay + cuenta atrás
- Descarga de clips con o sin ajustes globales

## Requisitos

- Node.js 18+
- `ffmpeg` y `ffprobe` instalados en el sistema

## Instalación

```bash
npm install
```

## Desarrollo

```bash
npm run dev
```

Abre `http://localhost:3000`.

## Flujo

1. Crea/selecciona un proyecto (carpeta) y una canción destino.
2. Sube un audio como `master` o como `clip`.
3. Si hay master, usa el editor para definir inicio/fin, preview en bucle y guardar clips.
4. Configura delay y cuenta atrás global.
5. Reproduce cada clip con `Play` / `Stop`.
6. Descarga cada clip:
   - `Descargar clip` (sin cuenta atrás ni delay)
   - `Descargar con ajustes` (usa delay/cuenta atrás configurados)

## API

- `GET /api/library`: devuelve biblioteca completa (proyectos/canciones/masters/clips)
- `POST /api/library/folders`: crea carpeta/proyecto
- `POST /api/upload`: guarda audio subido y lo asocia a canción
- `POST /api/clips`: crea clip desde master para una canción
- `DELETE /api/clips/:id`: elimina clip
- `GET /api/files/:id`: stream del audio guardado
- `GET /api/countdown`: stream de `cuenta atras.wav`
- `POST /api/render`: genera un nuevo audio con ffmpeg
