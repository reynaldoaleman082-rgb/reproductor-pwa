/* Pruebas de regresión sin dependencias: node tests/regresion.js
   Extraen funciones del propio app.js para verificar el comportamiento real
   del código publicado, no una copia que pueda quedar desactualizada. */

const fs = require('fs');
const path = require('path');

const fuente = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
let fallos = 0;

function comprobar(nombre, ok) {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${nombre}`);
  if (!ok) fallos += 1;
}

function extraerCuerpo(expresion, nombre) {
  const coincidencia = expresion.exec(fuente);
  if (!coincidencia) throw new Error(`No encontré ${nombre} en app.js`);
  return coincidencia[1];
}

function extraerBloque(expresion, nombre) {
  const coincidencia = expresion.exec(fuente);
  if (!coincidencia) throw new Error(`No encontré ${nombre} en app.js`);
  return coincidencia[0];
}

function terminar() {
  console.log(`\n${fallos === 0 ? 'TODAS LAS PRUEBAS PASARON' : `${fallos} PRUEBA(S) FALLARON`}`);
  process.exit(fallos === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// 1. reproducirAudio(): permiso denegado y AbortError
// ---------------------------------------------------------------------------
function simularReproducirAudio(errorInicial, readyState = 0) {
  const bloque = extraerBloque(
    /function reproducirAudio\(\) \{[\s\S]*?\n\}/,
    'reproducirAudio'
  );
  const intentos = [];
  const audio = {
    readyState,
    play() {
      intentos.push('play');
      return intentos.length === 1 && errorInicial
        ? Promise.reject(errorInicial)
        : Promise.resolve();
    },
    addEventListener() {}
  };
  const reproducirAudio = new Function(
    'audio', 'esPermisoDenegado', 'registrarDiagnostico', bloque + '\nreturn reproducirAudio;'
  )(audio, (error) => error?.name === 'NotAllowedError', () => {});
  return reproducirAudio().then(
    () => ({ intentos: intentos.length }),
    (error) => ({ intentos: intentos.length, error: error.name })
  );
}

// ---------------------------------------------------------------------------
// 2. Handler de 'error': reanuda dos veces antes de descartar
// ---------------------------------------------------------------------------
function simularErrorAudio({
  fallosPrevios = 0, currentTime = 10, conCancion = true, modo = 'off'
} = {}) {
  const cuerpo = extraerCuerpo(
    /audio\.addEventListener\('error', \(\) => \{([\s\S]*?)\n\}\);/,
    "el handler de 'error'"
  );
  const registro = { reintentos: [], avisos: [], avances: 0, sesiones: 0, esperas: [] };
  const erroresAudioPorId = new Map([['c1', fallosPrevios]]);
  const cancionesConError = new Set();
  const manejador = new Function(
    'idCargando', 'idActual', 'audio', 'cancionesConError', 'historialAleatorio',
    'erroresAudioPorId', 'cancionActual', 'reproducir', 'configurarSesionDeAudio',
    'cancelarFinCancion', 'mostrarAviso', 'avanzarAlSiguiente', 'olvidarPosicion',
    'registrarDiagnostico', 'modoRepeticion', 'setTimeout',
    'const manejador = () => {' + cuerpo + '\n}; manejador();'
  );
  manejador(
    'c1', 'c1', { error: { code: 4 }, currentTime }, cancionesConError, ['x'],
    erroresAudioPorId,
    () => (conCancion ? { id: 'c1' } : null),
    (cancion, opciones) => registro.reintentos.push({ id: cancion?.id, ...opciones }),
    () => { registro.sesiones += 1; },
    () => {},
    (mensaje) => registro.avisos.push(mensaje),
    () => { registro.avances += 1; },
    () => {},
    () => {},
    modo,
    (accion, milisegundos) => {
      registro.esperas.push(milisegundos);
      accion(); // se ejecuta ya para poder comprobar qué canción se reintenta
    }
  );
  registro.contador = erroresAudioPorId.get('c1');
  registro.marcadas = [...cancionesConError];
  return registro;
}

// ---------------------------------------------------------------------------
// 3. visibilitychange: pausa del sistema vs. pausa del usuario
// ---------------------------------------------------------------------------
function simularVisibilidad({
  estado = 'visible', pausadoPorUsuario = false, paused = true,
  currentTime = 30, duration = 200, ended = false, idActual = 'c1',
  src = 'blob:audio', falloPlay = null, fundidoEnCurso = false
} = {}) {
  const cuerpo = extraerCuerpo(
    /document\.addEventListener\('visibilitychange', \(\) => \{([\s\S]*?)\n\}\);/,
    "'visibilitychange'"
  );
  const registro = {
    guardo: 0, sesiones: 0, play: 0, avances: 0, timers: 0,
    reconstruidas: 0, cancelaciones: 0, cancelacionesReanudacion: 0, avisos: []
  };
  const manejador = new Function(
    'document', 'audio', 'idActual', 'pausadoPorUsuario',
    'guardarPosicion', 'configurarSesionDeAudio', 'cancelarFinCancion',
    'avanzarAlSiguiente', 'reproducirAudio', 'actualizarMediaSession', 'programarFinCancion',
    'registrarDiagnostico', 'cancionActual', 'colaReproduccion', 'reproducir',
    'esPermisoDenegado', 'mostrarAviso', 'fundidoEnCurso', 'cancelarFundido',
    'cancelarReanudacionAutomatica',
    'const manejador = () => {' + cuerpo + '\n}; manejador();'
  );
  manejador(
    { visibilityState: estado },
    { paused, currentTime, duration, ended, src },
    idActual, pausadoPorUsuario,
    () => { registro.guardo += 1; },
    () => { registro.sesiones += 1; },
    () => {},
    () => { registro.avances += 1; },
    () => ({
      then(accion) {
        registro.play += 1;
        if (!falloPlay) accion();
        return { catch(rechazo) { if (falloPlay) rechazo(falloPlay); } };
      }
    }),
    () => {},
    () => { registro.timers += 1; },
    () => {},
    () => ({ id: 'c1' }),
    () => [{ id: 'c1' }],
    () => { registro.reconstruidas += 1; },
    (error) => error?.name === 'NotAllowedError',
    (mensaje) => registro.avisos.push(mensaje),
    fundidoEnCurso,
    () => { registro.cancelaciones += 1; },
    () => { registro.cancelacionesReanudacion += 1; }
  );
  return registro;
}

// ---------------------------------------------------------------------------
// 4. cambiarPista(): fin de lista y modos de repetición
// ---------------------------------------------------------------------------
function simularCambioDePista({
  modo = 'off', desdeFinal = false, delta = 1,
  indiceActual = 2, total = 3, aleatorio = false
} = {}) {
  const bloque = extraerBloque(
    /function cambiarPista\(delta, desdeFinal = false\) \{[\s\S]*?\n\}/,
    'cambiarPista'
  );
  const cola = Array.from({ length: total }, (_, indice) => ({ id: `c${indice}` }));
  const registro = { reproducido: null, detenido: false };
  const cambiarPista = new Function(
    'colaReproduccion', 'cancionesConError', 'idActual', 'modoRepeticion', 'aleatorio',
    'elegirIndiceAleatorio', 'historialAleatorio', 'cancionActual',
    'reproducir', 'detener', 'audio', 'actualizarPosicion', 'programarFinCancion',
    bloque + '\nreturn cambiarPista;'
  )(
    () => cola, new Set(), `c${indiceActual}`, modo, aleatorio,
    (indice) => (indice + 1) % cola.length, [], () => ({ id: `c${indiceActual}` }),
    (cancion) => { registro.reproducido = cancion?.id || null; },
    () => { registro.detenido = true; },
    { currentTime: 0 }, () => {}, () => {}
  );
  cambiarPista(delta, desdeFinal);
  return registro;
}

// ---------------------------------------------------------------------------
// 5. Fundido: serialize cambios y aplicar el pendiente si se cancela
// ---------------------------------------------------------------------------
async function simularFundido({ doble = false, cancelar = false, oculto = false } = {}) {
  const bloques = [
    extraerBloque(/function cambiarConFundido\(hacerCambio\) \{[\s\S]*?\n\}/, 'cambiarConFundido'),
    extraerBloque(/function ejecutarConFundido\(hacerCambio\) \{[\s\S]*?\n\}/, 'ejecutarConFundido'),
    extraerBloque(/function cancelarFundido\(\) \{[\s\S]*?\n\}/, 'cancelarFundido')
  ].join('\n');

  const temporizadores = new Map();
  let idTimer = 0;
  const temporizadorFalso = (accion) => {
    idTimer += 1;
    temporizadores.set(idTimer, accion);
    return idTimer;
  };
  const limpiarTemporizador = (id) => temporizadores.delete(id);
  const vaciarTemporizadores = async () => {
    let vacias = 0;
    for (let vuelta = 0; vuelta < 200 && vacias < 5; vuelta += 1) {
      const pendientes = [...temporizadores.values()];
      temporizadores.clear();
      vacias = pendientes.length ? 0 : vacias + 1;
      pendientes.forEach((accion) => accion());
      // La cola resuelve en varias microtareas y puede programar los timers de
      // la transición siguiente durante una vuelta sin pendientes.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
  };

  const audio = { volume: 1, paused: false, ended: false };
  const cuerpo = `
    let fundidoActivo = true;
    let duracionFundido = 4;
    let fundidoEnCurso = false;
    let volumenAntesDelFundido = 1;
    let temporizadoresFundido = [];
    let colaFundido = Promise.resolve();
    let cancelarBajadaFundido = null;
    let finalizarFundido = null;
    let fundidoCancelado = false;
    let idActual = 'A';
    ${bloques}
    return {
      cambiarConFundido,
      cancelarFundido,
      obtenerId: () => idActual,
      ponerId: (valor) => { idActual = valor; }
    };
  `;
  const documento = { visibilityState: oculto ? 'hidden' : 'visible' };
  const api = new Function('audio', 'document', 'setTimeout', 'clearTimeout', cuerpo)(
    audio, documento, temporizadorFalso, limpiarTemporizador
  );
  const cambiarA = (id) => () => {
    api.ponerId(id);
    return Promise.resolve();
  };

  const promesas = [api.cambiarConFundido(cambiarA('B'))];
  await Promise.resolve();
  await Promise.resolve();
  if (doble) promesas.push(api.cambiarConFundido(cambiarA('C')));
  await Promise.resolve();
  await Promise.resolve();
  if (cancelar) api.cancelarFundido();
  await vaciarTemporizadores();
  await Promise.all(promesas);
  return { id: api.obtenerId(), volumen: audio.volume, temporizadores: temporizadores.size };
}

function simularReanudacion({ fallos = 0, cambiaPista = false, pausaUsuario = false, yaSonando = false } = {}) {
  const bloques = [
    extraerBloque(/function cancelarReanudacionAutomatica\(\) \{[\s\S]*?\n\}/, 'cancelarReanudacionAutomatica'),
    extraerBloque(/function programarReanudacion\(\) \{[\s\S]*?\n\}/, 'programarReanudacion'),
    extraerBloque(/function intentarReanudar\(\) \{[\s\S]*?\n\}/, 'intentarReanudar')
  ].join('\n');

  const temporizadores = new Map();
  let idTimer = 0;
  const registro = { plays: 0, diagnosticos: [], retardos: [] };
  const audio = { paused: true };
  const cuerpo = `
    const RETARDOS_REANUDACION = [800, 2000, 5000, 12000, 30000];
    let temporizadorReanudacion = null;
    let intentosReanudacion = 0;
    let idInterrumpido = null;
    let idActual = 'c1';
    let pausadoPorUsuario = ${pausaUsuario ? 'true' : 'false'};
    ${bloques}
    return {
      programarReanudacion,
      cancelarReanudacionAutomatica,
      cambiarId: (valor) => { idActual = valor; },
      obtenerTimer: () => temporizadorReanudacion
    };
  `;
  const temporizadorFalso = (accion, retardo) => {
    idTimer += 1;
    temporizadores.set(idTimer, accion);
    registro.retardos.push(retardo);
    return idTimer;
  };
  const api = new Function(
    'audio', 'setTimeout', 'clearTimeout', 'configurarSesionDeAudio',
    'reproducirAudio', 'registrarDiagnostico', cuerpo
  )(
    audio,
    temporizadorFalso,
    (id) => temporizadores.delete(id),
    () => {},
    () => {
      registro.plays += 1;
      return registro.plays <= fallos
        ? Promise.reject({ name: 'NotAllowedError' })
        : Promise.resolve();
    },
    (origen, detalle) => registro.diagnosticos.push(`${origen}: ${detalle}`)
  );
  api.programarReanudacion();
  if (cambiaPista) api.cambiarId('c2');
  return {
    api,
    registro,
    async ejecutarSiguiente() {
      if (yaSonando) audio.paused = false;
      const pendientes = [...temporizadores.entries()];
      temporizadores.clear();
      pendientes.forEach(([, accion]) => accion());
      await Promise.resolve();
      await Promise.resolve();
    }
  };
}

// ---------------------------------------------------------------------------
// Ejecución
// ---------------------------------------------------------------------------
(async () => {
  const errorPermiso = await simularReproducirAudio({ name: 'NotAllowedError' });
  comprobar('NotAllowedError: un solo intento y se propaga',
    errorPermiso.intentos === 1 && errorPermiso.error === 'NotAllowedError');
  const abortado = await simularReproducirAudio({ name: 'AbortError' }, 2);
  comprobar('AbortError: no se reintenta fuera del gesto del usuario',
    abortado.intentos === 1 && abortado.error === 'AbortError');
  const normal = await simularReproducirAudio(null);
  comprobar('sin error: un solo intento', normal.intentos === 1);

  const e0 = simularErrorAudio({ fallosPrevios: 0 });
  comprobar('primer error: reanuda la canción tras 1,2 s, sin aviso ni salto',
    e0.reintentos.length === 1 && e0.reintentos[0].reanudar === true &&
    e0.esperas[0] === 1200 && e0.avisos.length === 0 && e0.avances === 0 &&
    e0.sesiones === 1);
  const e1 = simularErrorAudio({ fallosPrevios: 1 });
  comprobar('segundo error: sigue reanudando en silencio',
    e1.reintentos.length === 1 && e1.avisos.length === 0 && e1.avances === 0);
  const e2 = simularErrorAudio({ fallosPrevios: 2, currentTime: 10 });
  comprobar('tercer error: avanza avisando de interrupción',
    e2.reintentos.length === 0 && e2.avances === 1 &&
    e2.avisos[0] === 'Se interrumpió la reproducción; se pasa al siguiente.');
  const e3 = simularErrorAudio({ fallosPrevios: 2, currentTime: 0 });
  comprobar('tercer error al inicio: avisa archivo ilegible',
    e3.avisos[0] === 'No se pudo leer este archivo; se pasa al siguiente.');

  const vOculto = simularVisibilidad({ estado: 'hidden' });
  comprobar('pantalla apagada: guarda posición y reafirma sesión',
    vOculto.guardo === 1 && vOculto.sesiones === 1 && vOculto.play === 0 &&
    vOculto.cancelaciones === 0 && vOculto.cancelacionesReanudacion === 0);
  const vFundido = simularVisibilidad({ estado: 'hidden', fundidoEnCurso: true });
  comprobar('pantalla apagada a mitad de fundido: lo cancela',
    vFundido.cancelaciones === 1 && vFundido.guardo === 1);
  const vSistema = simularVisibilidad();
  comprobar('volver con pausa del sistema: reanuda sin duplicar reintentos',
    vSistema.play === 1 && vSistema.avances === 0 &&
    vSistema.cancelacionesReanudacion === 1);
  const vUsuario = simularVisibilidad({ pausadoPorUsuario: true });
  comprobar('volver con pausa del usuario: no reanuda', vUsuario.play === 0 && vUsuario.avances === 0);
  const vFin = simularVisibilidad({ currentTime: 199.8 });
  comprobar('volver al terminar: avanza', vFin.avances === 1 && vFin.play === 0);
  const vSonando = simularVisibilidad({ paused: false });
  comprobar('volver sonando: reprograma watchdog', vSonando.timers === 1 && vSonando.play === 0);
  const vSinCancion = simularVisibilidad({ idActual: null });
  comprobar('sin canción actual: no intenta reproducir',
    vSinCancion.play === 0 && vSinCancion.avances === 0);

  comprobar('fin de lista con repetición off: vuelve a la primera',
    simularCambioDePista({ modo: 'off' }).reproducido === 'c0');
  comprobar('fin de lista con repetición all: vuelve a la primera',
    simularCambioDePista({ modo: 'all' }).reproducido === 'c0');
  comprobar('fin de lista con repetición one: repite la actual',
    simularCambioDePista({ modo: 'one', desdeFinal: true }).reproducido === 'c2');
  comprobar('siguiente manual en la última: vuelve a la primera',
    simularCambioDePista({ desdeFinal: false }).reproducido === 'c0');
  comprobar('canción intermedia: avanza',
    simularCambioDePista({ indiceActual: 0 }).reproducido === 'c1');
  comprobar('lista de una canción: se mantiene',
    simularCambioDePista({ indiceActual: 0, total: 1 }).reproducido === 'c0');

  comprobar('«Reproducir todo» no existe en el código',
    !/reproducirTodo|reproducir-todo|Reproducir todo/.test(fuente));
  comprobar('los controles remotos esperan a que cargue la biblioteca',
    fuente.includes('if (!bibliotecaLista) return;'));

  // --- Regresiones añadidas tras la revisión de bugs ---
  comprobar('el contador de fallos no se limpia al resolver play()',
    !/function reproducirAhora\([^)]*\) \{[\s\S]*?\n\}/.exec(fuente)[0]
      .includes('erroresAudioPorId.delete('));
  comprobar('el watchdog respeta la pausa del usuario',
    /if \(idActual !== idProgramado \|\| pausadoPorUsuario\) return;/.test(fuente));
  comprobar('avanzar mantiene los flags hasta que termina el cambio',
    /return Promise\.resolve\(cambio\)\.finally/.test(fuente));
  comprobar('el fundido se encola y no se ejecuta dos veces',
    fuente.includes('const resultado = colaFundido.then(() => ejecutarConFundido(hacerCambio));'));
  comprobar('cancelar el fundido aplica el cambio pendiente',
    /fundidoCancelado = true;\s*cancelarBajadaFundido\(\);/.test(fuente));
  comprobar('en segundo plano se cambia de pista sin fundido',
    /if \(document\.visibilityState === 'hidden'\) \{\s*registrarDiagnostico\('audio', 'segundo plano: cambio sin fundido'\);\s*return reproducirAhora\(cancion, \{ reanudar \}\);/.test(fuente));
  comprobar('ocultar la pantalla a mitad de fundido lo cancela',
    /if \(fundidoEnCurso\) cancelarFundido\(\);/.test(fuente));
  comprobar('el pause del sistema programa la reanudación automática',
    /audio\.addEventListener\('pause', \(\) => \{[\s\S]*?programarReanudacion\(\);\n\}\);/.test(fuente));
  comprobar('playing cancela los reintentos cuando el sonido vuelve',
    /audio\.addEventListener\('playing', \(\) => \{[\s\S]*?cancelarReanudacionAutomatica\(\);/.test(fuente));
  comprobar('cambiar de pista y detener cancelan la reanudación pendiente',
    fuente.includes('function reproducirAhora(cancion, { reanudar = false } = {}) {\n  cancelarReanudacionAutomatica();') &&
    fuente.includes('function detener() {\n  cancelarReanudacionAutomatica();'));
  comprobar('la canción dañada se marca después de elegir el destino',
    /avanzarAlSiguiente\(\);\s*if \(modoRepeticion !== 'one'\) cancionesConError\.add\(idConError\);/.test(fuente));
  comprobar('el historial aleatorio guarda ids, no índices',
    fuente.includes('historialAleatorio.push(cola[indiceDesde].id);'));
  comprobar('la importación continúa aunque falle un archivo',
    fuente.includes('Promise.allSettled(lote.map(prepararCancion))'));
  comprobar('solo se reescribe el blob si cambia la duración',
    /if \(anterior !== audio\.duration\) \{\s*operarDB\('readwrite'/.test(fuente));
  comprobar('el service worker no devuelve HTML para imágenes o scripts',
    /evento\.request\.mode === 'navigate'/.test(
      fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8')));

  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  comprobar('aleatorio, repetir y fundido solo están en la pantalla completa',
    /gran-aleatorio/.test(html) && /gran-repeticion/.test(html) &&
    /gran-fundido/.test(html) && /duracion-fundido/.test(html) &&
    !/mini-aleatorio|mini-repeticion|mini-fundido/.test(html));
  comprobar('el JS no referencia los controles de modos del mini',
    !/mini-aleatorio|mini-repeticion|mini-fundido/.test(fuente));

  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  comprobar('ningún token de tema se autorreferencia',
    !/--([\w-]+):\s*var\(\s*\1\s*\)/.test(css));

  const cabecera = /<header class="cabecera">([\s\S]*?)<\/header>/.exec(html)?.[1] || '';
  comprobar('el buscador ocupa el espacio vacío de la cabecera',
    /id="buscador"/.test(cabecera) &&
    cabecera.indexOf('id="buscador"') < cabecera.indexOf('cabecera__acciones') &&
    /id="busqueda"/.test(cabecera) &&
    /class="sr-only">Buscar canción o artista</.test(cabecera));
  comprobar('la cabecera ya no muestra título, icono musical ni almacenamiento',
    !/cabecera__titulo|cabecera__icono|cabecera__estado|Mi música|Calculando espacio|estado-almacenamiento|<span>Importar<\/span>/.test(html) &&
    /id="boton-importar"[^>]*aria-label="Importar canciones"/.test(html) &&
    /<use href="#i-mas"><\/use>/.test(html));
  const herramientasHtml = /<section id="herramientas"[\s\S]*?<\/section>/.exec(html)?.[0] || '';
  comprobar('el orden queda en su propia barra, sin el buscador',
    !/id="busqueda"|id="limpiar-busqueda"/.test(herramientasHtml) &&
    /id="orden"/.test(herramientasHtml) &&
    /class="herramientas__etiqueta">Ordenar por</.test(herramientasHtml));
  comprobar('el buscador se oculta cuando no hay biblioteca',
    /buscador\.hidden = canciones\.length === 0;/.test(fuente));
  comprobar('el JS ya no muestra el almacenamiento utilizado',
    !/estadoAlmacenamiento|mostrarEspacio|MB usados|GB disponibles/.test(fuente));
  comprobar('el botón de importar sigue siendo un objetivo táctil de 44 px',
    /#boton-importar \{ width: 44px; padding: 0; \}/.test(css));
  comprobar('la paleta durazno con mostaza sustituye a la anterior',
    /--acento: #E9A23B;/.test(css) && /--acento-2: #F6C453;/.test(css) &&
    /--fondo: #241A16;/.test(css) && /--fondo: #FFF6EC;/.test(css) &&
    !/#4338ca|#22c55e|#6366f1|#0f0f23|#f8fafc|#15803d/i.test(css));
  comprobar('no quedan tokens con nombres de la paleta anterior',
    !/--verde-|--resplandor-indigo|--degradado-acento|--acento-sombras/.test(css));
  comprobar('el durazno se ve en superficies, botones y progreso',
    /--durazno: #F4A261;/.test(css) &&
    /--durazno-suave: #6B4030;/.test(css) &&
    /--durazno-suave: #FFE2CC;/.test(css) &&
    /background: linear-gradient\(135deg, var\(--durazno\), var\(--acento\)\);/.test(css) &&
    /background: linear-gradient\(90deg, var\(--durazno-linea\), var\(--acento\)\);/.test(css));
  comprobar('el atributo hidden gana sobre cualquier display',
    /\[hidden\] \{ display: none !important; \}/.test(css));

  const manifiesto = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'manifest.webmanifest'), 'utf8'));
  comprobar('el manifiesto usa la nueva paleta',
    manifiesto.theme_color === '#241A16' && manifiesto.background_color === '#FFF6EC');
  comprobar('la barra de estado sigue al tema del dispositivo',
    /content="#241A16"/.test(html) &&
    fuente.includes("oscuro ? '#241A16' : '#FFF6EC'"));

  const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  comprobar('el service worker cachea la versión 27',
    /const VERSION = 'reproductor-shell-v27';/.test(sw));

  const vSinSrc = simularVisibilidad({ src: '' });
  comprobar('volver con el src perdido reconstruye la canción',
    vSinSrc.reconstruidas === 1 && vSinSrc.play === 0 && vSinSrc.avances === 0);
  const vPermiso = simularVisibilidad({ falloPlay: { name: 'NotAllowedError' } });
  comprobar('un play rechazado al volver avisa en vez de fallar en silencio',
    vPermiso.avisos[0] === 'Toca el botón de reproducción para continuar.');

  const fundidoSimple = await simularFundido();
  comprobar('fundido: baja, cambia de pista y restaura el volumen',
    fundidoSimple.id === 'B' && fundidoSimple.volumen === 1);
  const fundidoDoble = await simularFundido({ doble: true });
  comprobar('doble toque: gana el último cambio, no retrocede',
    fundidoDoble.id === 'C' && fundidoDoble.volumen === 1);
  const fundidoCortado = await simularFundido({ cancelar: true });
  comprobar('apagar el fundido a media bajada aplica el cambio pendiente',
    fundidoCortado.id === 'B' && fundidoCortado.volumen === 1);
  const fundidoOculto = await simularFundido({ oculto: true });
  comprobar('en segundo plano cambia sin timers y con volumen intacto',
    fundidoOculto.id === 'B' && fundidoOculto.volumen === 1 &&
    fundidoOculto.temporizadores === 0);

  const reanudacion = simularReanudacion();
  await reanudacion.ejecutarSiguiente();
  comprobar('interrupción: vuelve a sonar solo tras la primera espera',
    reanudacion.registro.plays === 1 && reanudacion.registro.retardos[0] === 800);
  await reanudacion.ejecutarSiguiente();
  comprobar('sin sonido aún: reintenta con espera mayor',
    reanudacion.registro.plays === 2 && reanudacion.registro.retardos[1] === 2000);
  const reanudacionFallida = simularReanudacion({ fallos: 2 });
  await reanudacionFallida.ejecutarSiguiente();
  await reanudacionFallida.ejecutarSiguiente();
  await reanudacionFallida.ejecutarSiguiente();
  comprobar('play() rechazado por la interrupción: sigue intentando',
    reanudacionFallida.registro.plays === 3 &&
    reanudacionFallida.registro.diagnosticos.some((d) => d.includes('NotAllowedError')));
  const reanudacionCambiada = simularReanudacion({ cambiaPista: true });
  await reanudacionCambiada.ejecutarSiguiente();
  comprobar('si cambió de pista, no resucita la canción anterior',
    reanudacionCambiada.registro.plays === 0 &&
    reanudacionCambiada.api.obtenerTimer() === null);
  const reanudacionUsuario = simularReanudacion({ pausaUsuario: true });
  comprobar('pausa decidida por el usuario: no se reprograma nada',
    reanudacionUsuario.registro.retardos.length === 0 &&
    reanudacionUsuario.registro.plays === 0);
  const reanudacionSonando = simularReanudacion({ yaSonando: true });
  await reanudacionSonando.ejecutarSiguiente();
  comprobar('si ya volvió a sonar, no lanza un play() de más',
    reanudacionSonando.registro.plays === 0 &&
    reanudacionSonando.api.obtenerTimer() === null);

  terminar();
})();
