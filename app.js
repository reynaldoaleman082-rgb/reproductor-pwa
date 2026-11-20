/* Reproductor Offline: toda la música se guarda en IndexedDB en el teléfono.
   No hay servidor de audio ni llamadas de red al reproducir. */

const $ = (selector) => document.querySelector(selector);

const audio = $('#audio');
const entradaArchivos = $('#entrada-archivos');
const lista = $('#lista-canciones');
const vistaVacia = $('#vacio');
const reproductor = $('#reproductor');
const pantalla = $('#pantalla-completa');
const aviso = $('#aviso');
const progreso = $('#progreso');
const miniProgreso = $('#mini-progreso');
const tiempoActual = $('#tiempo-actual');
const tiempoTotal = $('#tiempo-total');
const estadoAlmacenamiento = $('#estado-almacenamiento');

const DB_NAME = 'reproductor-offline';
const STORE = 'tracks';
const CLAVE_PREFERENCIAS = 'reproductor-preferencias';
const MODOS_REPETICION = ['off', 'all', 'one'];
const ETIQUETAS_REPETICION = { off: 'desactivada', all: 'todas', one: 'una canción' };

const EXTENSIONES = ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'flac', 'aiff', 'aif', 'caf', 'opus'];

let baseDatos;
let canciones = [];
let idActual = null;
let urlAudioActual = null;
let urlCaratulaActual = null;
let urlsCaratulas = [];
let temporizadorAviso;

// Preferencias de reproducción (se conservan entre sesiones)
let modoRepeticion = 'off'; // off | all | one
let aleatorio = false;
let historialAleatorio = [];

// ---------------------------------------------------------------------------
// Iconos SVG (misma familia en toda la interfaz, sin emojis)
// ---------------------------------------------------------------------------

function crearIcono(nombre, claseExtra = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `icono${claseExtra ? ` ${claseExtra}` : ''}`);
  svg.setAttribute('aria-hidden', 'true');
  const uso = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  uso.setAttribute('href', `#i-${nombre}`);
  svg.append(uso);
  return svg;
}

function cargarPreferencias() {
  try {
    const datos = JSON.parse(localStorage.getItem(CLAVE_PREFERENCIAS) || '{}');
    if (MODOS_REPETICION.includes(datos.modoRepeticion)) {
      modoRepeticion = datos.modoRepeticion;
    }
    aleatorio = Boolean(datos.aleatorio);
  } catch (_) {
    // Preferencias corruptas: se usan los valores por defecto.
  }
}

function guardarPreferencias() {
  try {
    localStorage.setItem(CLAVE_PREFERENCIAS, JSON.stringify({
      modoRepeticion,
      aleatorio
    }));
  } catch (_) {
    // Almacenamiento no disponible: los botones siguen funcionando en esta sesión.
  }
}

function actualizarBotonesModos() {
  for (const boton of document.querySelectorAll('[data-modo]')) {
    const esAleatorio = boton.dataset.modo === 'aleatorio';
    const activo = esAleatorio ? aleatorio : modoRepeticion !== 'off';

    boton.classList.toggle('is-activo', activo);
    boton.setAttribute('aria-pressed', String(activo));

    if (esAleatorio) {
      boton.setAttribute('aria-label', `Aleatorio: ${aleatorio ? 'activado' : 'desactivado'}`);
    } else {
      boton.setAttribute('aria-label', `Repetición: ${ETIQUETAS_REPETICION[modoRepeticion]}`);
      boton.querySelector('use').setAttribute(
        'href',
        modoRepeticion === 'one' ? '#i-repetir-uno' : '#i-repetir'
      );
    }
  }
}

function alternarRepeticion() {
  modoRepeticion = MODOS_REPETICION[
    (MODOS_REPETICION.indexOf(modoRepeticion) + 1) % MODOS_REPETICION.length
  ];
  guardarPreferencias();
  actualizarBotonesModos();
  const avisos = {
    off: 'Repetición desactivada',
    all: 'Repetir todas las canciones',
    one: 'Repetir esta canción'
  };
  mostrarAviso(avisos[modoRepeticion]);
}

