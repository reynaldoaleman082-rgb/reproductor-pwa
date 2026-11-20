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
const contenido = $('.contenido');
const portada = $('.portada');
const herramientas = $('#herramientas');
const busqueda = $('#busqueda');
const limpiarBusqueda = $('#limpiar-busqueda');
const orden = $('#orden');
const sinResultados = $('#sin-resultados');
const botonDuplicados = $('#boton-duplicados');
const reproducirTodo = $('#reproducir-todo');
const metaTema = $('#meta-tema');
const consultaTemaOscuro = window.matchMedia
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null;

// El CSS reacciona solo a prefers-color-scheme; la meta de la barra de estado no.
function actualizarColorTema() {
  if (!metaTema) return;
  const oscuro = consultaTemaOscuro ? consultaTemaOscuro.matches : true;
  metaTema.setAttribute('content', oscuro ? '#0f0f23' : '#f8fafc');
}

const DB_NAME = 'reproductor-offline';
const STORE = 'tracks';
const CLAVE_PREFERENCIAS = 'reproductor-preferencias';
const CLAVE_POSICIONES = 'reproductor-posiciones';
const CLAVE_CANCION_ACTUAL = 'reproductor-cancion-actual';
const MODOS_REPETICION = ['off', 'all', 'one'];
const ETIQUETAS_REPETICION = { off: 'desactivada', all: 'todas', one: 'una canción' };
const DURACIONES_FUNDIDO = [2, 4, 8];
const ORDENES = ['fecha', 'titulo', 'artista', 'duracion'];
const UMBRAL_ESPACIO = 0.9; // se deja libre al menos el 10 % del almacenamiento
const LOTE_IMPORTACION = 4;

const EXTENSIONES = ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'flac', 'aiff', 'aif', 'caf', 'opus'];

let baseDatos;
let canciones = [];
let cancionesVisibles = [];
let filasPista = new Map();
let idActual = null;
let idPistaResaltada = null;
let urlCaratulaActual = null;
let urlsCaratulas = new Map(); // id de canción -> URL de su carátula en la lista
// URL estable por canción: revocar la del audio anterior mientras iOS sigue
// leyéndolo provoca errores diferidos una vez ya avanzó currentTime.
const urlsAudioPorId = new Map(); // id de canción -> URL del audio (estable mientras viva la canción)
let caratulasMediaSession = new Map(); // id de canción -> carátula para la pantalla de bloqueo
let cancionesConError = new Set(); // ids que fallaron al leer: se excluyen de la rotación
let idCargando = null; // id del audio cuyo src se está cargando
let avanzando = false; // evita cadenas de avance por errores transitorios
let temporizadorAviso;
let temporizadorSalidaAviso;
let temporizadorFinCancion;
let saltandoAlSiguiente = false;

let textoBusqueda = '';
let ordenActual = 'fecha';
let posicionesGuardadas = {};
let posicionPendiente = null;
let ultimaGuardaPosicion = 0;
let ultimaPosicionInformada = 0;
let arrastrandoProgreso = false;
let saltoPendiente = null; // segundos a aplicar cuando la canción ya tenga duración

// Preferencias de reproducción (se conservan entre sesiones)
let modoRepeticion = 'off'; // off | all | one
let aleatorio = false;
let historialAleatorio = [];
let fundidoActivo = false;
let duracionFundido = 4; // segundos: se reparte a partes iguales entre salida y entrada
let temporizadoresFundido = [];
let fundidoEnCurso = false;
let volumenAntesDelFundido = 1;

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
    fundidoActivo = Boolean(datos.fundidoActivo);
    const duracionGuardada = Number(datos.duracionFundido);
    if (DURACIONES_FUNDIDO.includes(duracionGuardada)) duracionFundido = duracionGuardada;
    if (ORDENES.includes(datos.orden)) ordenActual = datos.orden;
  } catch (_) {
    // Preferencias corruptas: se usan los valores por defecto.
  }
}

function guardarPreferencias() {
  try {
    localStorage.setItem(CLAVE_PREFERENCIAS, JSON.stringify({
      modoRepeticion,
      aleatorio,
      fundidoActivo,
      duracionFundido,
      orden: ordenActual
    }));
  } catch (_) {
    // Almacenamiento no disponible: los botones siguen funcionando en esta sesión.
  }
}

function leerPosiciones() {
  try {
    return JSON.parse(localStorage.getItem(CLAVE_POSICIONES) || '{}');
  } catch (_) {
    return {};
  }
}

// Recuerda la pista en curso para que los controles sigan vivos si iOS mata la app
function guardarIdActual(id) {
  try {
    if (id) localStorage.setItem(CLAVE_CANCION_ACTUAL, id);
    else localStorage.removeItem(CLAVE_CANCION_ACTUAL);
  } catch (_) {
    // Sin localStorage, la sesión solo se mantiene mientras la app esté abierta.
  }
}

function leerIdActual() {
  try {
    return localStorage.getItem(CLAVE_CANCION_ACTUAL) || null;
  } catch (_) {
    return null;
  }
}

// Quita acentos para que "Musica" encuentre "Música"
function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function aplicarFiltroYOrden() {
  const termino = normalizar(textoBusqueda).trim();
  cancionesVisibles = canciones.filter((cancion) => {
    if (!termino) return true;
    return normalizar(`${cancion.titulo} ${cancion.artista} ${cancion.album} ${cancion.nombre}`)
      .includes(termino);
  });

  cancionesVisibles.sort((a, b) => {
    if (ordenActual === 'fecha') return b.fecha - a.fecha;
    if (ordenActual === 'duracion') return (a.duracion || 0) - (b.duracion || 0);
    const clave = ordenActual === 'artista' ? 'artista' : 'titulo';
    return normalizar(a[clave]).localeCompare(normalizar(b[clave]));
  });
}

