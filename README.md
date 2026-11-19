# Reproductor Offline (PWA)

PWA para escuchar **tus propios archivos de música** sin internet. Se instala desde GitHub Pages, se añade a la pantalla de inicio del iPhone y se comporta como una app (sin barra de Safari).

La música **no se sube a ningún servidor**: se copia al almacenamiento local del teléfono (IndexedDB). GitHub Pages solo sirve el HTML/CSS/JS (~50 KB).

## Puesta en marcha en el iPhone

1. Sube esta carpeta a un repositorio de GitHub (instrucciones abajo).
2. Abre la URL en **Safari** en el iPhone.
3. Pulsa **Compartir → Añadir a la pantalla de inicio**.
4. Abre la app desde el icono nuevo, pulsa **Importar** y elige tus archivos de **Archivos** (puedes seleccionar varios a la vez).
5. Ya está: funciona sin conexión y suena en segundo plano con los controles de la pantalla de bloqueo.

## Publicar en GitHub Pages

```bash
cd /home/rey/Proyectos/reproductor-pwa
git init
git add .
git commit -m "PWA reproductor offline"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/reproductor-pwa.git
git push -u origin main
```

Luego en GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main` / `/(root)` → Save**.

La URL será `https://TU_USUARIO.github.io/reproductor-pwa/`.

> El repositorio debe ser público (o tener GitHub Pro para privado). GitHub Pages da HTTPS automáticamente, requisito indispensable para el service worker.

Para probar antes de publicar, desde esta carpeta:

```bash
python3 -m http.server 8080
```

y abre `http://localhost:8080` (Safari trata `localhost` como seguro).

## Qué hace

- Importa mp3/m4a/aac/wav/ogg/flac/aiff desde Archivos y los guarda dentro del teléfono.
- Lee título, artista, álbum y carátula de etiquetas **ID3** en MP3. En otros formatos usa el nombre del archivo.
- Evita duplicados por nombre + tamaño.
- Reproduce en segundo plano y muestra título/artista/carátula en la pantalla de bloqueo y controles de auriculares (Media Session API).
- Play/pausa, anterior/siguiente, barra de progreso y borrado.
- Indicador de espacio usado y petición de almacenamiento persistente (`navigator.storage.persist()`).
- Service worker con cache-first del shell: abre sin red desde la segunda visita.

## Límites reales en iOS (importante)

| Tema | Comportamiento |
|---|---|
| Audio de fondo | Funciona usando el elemento `<audio>`. Se añade `navigator.audioSession.type = 'playback'` antes de reproducir para mejorar la reanudación tras bloquear. |
| Modo silencio | El switch de silencio **sí** afecta al audio web. Una app nativa puede ignorarlo; una PWA no. |
| Foco de audio | Si Siri o un mensaje interrumpen, la reproducción puede detenerse y no reanudarse sola. El botón de la pantalla de bloqueo sí la reanuda. |
| Autoplay | iOS exige un toque del usuario. No se puede iniciar automáticamente al abrir. |
| Instalación | iOS no tiene prompt de instalación: hay que hacerlo a mano desde Compartir. |
| Almacenamiento | Desde iOS 17, un PWA instalado tiene cuota de ~60 % del disco. Los datos se conservan mientras no borres los datos del sitio en Ajustes de Safari. |
| Apple Music | Las canciones descargadas en Apple Music tienen DRM y **no** se pueden importar. Solo archivos propios. |
| Carpetas | El selector de iOS permite varios archivos, pero no una carpeta completa de una sola vez. |

Es una PWA: es la contrapartida de no necesitar Apple Developer ni Xcode. Si algún día necesitas audio en segundo plano **garantizado** (ignorar el switch de silencio, recuperar el foco siempre), la única vía es la app nativa del proyecto `reproductor-offline-ios`.

## Estructura

```
index.html            Interfaz y elemento <audio>
styles.css            Estilos, safe-area de iOS
app.js                IndexedDB, ID3, reproductor, Media Session
sw.js                 Caché del shell offline
manifest.webmanifest  Instalación como app
icons/                Iconos 192/512/apple-touch generados desde icon.svg
README.md             Este archivo
```