function alternarAleatorio() {
  aleatorio = !aleatorio;
  historialAleatorio = [];
  guardarPreferencias();
  actualizarBotonesModos();
  mostrarAviso(aleatorio ? 'Aleatorio activado' : 'Aleatorio desactivado');
}

// ---------------------------------------------------------------------------
// Base de datos local
// ---------------------------------------------------------------------------

function abrirBaseDatos() {
  return new Promise((resolver, rechazar) => {
    const peticion = indexedDB.open(DB_NAME, 1);
    peticion.onupgradeneeded = () => {
      const db = peticion.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    peticion.onsuccess = () => resolver(peticion.result);
    peticion.onerror = () => rechazar(peticion.error);
  });
}

async function operarDB(modo, accion) {
  const db = await baseDatos;
  return new Promise((resolver, rechazar) => {
    const transaccion = db.transaction(STORE, modo);
    const almacen = transaccion.objectStore(STORE);
    const peticion = accion(almacen);
    transaccion.oncomplete = () => resolver(peticion ? peticion.result : undefined);
    transaccion.onerror = () => rechazar(transaccion.error);
    transaccion.onabort = () => rechazar(transaccion.error);
  });
}

async function cargarCanciones() {
  canciones = (await operarDB('readonly', (almacen) => almacen.getAll())) || [];
  canciones.sort((a, b) => b.fecha - a.fecha);
  dibujarBiblioteca();
  dibujarReproductor();
  await mostrarEspacio();
  if (idActual && !canciones.some((c) => c.id === idActual)) {
    detener();
  }
}

// ---------------------------------------------------------------------------
// Lectura de metadatos ID3 (MP3). En otros formatos se usa el nombre de archivo.
// ---------------------------------------------------------------------------

function synchsafe(vista, offset) {
  return ((vista.getUint8(offset) & 0x7f) << 21)
    | ((vista.getUint8(offset + 1) & 0x7f) << 14)
    | ((vista.getUint8(offset + 2) & 0x7f) << 7)
    | (vista.getUint8(offset + 3) & 0x7f);
}

function decodificarTexto(bytes, inicio, fin, codificacion) {
  const etiquetas = ['windows-1252', 'utf-16le', 'utf-16be', 'utf-8'];
  let etiqueta = etiquetas[codificacion] || 'utf-8';
  let desde = inicio;
  if (codificacion === 1 && fin - desde >= 2) {
    if (bytes[desde] === 0xff && bytes[desde + 1] === 0xfe) {
      desde += 2;
    } else if (bytes[desde] === 0xfe && bytes[desde + 1] === 0xff) {
      etiqueta = 'utf-16be';
      desde += 2;
    }
  }
  const texto = new TextDecoder(etiqueta).decode(bytes.subarray(desde, fin));
  return texto.replace(/\0+$/, '').trim() || null;
}

function leerCaratula(bytes, inicio, fin) {
  const codificacion = bytes[inicio];
  let i = inicio + 1;
  let finMime = i;
  while (finMime < fin && bytes[finMime] !== 0) finMime++;
  const mime = new TextDecoder().decode(bytes.subarray(i, finMime)) || 'image/jpeg';
  i = finMime + 1;
  if (i >= fin) return null;
  i += 1; // tipo de imagen (portada, etc.)
  const anchoNulo = codificacion === 1 || codificacion === 2 ? 2 : 1;
  while (i + anchoNulo <= fin) {
    const esNulo = anchoNulo === 1
      ? bytes[i] === 0
      : bytes[i] === 0 && bytes[i + 1] === 0;
    if (esNulo) {
      i += anchoNulo;
      break;
    }
    i += anchoNulo;
  }
  if (i >= fin) return null;
  return new Blob([bytes.slice(i, fin)], { type: mime });
}

function leerID3(buffer) {
  const resultado = { titulo: null, artista: null, album: null, caratula: null };
  if (buffer.byteLength < 10) return resultado;

  const vista = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return resultado;

  const version = bytes[3];
  const tamaño = synchsafe(vista, 6);
  const fin = Math.min(bytes.length, 10 + tamaño);
  let offset = 10;

  while (offset + (version === 2 ? 6 : 10) <= fin) {
    let id;
    let tamañoFrame;
    let cabecera;

    if (version === 2) {
      id = String.fromCharCode(...bytes.subarray(offset, offset + 3));
      tamañoFrame = (bytes[offset + 3] << 16) | (bytes[offset + 4] << 8) | bytes[offset + 5];
      cabecera = 6;
    } else {
      id = String.fromCharCode(...bytes.subarray(offset, offset + 4));
      tamañoFrame = version === 4 ? synchsafe(vista, offset + 4) : vista.getUint32(offset + 4);
      cabecera = 10;
    }

    if (tamañoFrame <= 0) break;
    const inicioDatos = offset + cabecera;
    const finDatos = inicioDatos + tamañoFrame;
    if (finDatos > fin) break;

    const textos = version === 2
      ? { TT2: 'titulo', TP1: 'artista', TAL: 'album' }
      : { TIT2: 'titulo', TPE1: 'artista', TALB: 'album' };

    if (textos[id]) {
      resultado[textos[id]] = decodificarTexto(
        bytes, inicioDatos + 1, finDatos, bytes[inicioDatos]
      );
    } else if ((id === 'APIC' || id === 'PIC') && !resultado.caratula) {
      resultado.caratula = leerCaratula(bytes, inicioDatos, finDatos);
    }

    offset = finDatos;
  }

  return resultado;
}

function nombreLimpio(nombre) {
  return nombre.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
}

function esAudio(archivo) {
  if (archivo.type.startsWith('audio/')) return true;
  const ext = archivo.name.split('.').pop().toLowerCase();
  return EXTENSIONES.includes(ext);
}

function idNuevo() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function prepararCancion(archivo) {
  const cabecera = await archivo.slice(0, 256 * 1024).arrayBuffer();
  const meta = leerID3(cabecera);
  return {
    id: idNuevo(),
    nombre: archivo.name,
    blob: archivo,
    mime: archivo.type || `audio/${archivo.name.split('.').pop().toLowerCase()}`,
    titulo: meta.titulo || nombreLimpio(archivo.name),
    artista: meta.artista || 'Artista desconocido',
    album: meta.album || 'Álbum desconocido',
    caratula: meta.caratula,
    fecha: Date.now()
  };
}

// ---------------------------------------------------------------------------
// Interfaz
// ---------------------------------------------------------------------------

function formatoTiempo(segundos) {
  if (!Number.isFinite(segundos) || segundos < 0) return '0:00';
  const total = Math.floor(segundos);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function liberarCaratulas() {
  urlsCaratulas.forEach((url) => URL.revokeObjectURL(url));
  urlsCaratulas = [];
}

function liberarCaratulaActual() {
  if (urlCaratulaActual) URL.revokeObjectURL(urlCaratulaActual);
  urlCaratulaActual = null;
}

function crearUrlCaratula(cancion) {
  if (!cancion?.caratula) return null;
  return URL.createObjectURL(cancion.caratula);
}

function urlCaratulaLista(cancion) {
  const url = crearUrlCaratula(cancion);
  if (url) urlsCaratulas.push(url);
  return url;
}

function crearElemento(etiqueta, clase, texto) {
  const elemento = document.createElement(etiqueta);
  if (clase) elemento.className = clase;
  if (texto !== undefined) elemento.textContent = texto;
  return elemento;
}

function dibujarBiblioteca() {
  liberarCaratulas();
  lista.replaceChildren();
  vistaVacia.hidden = canciones.length > 0;
  lista.hidden = canciones.length === 0;

  for (const cancion of canciones) {
    const item = crearElemento('li', `pista${cancion.id === idActual ? ' is-actual' : ''}`);

    const botonReproducir = crearElemento('button', 'pista__boton');
    botonReproducir.type = 'button';
    botonReproducir.setAttribute('aria-label', `Reproducir ${cancion.titulo}`);

    const url = urlCaratulaLista(cancion);
    if (url) {
      const imagen = crearElemento('img', 'pista__caratula');
      imagen.src = url;
      imagen.alt = '';
      botonReproducir.append(imagen);
    } else {
      const hueco = crearElemento('span', 'pista__caratula-vacia');
      hueco.append(crearIcono('musica'));
      botonReproducir.append(hueco);
    }

    const textos = crearElemento('span', 'pista__textos');
    textos.append(
      crearElemento('strong', '', cancion.titulo),
      crearElemento('small', '', cancion.artista)
    );
    botonReproducir.append(textos);
    botonReproducir.addEventListener('click', () => reproducir(cancion));

    const borrar = crearElemento('button', 'pista__borrar');
    borrar.type = 'button';
    borrar.setAttribute('aria-label', `Eliminar ${cancion.titulo}`);
    borrar.append(crearIcono('x'));
    borrar.addEventListener('click', () => eliminar(cancion));

    item.append(
      botonReproducir,
      crearElemento('span', 'pista__duracion', formatoTiempo(cancion.duracion || 0)),
      borrar
    );
    lista.append(item);
  }
}

function cancionActual() {
  return canciones.find((c) => c.id === idActual) || null;
}

function actualizarMiniProgreso() {
  const porcentaje = Number.isFinite(audio.duration) && audio.duration > 0
    ? (audio.currentTime / audio.duration) * 100
    : 0;
  miniProgreso.style.width = `${Math.min(100, Math.max(0, porcentaje))}%`;
}

function dibujarReproductor() {
  liberarCaratulaActual();
  const cancion = cancionActual();
  reproductor.hidden = !cancion;
  if (!cancion) return;

  $('#mini-titulo').textContent = cancion.titulo;
  $('#mini-artista').textContent = cancion.artista;
  $('#gran-titulo').textContent = cancion.titulo;
  $('#gran-artista').textContent = cancion.artista;
  $('#gran-album').textContent = cancion.album;

  const url = crearUrlCaratula(cancion);
  urlCaratulaActual = url;
  for (const selector of ['#mini-caratula', '#gran-caratula']) {
    const imagen = $(selector);
    const placeholder = $(`${selector}-vacia`);
    imagen.hidden = !url;
    placeholder.hidden = Boolean(url);
    if (url) imagen.src = url;
  }
  actualizarMiniProgreso();
}

function actualizarBotonPlay() {
  const nombreIcono = audio.paused ? 'play' : 'pausa';
  for (const selector of ['#boton-play', '#gran-play']) {
    const boton = $(selector);
    const clase = selector === '#boton-play' ? 'icono--sm' : '';
    boton.replaceChildren(crearIcono(nombreIcono, clase));
    boton.setAttribute('aria-label', audio.paused ? 'Reproducir' : 'Pausar');
  }
}

function mostrarAviso(texto) {
  aviso.textContent = texto;
  aviso.hidden = false;
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => { aviso.hidden = true; }, 4200);
}

async function mostrarEspacio() {
  if (!navigator.storage?.estimate) {
    estadoAlmacenamiento.textContent = 'Música guardada en este teléfono';
    return;
  }
  try {
    const { usage, quota } = await navigator.storage.estimate();
    estadoAlmacenamiento.textContent = `${(usage / 1048576).toFixed(0)} MB usados · ${(quota / 1073741824).toFixed(1)} GB disponibles`;
  } catch (_) {
    estadoAlmacenamiento.textContent = 'Música guardada en este teléfono';
  }
}

async function pedirPersistencia() {
  if (!navigator.storage?.persist) return;
  try {
    const yaPersistente = await navigator.storage.persisted();
    if (!yaPersistente) await navigator.storage.persist();
  } catch (_) {
    // WebKit decide solo; no es un error para el usuario.
  }
}

// ---------------------------------------------------------------------------
// Reproducción
// ---------------------------------------------------------------------------

function configurarSesionDeAudio() {
  try {
    if ('audioSession' in navigator && 'type' in navigator.audioSession) {
      navigator.audioSession.type = 'playback';
    }
  } catch (_) {
    // Safari antiguo: se ignora.
  }
}

function reproducir(cancion) {
  configurarSesionDeAudio();
  if (urlAudioActual) URL.revokeObjectURL(urlAudioActual);
  urlAudioActual = URL.createObjectURL(cancion.blob);
  audio.src = urlAudioActual;
  idActual = cancion.id;
  audio.currentTime = 0;
  actualizarMiniProgreso();
  dibujarBiblioteca();
  dibujarReproductor();
  actualizarBotonPlay();
  audio.play()
    .then(actualizarMediaSession)
    .catch((error) => mostrarAviso(`No se pudo reproducir: ${error.message}`));
}

function alternar() {
  if (!idActual) {
    if (canciones.length) reproducir(canciones[0]);
    return;
  }
  if (audio.paused) {
    configurarSesionDeAudio();
    audio.play().then(actualizarMediaSession).catch((error) => mostrarAviso(error.message));
  } else {
    audio.pause();
  }
}

function indiceActual() {
  return canciones.findIndex((c) => c.id === idActual);
}

// Elige una canción no escuchada recientemente antes de repetirlas
function elegirIndiceAleatorio(indiceDesde) {
  if (canciones.length < 2) return indiceDesde;
  let disponibles = canciones
    .map((_, indice) => indice)
    .filter((indice) => indice !== indiceDesde && !historialAleatorio.includes(indice));

  if (!disponibles.length) {
    historialAleatorio = [];
    disponibles = canciones
      .map((_, indice) => indice)
      .filter((indice) => indice !== indiceDesde);
  }

  const elegido = disponibles[Math.floor(Math.random() * disponibles.length)];
  historialAleatorio.push(indiceDesde);
  return elegido;
}

function cambiarPista(delta, desdeFinal = false) {
  if (!canciones.length) return;

  const indice = indiceActual();
  if (indice < 0) {
    reproducir(canciones[0]);
    return;
  }

  // "Repetir una" solo actúa al terminar naturalmente la canción
  if (desdeFinal && modoRepeticion === 'one') {
    reproducir(canciones[indice]);
    return;
  }

  let destino;
  if (delta > 0) {
    destino = aleatorio ? elegirIndiceAleatorio(indice) : indice + 1;
    if (destino >= canciones.length) {
      if (modoRepeticion === 'all') {
        destino = 0;
      } else {
        detener();
        return;
      }
    }
  } else {
    destino = aleatorio && historialAleatorio.length
      ? historialAleatorio.pop()
      : indice - 1;
    if (destino < 0) {
      if (modoRepeticion === 'all') {
        destino = canciones.length - 1;
      } else {
        audio.currentTime = 0;
        actualizarPosicion();
        return;
      }
    }
  }

  reproducir(canciones[destino]);
}

function anterior() {
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  cambiarPista(-1);
}

function detener() {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  if (urlAudioActual) URL.revokeObjectURL(urlAudioActual);
  urlAudioActual = null;
  idActual = null;
  historialAleatorio = [];
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
  actualizarMiniProgreso();
  dibujarBiblioteca();
  dibujarReproductor();
  actualizarBotonPlay();
}

async function eliminar(cancion) {
  if (cancion.id === idActual) detener();
  await operarDB('readwrite', (almacen) => almacen.delete(cancion.id));
  await cargarCanciones();
  mostrarAviso(`Eliminada: ${cancion.titulo}`);
}

// ---------------------------------------------------------------------------
// Pantalla de bloqueo / auriculares (Media Session API)
// ---------------------------------------------------------------------------

async function convertirCaratula(cancion) {
  if (!cancion?.caratula) return [];
  return new Promise((resolver) => {
    const lector = new FileReader();
    lector.onload = () => resolver([{
      src: lector.result,
      sizes: '512x512',
      type: cancion.caratula.type || 'image/jpeg'
    }]);
    lector.onerror = () => resolver([]);
    lector.readAsDataURL(cancion.caratula);
  });
}

async function actualizarMediaSession() {
  if (!('mediaSession' in navigator) || !('MediaMetadata' in window)) return;
  const cancion = cancionActual();
  if (!cancion) return;
  const artwork = await convertirCaratula(cancion);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: cancion.titulo,
    artist: cancion.artista,
    album: cancion.album,
    artwork
  });
  navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
  actualizarPosicion();
}