function actualizarBotonesModos() {
  for (const boton of document.querySelectorAll('[data-modo]')) {
    const modo = boton.dataset.modo;
    let activo;
    if (modo === 'aleatorio') activo = aleatorio;
    else if (modo === 'fundido') activo = fundidoActivo;
    else activo = modoRepeticion !== 'off';

    boton.classList.toggle('is-activo', activo);
    boton.setAttribute('aria-pressed', String(activo));

    if (modo === 'aleatorio') {
      boton.setAttribute('aria-label', `Aleatorio: ${aleatorio ? 'activado' : 'desactivado'}`);
    } else if (modo === 'fundido') {
      boton.setAttribute('aria-label',
        `Fundido entre canciones: ${activo ? `activado, ${duracionFundido} segundos` : 'desactivado'}`);
    } else {
      boton.setAttribute('aria-label', `Repetición: ${ETIQUETAS_REPETICION[modoRepeticion]}`);
      boton.querySelector('use').setAttribute(
        'href',
        modoRepeticion === 'one' ? '#i-repetir-uno' : '#i-repetir'
      );
    }
  }
  const selectorDuracion = $('#duracion-fundido');
  if (selectorDuracion) selectorDuracion.value = String(duracionFundido);
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

function alternarFundido() {
  fundidoActivo = !fundidoActivo;
  if (!fundidoActivo) cancelarFundido();
  guardarPreferencias();
  actualizarBotonesModos();
  mostrarAviso(fundidoActivo
    ? `Fundido de ${duracionFundido} s activado`
    : 'Fundido desactivado');
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
  const vigentes = new Set(canciones.map((c) => c.id));
  for (const id of cancionesConError) {
    if (!vigentes.has(id)) cancionesConError.delete(id);
  }
  aplicarFiltroYOrden();
  sincronizarCaratulas();
  renderizarBiblioteca({ animar: true });
  dibujarReproductor();
  await mostrarEspacio();
  if (idActual && !canciones.some((c) => c.id === idActual)) {
    detener();
  }
}

// Las canciones importadas antes de esta corrección no guardaron la carátula:
// el frame APIC no cabía en los primeros 256 KB. Se recupera una sola vez.
async function repasarCaratulas() {
  const pendientes = canciones.filter((c) => !c.caratula && !c.caratulaBuscada);
  if (!pendientes.length) return;

  for (const cancion of pendientes) {
    let caratula = null;
    let lado = null;
    try {
      const meta = await leerMetadatos(cancion.blob);
      const reducida = await reducirCaratula(meta.caratula);
      caratula = reducida.blob;
      lado = reducida.lado;
    } catch (_) {
      // Archivo ilegible: se marca igual para no reintentarlo en cada arranque.
    }
    cancion.caratula = caratula;
    cancion.caratulaLado = lado;
    cancion.caratulaBuscada = true;
    try {
      await operarDB('readwrite', (almacen) => almacen.put(cancion));
    } catch (_) {
      // Si no se puede guardar, al menos se muestra durante esta sesión.
    }
    filasPista.get(cancion.id)?.remove();
    filasPista.delete(cancion.id);
  }

  await cargarCanciones();
  if (idActual) actualizarMediaSession();
  mostrarAviso('Carátulas actualizadas.');
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
  const resultado = {
    titulo: null,
    artista: null,
    album: null,
    caratula: null,
    caratulaRango: null
  };
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

    if (finDatos > fin) {
      // La carátula suele pesar casi 1 MB y no cabe en el trozo leído. Se
      // guarda su rango para leer después solo esos bytes directamente del archivo.
      if ((id === 'APIC' || id === 'PIC') && !resultado.caratula && !resultado.caratulaRango) {
        resultado.caratulaRango = { inicio: inicioDatos, fin: finDatos };
      }
      break;
    }

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

// Lee la cabecera y, si la carátula venía truncada, vuelve al archivo solo por
// el rango del frame APIC. Así se obtiene la misma imagen que muestra Archivos.
async function leerMetadatos(archivo) {
  const cabecera = await archivo.slice(0, 256 * 1024).arrayBuffer();
  const meta = leerID3(cabecera);
  if (meta.caratulaRango) {
    const bytes = await archivo.slice(
      meta.caratulaRango.inicio, meta.caratulaRango.fin
    ).arrayBuffer();
    meta.caratula = leerCaratula(new Uint8Array(bytes), 0, bytes.byteLength);
  }
  return meta;
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

// Las carátulas ID3 suelen ser enormes. Se guarda una versión cuadrada de hasta
// 300 px en JPEG; si el navegador no puede decodificarla, se conserva el original.
// Se devuelve también el lado real para declararlo bien en Media Session.
async function reducirCaratula(blob) {
  if (!blob || !globalThis.createImageBitmap) return { blob, lado: null };
  try {
    const bitmap = await createImageBitmap(blob);
    const lado = Math.min(bitmap.width, bitmap.height, 300);
    const origenX = (bitmap.width - lado) / 2;
    const origenY = (bitmap.height - lado) / 2;
    const lienzo = document.createElement('canvas');
    lienzo.width = lado;
    lienzo.height = lado;
    lienzo.getContext('2d').drawImage(
      bitmap, origenX, origenY, lado, lado, 0, 0, lado, lado
    );
    bitmap.close?.();
    const reducida = await new Promise((resolver) =>
      lienzo.toBlob(resolver, 'image/jpeg', 0.82)
    );
    return { blob: reducida || blob, lado: reducida ? lado : null };
  } catch (_) {
    return { blob, lado: null };
  }
}

async function prepararCancion(archivo) {
  const meta = await leerMetadatos(archivo);
  const caratula = await reducirCaratula(meta.caratula);
  return {
    id: idNuevo(),
    nombre: archivo.name,
    blob: archivo,
    mime: archivo.type || `audio/${archivo.name.split('.').pop().toLowerCase()}`,
    titulo: meta.titulo || nombreLimpio(archivo.name),
    artista: meta.artista || 'Artista desconocido',
    album: meta.album || 'Álbum desconocido',
    caratula: caratula.blob,
    caratulaLado: caratula.lado,
    caratulaBuscada: true,
    duracion: 0,
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

// Solo libera las carátulas de canciones que ya no están en la biblioteca:
// las filas que se reutilizan siguen mostrando las demás.
function sincronizarCaratulas() {
  const vigentes = new Set(canciones.filter((c) => c.caratula).map((c) => c.id));
  for (const [id, url] of urlsCaratulas) {
    if (vigentes.has(id)) continue;
    URL.revokeObjectURL(url);
    urlsCaratulas.delete(id);
  }
  // Las carátulas de Media Session son data URLs: también hay que soltarlas
  for (const id of caratulasMediaSession.keys()) {
    if (!vigentes.has(id)) caratulasMediaSession.delete(id);
  }
}

function liberarCaratulaActual() {
  if (urlCaratulaActual) URL.revokeObjectURL(urlCaratulaActual);
  urlCaratulaActual = null;
}

function crearUrlCaratula(cancion) {
  if (!cancion?.caratula) return null;
  return URL.createObjectURL(cancion.caratula);
}

// Cada carátula se crea una sola vez y se reutiliza en todos los renderizados
function urlCaratulaLista(cancion) {
  if (!cancion?.caratula) return null;
  let url = urlsCaratulas.get(cancion.id);
  if (!url) {
    url = URL.createObjectURL(cancion.caratula);
    urlsCaratulas.set(cancion.id, url);
  }
  return url;
}

function crearElemento(etiqueta, clase, texto) {
  const elemento = document.createElement(etiqueta);
  if (clase) elemento.className = clase;
  if (texto !== undefined) elemento.textContent = texto;
  return elemento;
}

function crearEcualizador() {
  const ecualizador = crearElemento('span', 'pista__ecualizador');
  ecualizador.append(crearElemento('i'), crearElemento('i'), crearElemento('i'));
  return ecualizador;
}

function crearFila(cancion, indice, animar) {
  const item = crearElemento('li', `pista${cancion.id === idActual ? ' is-actual' : ''}`);
  if (animar) {
    item.classList.add('pista--entrando');
    item.style.setProperty('--retraso', `${Math.min(indice, 12) * 35}ms`);
    item.addEventListener('animationend', (evento) => {
      if (evento.animationName === 'subir-fila') item.classList.remove('pista--entrando');
    });
  }

  const botonReproducir = crearElemento('button', 'pista__boton');
  botonReproducir.type = 'button';
  botonReproducir.setAttribute('aria-label', `Reproducir ${cancion.titulo}`);
  botonReproducir.addEventListener('click', () => {
    cancionesConError.delete(cancion.id); // un toque explícito reintenta la canción
    reproducir(cancion, { reanudar: true });
  });

  const arte = crearElemento('span', 'pista__arte');
  const url = urlCaratulaLista(cancion);
  if (url) {
    const imagen = crearElemento('img', 'pista__caratula');
    imagen.src = url;
    imagen.alt = '';
    arte.append(imagen);
  } else {
    const hueco = crearElemento('span', 'pista__caratula-vacia');
    hueco.append(crearIcono('musica'));
    arte.append(hueco);
  }
  if (cancion.id === idActual) arte.append(crearEcualizador());
  botonReproducir.append(arte);

  const textos = crearElemento('span', 'pista__textos');
  textos.append(
    crearElemento('strong', '', cancion.titulo),
    crearElemento('small', '', cancion.artista)
  );
  botonReproducir.append(textos);

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
  return item;
}

function actualizarFila(cancion, fila) {
  const duracion = fila.querySelector('.pista__duracion');
  const texto = formatoTiempo(cancion.duracion || 0);
  if (duracion.textContent !== texto) duracion.textContent = texto;
  const titulo = fila.querySelector('.pista__textos strong');
  if (titulo.textContent !== cancion.titulo) titulo.textContent = cancion.titulo;
  const artista = fila.querySelector('.pista__textos small');
  if (artista.textContent !== cancion.artista) artista.textContent = cancion.artista;
}

// Solo cambia el resaltado y el ecualizador: no se toca el resto de la lista
function actualizarPistaActual() {
  if (idPistaResaltada === idActual) return;
  const anterior = filasPista.get(idPistaResaltada);
  if (anterior) {
    anterior.classList.remove('is-actual');
    anterior.querySelector('.pista__ecualizador')?.remove();
  }
  const nueva = filasPista.get(idActual);
  if (nueva) {
    nueva.classList.add('is-actual');
    if (!nueva.querySelector('.pista__ecualizador')) {
      nueva.querySelector('.pista__arte')?.append(crearEcualizador());
    }
  }
  idPistaResaltada = idActual;
}

// Reconcilia las filas existentes en lugar de destruir y recrear la lista
function renderizarBiblioteca({ animar = false } = {}) {
  const visibles = new Set(cancionesVisibles.map((c) => c.id));

  for (const [id, fila] of filasPista) {
    if (!visibles.has(id)) {
      fila.remove();
      filasPista.delete(id);
    }
  }

  cancionesVisibles.forEach((cancion, indice) => {
    let fila = filasPista.get(cancion.id);
    if (!fila) {
      fila = crearFila(cancion, indice, animar);
      filasPista.set(cancion.id, fila);
    } else {
      actualizarFila(cancion, fila);
    }
    if (lista.children[indice] !== fila) {
      lista.insertBefore(fila, lista.children[indice] || null);
    }
  });

  idPistaResaltada = idActual;
  vistaVacia.hidden = canciones.length > 0;
  herramientas.hidden = canciones.length === 0;
  lista.hidden = cancionesVisibles.length === 0;
  sinResultados.hidden = !(
    textoBusqueda.trim() && canciones.length > 0 && cancionesVisibles.length === 0
  );
}

function cancionActual() {
  return canciones.find((c) => c.id === idActual) || null;
}

function actualizarMiniProgreso(segundos = audio.currentTime) {
  const porcentaje = Number.isFinite(audio.duration) && audio.duration > 0
    ? (segundos / audio.duration) * 100
    : 0;
  miniProgreso.style.width = `${Math.min(100, Math.max(0, porcentaje))}%`;
}

// Una sola fuente para la barra, los tiempos y el mini reproductor
function actualizarProgresoVisual(segundos) {
  const porcentaje = Number.isFinite(audio.duration) && audio.duration > 0
    ? Math.min(100, Math.max(0, (segundos / audio.duration) * 100))
    : 0;
  progreso.value = porcentaje;
  progreso.style.setProperty('--progreso', `${porcentaje}%`);
  tiempoActual.textContent = formatoTiempo(segundos);
  tiempoTotal.textContent = formatoTiempo(audio.duration);
  actualizarMiniProgreso(segundos);
}

// Salto a un segundo concreto. Si aún no se conoce la duración, se guarda
// el destino y se aplica en loadedmetadata (típico al adelantar justo al arrancar).
function saltarA(segundos, { actualizarBarra = true } = {}) {
  if (!idActual || !Number.isFinite(segundos)) return;
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
    saltoPendiente = Math.max(0, segundos);
    return;
  }
  const destino = Math.min(Math.max(0, segundos), Math.max(0, audio.duration - 0.25));
  audio.currentTime = destino;
  saltoPendiente = null;
  if (actualizarBarra) actualizarProgresoVisual(destino);
  else tiempoActual.textContent = formatoTiempo(destino);
  guardarPosicionEn(destino);
  actualizarPosicion({ forzar: true });
  programarFinCancion();
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
  actualizarProgresoVisual(audio.currentTime);
}

function actualizarBotonPlay() {
  const nombreIcono = audio.paused ? 'play' : 'pausa';
  document.body.classList.toggle('esta-sonando', !audio.paused);
  for (const selector of ['#boton-play', '#gran-play']) {
    const boton = $(selector);
    const clase = selector === '#boton-play' ? 'icono--sm' : '';
    boton.replaceChildren(crearIcono(nombreIcono, clase));
    boton.setAttribute('aria-label', audio.paused ? 'Reproducir' : 'Pausar');
  }
}

function ocultarAviso() {
  if (aviso.hidden || aviso.classList.contains('is-saliendo')) return;
  aviso.classList.add('is-saliendo');
  temporizadorSalidaAviso = setTimeout(() => {
    aviso.hidden = true;
    aviso.classList.remove('is-saliendo');
  }, 220);
}

function mostrarAviso(texto) {
  aviso.classList.remove('is-saliendo');
  aviso.textContent = texto;
  aviso.hidden = false;
  clearTimeout(temporizadorAviso);
  clearTimeout(temporizadorSalidaAviso);
  temporizadorAviso = setTimeout(ocultarAviso, 4200);
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

// Cada canción conserva su URL mientras siga en la biblioteca. No se revoca al
// cambiar de pista: iOS puede seguir leyendo el blob anterior y fallar después,
// ya con currentTime avanzado, lo que antes se confundía con archivo dañado.
function urlAudioDe(cancion) {
  if (!urlsAudioPorId.has(cancion.id)) {
    urlsAudioPorId.set(cancion.id, URL.createObjectURL(cancion.blob));
  }
  return urlsAudioPorId.get(cancion.id);
}

function liberarUrlAudio(id) {
  const url = urlsAudioPorId.get(id);
  if (url) URL.revokeObjectURL(url);
  urlsAudioPorId.delete(id);
}

// Al cambiar de pista, iOS a veces aborta el play() anterior. Se reintenta una vez.
function reproducirAudio() {
  return audio.play().catch((error) => {
    if (error.name !== 'AbortError') throw error;
    if (audio.readyState >= 2) return audio.play();
    return new Promise((resolver, rechazar) => {
      audio.addEventListener('canplay', () => audio.play().then(resolver, rechazar), { once: true });
    });
  });
}

// Un solo punto de avance: lo usan 'ended', 'error', el respaldo y el regreso
// a primer plano. Así no se puede avanzar dos veces por la misma canción.
function avanzarAlSiguiente() {
  if (!idActual || avanzando) return;
  avanzando = true;
  try {
    olvidarPosicion(idActual);
    posicionPendiente = null;
    saltoPendiente = null;
    saltandoAlSiguiente = true;
    cambiarPista(1, true);
    saltandoAlSiguiente = false;
  } finally {
    avanzando = false;
  }
}

// Respaldo por si el evento 'ended' no llega con la app en segundo plano.
// Al terminar, el navegador pone ended y paused a la vez: no se puede exigir
// que siga sonando. El id evita que un timer viejo avance la canción nueva.
function programarFinCancion() {
  clearTimeout(temporizadorFinCancion);
  if (!idActual || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
  const idProgramado = idActual;
  const restante = Math.max(0, audio.duration - audio.currentTime);
  temporizadorFinCancion = setTimeout(() => {
    if (idActual !== idProgramado) return;
    // iOS a veces pone paused sin ended al terminar. Basta con comprobar que
    // el tiempo llegó al final; si se pausó a mitad, este guarda impide avanzar.
    if (!audio.ended && audio.currentTime < audio.duration - 0.5) return;
    avanzarAlSiguiente();
  }, (restante + 1.5) * 1000);
}

function cancelarFinCancion() {
  clearTimeout(temporizadorFinCancion);
}

function cancelarFundido() {
  temporizadoresFundido.forEach(clearTimeout);
  temporizadoresFundido = [];
  if (fundidoEnCurso) audio.volume = volumenAntesDelFundido;
  fundidoEnCurso = false;
}

// Baja el volumen, cambia de pista y vuelve a subir. No se solapa audio:
// la salida termina antes de que empiece la entrada. Con transición apagada,
// o sin sonido que fundir (pista ya terminada), el cambio es inmediato.
function cambiarConFundido(hacerCambio) {
  if (!fundidoActivo || fundidoEnCurso) {
    return Promise.resolve(hacerCambio());
  }

  volumenAntesDelFundido = audio.volume > 0 ? audio.volume : 1;
  fundidoEnCurso = true;
  const pasos = 10;
  const intervalo = Math.max(16, (duracionFundido * 1000) / 2 / pasos);
  const conSalida = Boolean(idActual) && !audio.paused && !audio.ended;

  const subir = () => {
    let paso = 0;
    const avanzar = () => {
      paso += 1;
      audio.volume = Math.min(volumenAntesDelFundido, volumenAntesDelFundido * paso / pasos);
      if (paso < pasos) {
        temporizadoresFundido.push(setTimeout(avanzar, intervalo));
        return;
      }
      audio.volume = volumenAntesDelFundido;
      fundidoEnCurso = false;
      temporizadoresFundido = [];
    };
    temporizadoresFundido.push(setTimeout(avanzar, intervalo));
  };

  const cambiarYSubir = () => {
    let promesa;
    try {
      promesa = hacerCambio();
    } catch (error) {
      audio.volume = volumenAntesDelFundido;
      fundidoEnCurso = false;
      throw error;
    }
    // La subida empieza cuando el nuevo audio arranca, no antes.
    return Promise.resolve(promesa).then(subir, subir);
  };

  if (!conSalida) {
    audio.volume = 0;
    return cambiarYSubir();
  }

  let paso = 0;
  return new Promise((resolver) => {
    const bajar = () => {
      paso += 1;
      audio.volume = Math.max(0, volumenAntesDelFundido * (1 - paso / pasos));
      if (paso < pasos) {
        temporizadoresFundido.push(setTimeout(bajar, intervalo));
        return;
      }
      resolver(cambiarYSubir());
    };
    temporizadoresFundido.push(setTimeout(bajar, intervalo));
  });
}

function reproducir(cancion, { reanudar = false, conFundido = true } = {}) {
  if (!cancion) return Promise.resolve();
  if (!conFundido) return reproducirAhora(cancion, { reanudar });
  return cambiarConFundido(() => reproducirAhora(cancion, { reanudar }));
}

function reproducirAhora(cancion, { reanudar = false } = {}) {
  guardarPosicion({ forzar: true }); // recuerda dónde iba la canción anterior
  cancelarFinCancion();
  // Un salto pedido a la canción anterior no debe caer en esta
  saltoPendiente = null;
  posicionPendiente = null;
  configurarSesionDeAudio();
  idCargando = cancion.id;
  audio.src = urlAudioDe(cancion);
  // Safari/iOS necesita load() tras cambiar src para encadenar la siguiente pista.
  audio.load();
  idActual = cancion.id;
  guardarIdActual(idActual);
  const idReproducido = cancion.id;
  const guardada = reanudar ? Number(posicionesGuardadas[cancion.id]) || 0 : 0;
  posicionPendiente = guardada > 1 ? guardada : null;
  try {
    audio.currentTime = 0;
  } catch (_) {
    // Safari puede rechazarlo si el blob aún no tiene metadata; loadedmetadata lo ajusta.
  }
  actualizarMiniProgreso();
  actualizarPistaActual();
  dibujarReproductor();
  animarCambioDePortada();
  actualizarBotonPlay();
  // Metadata antes de play(): la pantalla de bloqueo no debe mostrar la canción anterior
  actualizarMediaSession();
  return reproducirAudio()
    .then(() => {
      cancionesConError.delete(idReproducido);
      actualizarMediaSession();
      programarFinCancion();
    })
    .catch((error) => {
      // El evento 'error' ya avisó si el archivo estaba dañado.
      if (!cancionesConError.has(idReproducido)) {
        mostrarAviso(`No se pudo reproducir: ${error.message}`);
      }
    });
}

// Lista que realmente se va a encadenar: respeta el filtro y descarta los
// archivos que dieron error, para no girar en círculos con una pista dañada.
function colaReproduccion() {
  if (!cancionesConError.size) return cancionesVisibles;
  return cancionesVisibles.filter((c) => !cancionesConError.has(c.id));
}

// iOS puede matar la PWA en segundo plano. Sin gesto del usuario no se puede
// dar play, pero sí reconstruir el src, la metadata y la posición para que el
// botón de play de la pantalla de bloqueo vuelva a funcionar al tocarlo.
function restaurarCancion() {
  const cancion = cancionActual();
  if (!cancion) {
    guardarIdActual(null);
    idActual = null;
    return;
  }
  configurarSesionDeAudio();
  idCargando = cancion.id;
  audio.src = urlAudioDe(cancion);
  audio.load();
  const guardada = Number(posicionesGuardadas[cancion.id]) || 0;
  posicionPendiente = guardada > 1 ? guardada : null;
  try {
    audio.currentTime = 0;
  } catch (_) {
    // Safari puede rechazarlo antes de tener metadata; loadedmetadata lo ajusta.
  }
  dibujarReproductor();
  actualizarPistaActual();
  actualizarBotonPlay();
  actualizarMediaSession();
}

function alternar() {
  if (!idActual) {
    cancionesConError.clear(); // el botón de play reintenta desde cero
    const cola = colaReproduccion();
    if (cola.length) reproducir(cola[0], { reanudar: true });
    return;
  }
  if (audio.paused) {
    configurarSesionDeAudio();
    reproducirAudio()
      .then(() => {
        cancionesConError.delete(idActual);
        actualizarMediaSession();
        programarFinCancion();
      })
      .catch((error) => mostrarAviso(error.message));
  } else {
    audio.pause();
  }
}

// Elige una canción no escuchada recientemente antes de repetirlas.
// Se usa la cola filtrada para que el aleatorio respete filtro y errores.
function elegirIndiceAleatorio(indiceDesde, cola) {
  if (cola.length < 2) return indiceDesde;
  let disponibles = cola
    .map((_, indice) => indice)
    .filter((indice) => indice !== indiceDesde && !historialAleatorio.includes(indice));

  if (!disponibles.length) {
    historialAleatorio = [];
    disponibles = cola
      .map((_, indice) => indice)
      .filter((indice) => indice !== indiceDesde);
  }

  const elegido = disponibles[Math.floor(Math.random() * disponibles.length)];
  historialAleatorio.push(indiceDesde);
  return elegido;
}

function cambiarPista(delta, desdeFinal = false) {
  const cola = colaReproduccion();

  // "Repetir una" vale para la canción real aunque el filtro la esté ocultando
  if (desdeFinal && modoRepeticion === 'one') {
    const actual = cancionActual();
    if (actual && !cancionesConError.has(actual.id)) reproducir(actual);
    else if (cola.length) reproducir(cola[0]);
    else detener();
    return;
  }

  if (!cola.length) {
    detener();
    return;
  }

  const indice = cola.findIndex((c) => c.id === idActual);
  if (indice < 0) {
    reproducir(cola[0]);
    return;
  }

  let destino;
  if (delta > 0) {
    destino = aleatorio ? elegirIndiceAleatorio(indice, cola) : indice + 1;
    if (destino >= cola.length) {
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
        destino = cola.length - 1;
      } else {
        audio.currentTime = 0;
        actualizarPosicion();
        programarFinCancion();
        return;
      }
    }
  }

  reproducir(cola[destino]);
}

function anterior() {
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    actualizarProgresoVisual(0);
    actualizarPosicion({ forzar: true });
    programarFinCancion();
    return;
  }
  cambiarPista(-1);
}

function detener() {
  cancelarFinCancion();
  cancelarFundido();
  idActual = null;
  guardarIdActual(null);
  posicionPendiente = null;
  saltoPendiente = null;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  historialAleatorio = [];
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
  actualizarMiniProgreso();
  actualizarPistaActual();
  dibujarReproductor();
  actualizarBotonPlay();
}

async function eliminar(cancion) {
  if (cancion.id === idActual) detener();
  liberarUrlAudio(cancion.id);
  cancionesConError.delete(cancion.id);
  olvidarPosicion(cancion.id);
  await operarDB('readwrite', (almacen) => almacen.delete(cancion.id));
  await cargarCanciones();
  mostrarAviso(`Eliminada: ${cancion.titulo}`);
}

// ---------------------------------------------------------------------------
// Pantalla de bloqueo / auriculares (Media Session API)
// ---------------------------------------------------------------------------

async function convertirCaratula(cancion) {
  if (!cancion?.caratula) return [];
  if (caratulasMediaSession.has(cancion.id)) return caratulasMediaSession.get(cancion.id);
  return new Promise((resolver) => {
    const lector = new FileReader();
    lector.onload = () => {
      const lado = Number(cancion.caratulaLado) || 300;
      const artwork = [{
        src: lector.result,
        sizes: `${lado}x${lado}`,
        type: cancion.caratula.type || 'image/jpeg'
      }];
      caratulasMediaSession.set(cancion.id, artwork);
      resolver(artwork);
    };
    lector.onerror = () => resolver([]);
    lector.readAsDataURL(cancion.caratula);
  });
}

function ponerMetadata(cancion, artwork) {
  if (!('mediaSession' in navigator) || !('MediaMetadata' in window) || !cancion) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: cancion.titulo,
    artist: cancion.artista,
    album: cancion.album,
    artwork: artwork || []
  });
}

// Síncrono: pone título y artista al instante. La carátula se añade después,
// pero se lee del caché en los cambios de canción posteriores.
function actualizarMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const cancion = cancionActual();
  if (!cancion) return;
  ponerMetadata(cancion, caratulasMediaSession.get(cancion.id));
  navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
  actualizarPosicion({ forzar: true });
  // Safari puede descartar los handlers si se registraron antes de haber metadata
  registrarAccionesRemotas();

  if (cancion.caratula && !caratulasMediaSession.has(cancion.id)) {
    convertirCaratula(cancion).then((artwork) => {
      if (idActual === cancion.id) ponerMetadata(cancionActual(), artwork);
    });
  }
}

function actualizarPosicion({ forzar = false } = {}) {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
  const ahora = Date.now();
  // timeupdate dispara varias veces por segundo: basta con informar una vez
  if (!forzar && ahora - ultimaPosicionInformada < 1000) return;
  ultimaPosicionInformada = ahora;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      position: Math.min(audio.currentTime, audio.duration),
      // La especificación exige un valor > 0: con 0 lanza TypeError y se pierde
      playbackRate: audio.playbackRate > 0 ? audio.playbackRate : 1
    });
  } catch (_) {
    // Algunos motores rechazan valores intermedios; no es grave.
  }
}

