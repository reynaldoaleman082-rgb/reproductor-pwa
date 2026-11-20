/* Service worker: solo cachea la "cáscara" de la app (HTML/CSS/JS/iconos).
   El audio NO pasa por aquí: vive en IndexedDB dentro del teléfono. */

const VERSION = 'reproductor-shell-v18';
// Cachés de versiones anteriores, antes de que llevaran prefijo propio
const CACHES_ANTIGUAS = ['shell-v5', 'shell-v6', 'shell-v7'];
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (evento) => {
  evento.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (evento) => {
  // GitHub Pages comparte origen entre repositorios: solo borramos lo nuestro
  evento.waitUntil(
    caches.keys()
      .then((claves) => Promise.all(
        claves
          .filter((clave) =>
            (clave.startsWith('reproductor-shell-') && clave !== VERSION)
            || CACHES_ANTIGUAS.includes(clave))
          .map((clave) => caches.delete(clave))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (evento) => {
  if (evento.request.method !== 'GET') return;

  const url = new URL(evento.request.url);
  if (url.origin !== self.location.origin) return;

  evento.respondWith(
    caches.match(evento.request).then((guardado) => {
      if (guardado) return guardado;
      return fetch(evento.request)
        .then((respuesta) => {
          if (respuesta.ok) {
            const copia = respuesta.clone();
            caches.open(VERSION).then((cache) => cache.put(evento.request, copia));
          }
          return respuesta;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