function actualizarPosicion() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      position: Math.min(audio.currentTime, audio.duration),
      playbackRate: audio.paused ? 0 : 1
    });
  } catch (_) {
    // Algunos motores rechazan valores intermedios; no es grave.
  }
}

function registrarAccionesRemotas() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setActionHandler) return;
  const acciones = {
    play: () => {
      configurarSesionDeAudio();
      audio.play().then(actualizarMediaSession).catch(() => {});
    },
    pause: () => audio.pause(),
    previoustrack: anterior,
    nexttrack: () => cambiarPista(1),
    seekto: (detalles) => {
      if (typeof detalles.position === 'number') audio.currentTime = detalles.position;
    },
    seekbackward: (detalles) => {
      audio.currentTime = Math.max(0, audio.currentTime - (detalles.seekOffset || 10));
    },
    seekforward: (detalles) => {
      audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (detalles.seekOffset || 10));
    }
  };
  for (const [nombre, manejador] of Object.entries(acciones)) {
    try {
      navigator.mediaSession.setActionHandler(nombre, manejador);
    } catch (_) {
      // Acción no soportada en este navegador.
    }
  }
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------

async function importar(archivos) {
  const listaArchivos = Array.from(archivos || []).filter(esAudio);
  if (!listaArchivos.length) {
    mostrarAviso('Ningún archivo de audio válido.');
    return;
  }

  const yaExistentes = new Set(canciones.map((c) => `${c.nombre}-${c.blob.size}`));
  let anadidos = 0;

  for (const archivo of listaArchivos) {
    const clave = `${archivo.name}-${archivo.size}`;
    if (yaExistentes.has(clave)) continue;
    yaExistentes.add(clave);
    const cancion = await prepararCancion(archivo);
    await operarDB('readwrite', (almacen) => almacen.put(cancion));
    anadidos++;
  }

  await cargarCanciones();
  mostrarAviso(anadidos
    ? `${anadidos} canción(es) guardadas en este teléfono. Funcionan sin internet.`
    : 'Esas canciones ya estaban en la biblioteca.');
}