function persistirPosiciones() {
  try {
    localStorage.setItem(CLAVE_POSICIONES, JSON.stringify(posicionesGuardadas));
  } catch (_) {
    // Sin sitio en localStorage: la posición solo se recuerda en esta sesión.
  }
}

function guardarPosicionEn(segundos) {
  if (!idActual) return;
  ultimaGuardaPosicion = Date.now();
  posicionesGuardadas[idActual] = Math.max(0, segundos);
  persistirPosiciones();
}

// Se llama desde timeupdate (limitado a 5 s) y al pausar o salir de la app
function guardarPosicion({ forzar = false } = {}) {
  if (!idActual || audio.ended || saltandoAlSiguiente || audio.currentTime < 1) return;
  const ahora = Date.now();
  if (!forzar && ahora - ultimaGuardaPosicion < 5000) return;
  guardarPosicionEn(audio.currentTime);
}

function olvidarPosicion(id) {
  delete posicionesGuardadas[id];
  persistirPosiciones();
}

function registrarAccionesRemotas() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setActionHandler) return;
  const acciones = {
    play: () => {
      configurarSesionDeAudio();
      // Si iOS mató la app, el elemento de audio puede no tener src: hay que
      // reconstruirlo desde IndexedDB antes de intentar reproducir.
      if (!audio.src) {
        const cancion = cancionActual() || colaReproduccion()[0];
        if (cancion) reproducir(cancion, { reanudar: true });
        return;
      }
      if (!audio.paused) return;
      reproducirAudio()
        .then(() => {
          cancionesConError.delete(idActual);
          actualizarMediaSession();
          programarFinCancion();
        })
        .catch(() => {});
    },
    pause: () => audio.pause(),
    previoustrack: anterior,
    nexttrack: () => cambiarPista(1),
    seekto: (detalles) => {
      if (!idActual) return;
      // La API entrega el destino en seekTime, no en position
      if (Number.isFinite(detalles.seekTime)) saltarA(detalles.seekTime);
      else actualizarPosicion({ forzar: true });
    },
    seekbackward: (detalles) => {
      if (!idActual) return;
      saltarA(audio.currentTime - (Number(detalles.seekOffset) || 10));
    },
    seekforward: (detalles) => {
      if (!idActual) return;
      saltarA(audio.currentTime + (Number(detalles.seekOffset) || 10));
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
// Animaciones de la interfaz
// ---------------------------------------------------------------------------

function animarCambioDePortada() {
  portada.classList.remove('cambio');
  void portada.offsetWidth; // fuerza un repintado para reiniciar la animación
  portada.classList.add('cambio');
}

function abrirPantalla() {
  pantalla.classList.remove('is-saliendo');
  pantalla.hidden = false;
}

function cerrarPantalla() {
  if (pantalla.hidden || pantalla.classList.contains('is-saliendo')) return;
  pantalla.classList.add('is-saliendo');

  let terminado = false;
  const terminar = () => {
    if (terminado) return;
    terminado = true;
    pantalla.removeEventListener('animationend', alTerminar);
    pantalla.hidden = true;
    pantalla.classList.remove('is-saliendo');
  };
  function alTerminar(evento) {
    if (evento.animationName === 'overlay-salir') terminar();
  }
  pantalla.addEventListener('animationend', alTerminar);
  // Si el navegador no dispara animationend, la pantalla acaba cerrándose igual
  setTimeout(() => {
    if (pantalla.classList.contains('is-saliendo')) terminar();
  }, 360);
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------

function claveArchivo(nombre, tamaño) {
  return `${nombre}-${tamaño}`;
}

async function hayEspacioPara(archivos) {
  if (!navigator.storage?.estimate) return true;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    if (!quota) return true;
    const bytes = archivos.reduce((total, archivo) => total + archivo.size, 0);
    return usage + bytes <= quota * UMBRAL_ESPACIO;
  } catch (_) {
    return true;
  }
}

// Todas las canciones de un lote entran en una sola transacción
async function guardarCanciones(nuevas) {
  if (!nuevas.length) return;
  const db = await baseDatos;
  return new Promise((resolver, rechazar) => {
    const transaccion = db.transaction(STORE, 'readwrite');
    const almacen = transaccion.objectStore(STORE);
    nuevas.forEach((cancion) => almacen.put(cancion));
    transaccion.oncomplete = () => resolver();
    transaccion.onerror = () => rechazar(transaccion.error);
    transaccion.onabort = () => rechazar(transaccion.error || new Error('Transacción cancelada'));
  });
}

async function importar(archivos) {
  const listaArchivos = Array.from(archivos || []).filter(esAudio);
  if (!listaArchivos.length) {
    mostrarAviso('Ningún archivo de audio válido.');
    return;
  }

  if (!(await hayEspacioPara(listaArchivos))) {
    mostrarAviso('No queda espacio suficiente en el teléfono para esas canciones.');
    return;
  }

  const yaExistentes = new Set(
    canciones.map((c) => claveArchivo(c.nombre, c.blob.size))
  );
  let anadidos = 0;
  let errorGuardado = null;

  for (let i = 0; i < listaArchivos.length; i += LOTE_IMPORTACION) {
    const lote = listaArchivos.slice(i, i + LOTE_IMPORTACION).filter((archivo) => {
      const clave = claveArchivo(archivo.name, archivo.size);
      if (yaExistentes.has(clave)) return false;
      yaExistentes.add(clave);
      return true;
    });
    if (!lote.length) continue;

    try {
      const nuevas = await Promise.all(lote.map(prepararCancion));
      await guardarCanciones(nuevas);
      anadidos += nuevas.length;
    } catch (error) {
      errorGuardado = error;
      break;
    }
  }

  await cargarCanciones();
  if (errorGuardado) {
    const esCuota = ['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED']
      .includes(errorGuardado.name);
    mostrarAviso(esCuota
      ? 'No se pudieron guardar todas las canciones: el teléfono se ha quedado sin espacio.'
      : `No se pudieron guardar todas las canciones: ${errorGuardado.message}`);
    return;
  }
  mostrarAviso(anadidos
    ? `${anadidos} canción(es) guardadas en este teléfono. Funcionan sin internet.`
    : 'Esas canciones ya estaban en la biblioteca.');
}

// Conserva la copia más reciente de cada canción y borra las anteriores
async function eliminarDuplicados() {
  const grupos = new Map();
  for (const cancion of canciones) {
    const clave = claveArchivo(cancion.nombre, cancion.blob.size);
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(cancion);
  }

  const borradas = [];
  for (const grupo of grupos.values()) {
    if (grupo.length < 2) continue;
    grupo.sort((a, b) => b.fecha - a.fecha);
    borradas.push(...grupo.slice(1));
  }

  if (!borradas.length) {
    mostrarAviso('No hay canciones duplicadas.');
    return;
  }

  const db = await baseDatos;
  await new Promise((resolver, rechazar) => {
    const transaccion = db.transaction(STORE, 'readwrite');
    const almacen = transaccion.objectStore(STORE);
    borradas.forEach((cancion) => almacen.delete(cancion.id));
    transaccion.oncomplete = () => resolver();
    transaccion.onerror = () => rechazar(transaccion.error);
    transaccion.onabort = () => rechazar(transaccion.error);
  });

  borradas.forEach((cancion) => {
    liberarUrlAudio(cancion.id);
    olvidarPosicion(cancion.id);
    cancionesConError.delete(cancion.id);
  });
  if (borradas.some((cancion) => cancion.id === idActual)) detener();
  await cargarCanciones();
  mostrarAviso(`${borradas.length} canción(es) duplicada(s) eliminada(s).`);
}

$('#boton-importar').addEventListener('click', () => entradaArchivos.click());
$('#boton-importar-vacio').addEventListener('click', () => entradaArchivos.click());

entradaArchivos.addEventListener('change', async () => {
  try {
    await importar(entradaArchivos.files);
  } catch (error) {
    mostrarAviso(`No se pudieron importar los archivos: ${error.message}`);
  } finally {
    // Sin esto, volver a elegir el mismo archivo no dispara 'change'
    entradaArchivos.value = '';
  }
});

botonDuplicados.addEventListener('click', () => {
  eliminarDuplicados()
    .catch((error) => mostrarAviso(`No se pudieron borrar los duplicados: ${error.message}`));
});

// Un solo toque inicia la biblioteca y encadena las canciones automáticamente
reproducirTodo.addEventListener('click', () => {
  cancionesConError.clear(); // "Reproducir todo" reintenta también las marcadas
  const cola = colaReproduccion();
  if (!cola.length) {
    mostrarAviso(cancionesVisibles.length
      ? 'Ninguna canción de la lista se puede reproducir.'
      : 'Primero importa alguna canción.');
    return;
  }
  configurarSesionDeAudio();
  reproducir(cola[0], { reanudar: true });
});

busqueda.addEventListener('input', () => {
  textoBusqueda = busqueda.value;
  limpiarBusqueda.hidden = !textoBusqueda;
  aplicarFiltroYOrden();
  renderizarBiblioteca();
});

limpiarBusqueda.addEventListener('click', () => {
  busqueda.value = '';
  textoBusqueda = '';
  limpiarBusqueda.hidden = true;
  aplicarFiltroYOrden();
  renderizarBiblioteca();
  busqueda.focus();
});

orden.addEventListener('change', () => {
  ordenActual = ORDENES.includes(orden.value) ? orden.value : 'fecha';
  guardarPreferencias();
  aplicarFiltroYOrden();
  renderizarBiblioteca({ animar: true });
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
for (const selector of ['#mini-fundido', '#gran-fundido']) {
  $(selector).addEventListener('click', alternarFundido);
}
$('#duracion-fundido').addEventListener('change', (evento) => {
  const valor = Number(evento.target.value);
  duracionFundido = DURACIONES_FUNDIDO.includes(valor) ? valor : 4;
  guardarPreferencias();
  actualizarBotonesModos();
  mostrarAviso(`Fundido de ${duracionFundido} s`);
});

$('#abrir-pantalla').addEventListener('click', abrirPantalla);
$('#cerrar-pantalla').addEventListener('click', cerrarPantalla);

contenido.addEventListener('scroll', () => {
  $('.cabecera').classList.toggle('is-desplazada', contenido.scrollTop > 4);
}, { passive: true });

// Mientras se arrastra, timeupdate no debe devolver el pulgar a su sitio
for (const evento of ['pointerdown', 'touchstart', 'keydown']) {
  progreso.addEventListener(evento, () => { arrastrandoProgreso = true; }, { passive: true });
}
// 'change' llega al soltar; estos son una red de seguridad. Se usa timeout 0
// para no limpiar el estado antes de que 'change' aplique el salto.
for (const evento of ['pointerup', 'pointercancel', 'touchend']) {
  progreso.addEventListener(evento, () => {
    setTimeout(() => { arrastrandoProgreso = false; }, 0);
  }, { passive: true });
}
for (const evento of ['keyup', 'blur']) {
  progreso.addEventListener(evento, () => { arrastrandoProgreso = false; }, { passive: true });
}

// Al arrastrar solo se mueve el pulgar; el salto real se aplica al soltar
progreso.addEventListener('input', () => {
  arrastrandoProgreso = true;
  const segundos = (Number(progreso.value) / 100) * (audio.duration || 0);
  progreso.style.setProperty('--progreso', `${progreso.value}%`);
  tiempoActual.textContent = formatoTiempo(segundos);
  actualizarMiniProgreso(segundos);
});

progreso.addEventListener('change', () => {
  arrastrandoProgreso = false;
  const segundos = (Number(progreso.value) / 100) * (audio.duration || 0);
  saltarA(segundos, { actualizarBarra: false });
});

audio.addEventListener('timeupdate', () => {
  if (!arrastrandoProgreso) actualizarProgresoVisual(audio.currentTime);
  guardarPosicion();
  actualizarPosicion();
});

// Un seek puede tardar unos milisegundos: se refleja cuando el navegador lo aplica
audio.addEventListener('seeked', () => {
  if (!arrastrandoProgreso) actualizarProgresoVisual(audio.currentTime);
  guardarPosicion({ forzar: true });
  actualizarPosicion({ forzar: true });
  programarFinCancion();
});

audio.addEventListener('loadedmetadata', () => {
  if (posicionPendiente !== null) {
    const destino = Math.min(posicionPendiente, Math.max(0, (audio.duration || 0) - 1));
    if (destino > 0) audio.currentTime = destino;
    posicionPendiente = null;
  }
  if (saltoPendiente !== null) {
    const destino = Math.min(saltoPendiente, Math.max(0, (audio.duration || 0) - 0.25));
    if (destino > 0) audio.currentTime = destino;
    saltoPendiente = null;
  }
  if (!arrastrandoProgreso) actualizarProgresoVisual(audio.currentTime);
  actualizarPosicion({ forzar: true });

  const cancion = cancionActual();
  if (cancion && Number.isFinite(audio.duration) && audio.duration > 0) {
    const anterior = cancion.duracion;
    cancion.duracion = audio.duration;
    const fila = filasPista.get(cancion.id);
    if (fila) actualizarFila(cancion, fila);
    operarDB('readwrite', (almacen) => almacen.put(cancion)).catch(() => {});
    if (ordenActual === 'duracion' && anterior !== audio.duration) {
      aplicarFiltroYOrden();
      renderizarBiblioteca();
    }
  }
  programarFinCancion();
});

// Safari a veces conoce la duración tarde: se actualiza el deslizador de bloqueo
audio.addEventListener('durationchange', () => {
  tiempoTotal.textContent = formatoTiempo(audio.duration);
  if (!arrastrandoProgreso) actualizarProgresoVisual(audio.currentTime);
  actualizarPosicion({ forzar: true });
  programarFinCancion();
});

audio.addEventListener('play', () => {
  configurarSesionDeAudio();
  actualizarBotonPlay();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  actualizarPosicion({ forzar: true });
  programarFinCancion();
});

audio.addEventListener('pause', () => {
  // No se cancela el watchdog aquí: en iOS 'pause' llega al terminar la pista
  // y 'ended' puede perderse en segundo plano. El watchdog ya comprueba que
  // la canción esté al final antes de avanzar.
  actualizarBotonPlay();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  guardarPosicion({ forzar: true });
  actualizarPosicion({ forzar: true });
});

audio.addEventListener('ended', () => {
  cancelarFinCancion();
  avanzarAlSiguiente();
});

// Un archivo dañado no debe dejar la cola detenida: se salta al siguiente y se
// excluye de la rotación para que "repetir todas" no gire en círculos.
audio.addEventListener('error', () => {
  const idConError = idCargando || idActual;
  if (!idConError || idConError !== idActual) return; // error de una pista ya abandonada
  // iOS dispara MEDIA_ERR_ABORTED (1) al cambiar src o llamar a load().
  // No es un archivo dañado: marcarlo encadenaba avances infinitos.
  if (audio.error?.code === 1) return;
  cancelarFinCancion();
  // Si ya llevaba un rato sonando, el fallo es una interrupción (llamada, Siri,
  // cambio de app, blob que iOS dejó de leer), no un archivo dañado. Marcarlo
  // sacaría una pista válida de la rotación y encadenaría avisos engañosos.
  if (audio.currentTime > 2) {
    mostrarAviso('Se interrumpió la reproducción; se pasa al siguiente.');
    avanzarAlSiguiente();
    return;
  }
  cancionesConError.add(idConError);
  historialAleatorio = [];
  olvidarPosicion(idConError);
  mostrarAviso('No se pudo leer este archivo; se pasa al siguiente.');
  avanzarAlSiguiente();
});

// iOS puede suspender la app sin avisar: se guarda el punto de escucha al salir
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    guardarPosicion({ forzar: true });
  } else if (audio.ended || (audio.paused && Number.isFinite(audio.duration) &&
             audio.duration > 0 && audio.currentTime >= audio.duration - 0.5)) {
    // 'ended' se perdió en segundo plano, o iOS dejó paused sin ended al terminar
    cancelarFinCancion();
    avanzarAlSiguiente();
  } else if (!audio.paused) {
    programarFinCancion();
  }
});
window.addEventListener('pagehide', () => guardarPosicion({ forzar: true }));

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

async function iniciar() {
  baseDatos = abrirBaseDatos();
  actualizarColorTema();
  if (consultaTemaOscuro) {
    if (consultaTemaOscuro.addEventListener) {
      consultaTemaOscuro.addEventListener('change', actualizarColorTema);
    } else if (consultaTemaOscuro.addListener) {
      consultaTemaOscuro.addListener(actualizarColorTema);
    }
  }
  cargarPreferencias();
  posicionesGuardadas = leerPosiciones();
  idActual = leerIdActual();
  orden.value = ordenActual;
  actualizarBotonesModos();
  actualizarBotonPlay();
  registrarAccionesRemotas();
  pedirPersistencia();

  try {
    await cargarCanciones();
    if (idActual) restaurarCancion();
  } catch (error) {
    mostrarAviso(`No se pudo abrir la biblioteca local: ${error.message}`);
  }

  // En segundo plano: no bloquea el arranque y solo se hace una vez
  repasarCaratulas().catch(() => {});

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js', { scope: './' })
        .catch((error) => console.warn('Service worker no disponible:', error));
    });
  }
}

iniciar();
