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
  src = 'blob:audio', falloPlay = null
} = {}) {
  const cuerpo = extraerCuerpo(
    /document\.addEventListener\('visibilitychange', \(\) => \{([\s\S]*?)\n\}\);/,
    "'visibilitychange'"
  );
  const registro = {
    guardo: 0, sesiones: 0, play: 0, avances: 0, timers: 0,
    reconstruidas: 0, avisos: []
  };
  const manejador = new Function(
    'document', 'audio', 'idActual', 'pausadoPorUsuario',
    'guardarPosicion', 'configurarSesionDeAudio', 'cancelarFinCancion',
    'avanzarAlSiguiente', 'reproducirAudio', 'actualizarMediaSession', 'programarFinCancion',
    'registrarDiagnostico', 'cancionActual', 'colaReproduccion', 'reproducir',
    'esPermisoDenegado', 'mostrarAviso',
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
    (mensaje) => registro.avisos.push(mensaje)
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
async function simularFundido({ doble = false, cancelar = false } = {}) {
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
  const api = new Function('audio', 'setTimeout', 'clearTimeout', cuerpo)(
    audio, temporizadorFalso, limpiarTemporizador
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
  return { id: api.obtenerId(), volumen: audio.volume };
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
    vOculto.guardo === 1 && vOculto.sesiones === 1 && vOculto.play === 0);
  const vSistema = simularVisibilidad();
  comprobar('volver con pausa del sistema: reanuda', vSistema.play === 1 && vSistema.avances === 0);
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

  terminar();
})();