$('#boton-importar').addEventListener('click', () => entradaArchivos.click());
$('#boton-importar-vacio').addEventListener('click', () => entradaArchivos.click());

entradaArchivos.addEventListener('change', async () => {
  await importar(entradaArchivos.files);
  entradaArchivos.value = '';
});

$('#boton-play').addEventListener('click', alternar);
$('#gran-play').addEventListener('click', alternar);
$('#boton-anterior').addEventListener('click', anterior);
$('#gran-anterior').addEventListener('click', anterior);
$('#boton-siguiente').addEventListener('click', () => cambiarPista(1));
$('#gran-siguiente').addEventListener('click', () => cambiarPista(1));

for (const selector of ['#mini-aleatorio', '#gran-aleatorio']) {
  $(selector).addEventListener('click', alternarAleatorio);
}
for (const selector of ['#mini-repeticion', '#gran-repeticion']) {
  $(selector).addEventListener('click', alternarRepeticion);
}

$('#abrir-pantalla').addEventListener('click', () => { pantalla.hidden = false; });
$('#cerrar-pantalla').addEventListener('click', () => { pantalla.hidden = true; });

progreso.addEventListener('input', () => {
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    audio.currentTime = (Number(progreso.value) / 100) * audio.duration;
  }
});

audio.addEventListener('timeupdate', () => {
  tiempoActual.textContent = formatoTiempo(audio.currentTime);
  tiempoTotal.textContent = formatoTiempo(audio.duration);
  progreso.value = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
  actualizarMiniProgreso();
  actualizarPosicion();
});

audio.addEventListener('loadedmetadata', () => {
  tiempoTotal.textContent = formatoTiempo(audio.duration);
  actualizarMiniProgreso();
  const cancion = cancionActual();
  if (cancion && Number.isFinite(audio.duration) && audio.duration > 0) {
    cancion.duracion = audio.duration;
    operarDB('readwrite', (almacen) => almacen.put(cancion)).catch(() => {});
  }
});

audio.addEventListener('play', () => {
  actualizarBotonPlay();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  actualizarPosicion();
});

audio.addEventListener('pause', () => {
  actualizarBotonPlay();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  actualizarPosicion();
});

audio.addEventListener('ended', () => cambiarPista(1, true));

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

async function iniciar() {
  baseDatos = abrirBaseDatos();
  cargarPreferencias();
  actualizarBotonesModos();
  actualizarBotonPlay();
  registrarAccionesRemotas();
  pedirPersistencia();

  try {
    await cargarCanciones();
  } catch (error) {
    mostrarAviso(`No se pudo abrir la biblioteca local: ${error.message}`);
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js', { scope: './' })
        .catch((error) => console.warn('Service worker no disponible:', error));
    });
  }
}

iniciar();
