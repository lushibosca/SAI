// ═══════════════════════════════════════════════════════
//  CONFIGURACIÓN DE CLAVE DE APLICACIÓN (NAMESPACE)
// ═══════════════════════════════════════════════════════
const APP_KEY = 'RCK_';

(function () {
    try { if (localStorage.getItem(APP_KEY + 'dark') === '1') document.documentElement.classList.add('dark-mode'); } catch (e) { }
}());

// ═══════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function normalizarTexto(t) { if (!t) return ''; return t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, ' '); }
function getHoyLocal() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
const isMobile = () => window.matchMedia('(pointer: coarse)').matches;
function parseSeguro(s) {
    if (!s) return null;
    return JSON.parse(s, (key, val) => {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) { console.warn('Prototype pollution bloqueado'); return undefined; }
        return val;
    });
}

// ═══════════════════════════════════════════════════════
//  FIRMA SHA-256
// ═══════════════════════════════════════════════════════
async function generarFirma(obj) {
    if (!obj) return '0';
    const core = { r: (obj.racks || []).map(x => [x.id, x.numero, x.marca, x.modelo, x.estado]) };
    const str = JSON.stringify(core);
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function verificarFirma(raw) {
    if (!raw || typeof raw !== 'object' || !raw._firma) return false;
    const calc = await generarFirma(raw);
    return raw._firma === calc;
}

// ═══════════════════════════════════════════════════════
//  SANITIZACIÓN
// ═══════════════════════════════════════════════════════
// Estados válidos: inventario (disponible), servicio, baja
const ESTADOS_VALIDOS = new Set(['inventario', 'servicio', 'baja']);
const RE_ID = /^[a-z0-9]+$/i;

function _s(v, max = 200) { if (typeof v !== 'string') return ''; return v.trim().slice(0, max); }

function _sanitizarRack(r) {
    if (!r || typeof r !== 'object') return null;
    const id = _s(r.id, 32);
    const patrimonio = _s(r.patrimonio, 30);
    if (!id || !RE_ID.test(id) || !patrimonio) return null;
    const estado = ESTADOS_VALIDOS.has(r.estado) ? r.estado : 'inventario';
    return {
        id, estado,
        numero: _s(r.numero, 20),
        patrimonio,
        marca: _s(r.marca, 50),
        modelo: _s(r.modelo, 50),
        identificador: _s(r.identificador || r.serial || id.toUpperCase(), 80),
        unidades: Number.isInteger(r.unidades) && r.unidades > 0 ? r.unidades : null,
        notas: _s(r.notas, 200),
        edificio: _s(r.edificio, 80),
        piso: _s(r.piso, 30),
        dependencia: _s(r.dependencia, 100),
    };
}

function sanitizarEstado(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (!Array.isArray(raw.racks)) return null;
    return { racks: raw.racks.map(_sanitizarRack).filter(Boolean) };
}

// ═══════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════
let state = { racks: [] };
const CFG_DATA = APP_KEY + 'data'; // Ahora es dinámico

function guardar() {
    try { localStorage.setItem(CFG_DATA, JSON.stringify(state)); } catch (_) { }
    GistSync.subirAuto();
}

function cargar() {
    try {
        const raw = parseSeguro(localStorage.getItem(CFG_DATA) || 'null');
        if (raw) { const limpio = sanitizarEstado(raw); if (limpio) state = limpio; }
    } catch (_) { }
}

// ═══════════════════════════════════════════════════════
//  HISTORIAL UNDO/REDO
// ═══════════════════════════════════════════════════════
const historial = (() => {
    const MAX = 30;
    let _pasado = [], _futuro = [];
    function _clonar(s) { return parseSeguro(JSON.stringify(s)); }
    function _actualizarBotones() {
        const u = document.getElementById('btn-undo'), r = document.getElementById('btn-redo');
        if (u) u.disabled = !_pasado.length;
        if (r) r.disabled = !_futuro.length;
    }
    function empujar(label) {
        _pasado.push({ state: _clonar(state), label });
        if (_pasado.length > MAX) _pasado.shift();
        _futuro = [];
        _actualizarBotones();
    }
    function undo() {
        if (!_pasado.length) return;
        const e = _pasado.pop();
        _futuro.push({ state: _clonar(state), label: e.label });
        if (_futuro.length > MAX) _futuro.shift();
        state = e.state; guardar(); renderTodo(); _actualizarBotones();
        toast('Deshecho: ' + e.label, 'info');
    }
    function redo() {
        if (!_futuro.length) return;
        const e = _futuro.pop();
        _pasado.push({ state: _clonar(state), label: e.label });
        if (_pasado.length > MAX) _pasado.shift();
        state = e.state; guardar(); renderTodo(); _actualizarBotones();
        toast('Rehecho: ' + e.label, 'info');
    }
    return { empujar, undo, redo };
})();

// ═══════════════════════════════════════════════════════
//  MODAL MANAGER
// ═══════════════════════════════════════════════════════
const MM = (() => {
    let _mdDown = false;
    let _nav = false, _back = false, _ignorar = false;
    const HIST_KEY = '_' + APP_KEY + 'histBase';
    if (!sessionStorage.getItem(HIST_KEY)) sessionStorage.setItem(HIST_KEY, String(window.history.length));
    window.addEventListener('popstate', () => {
        if (_ignorar) { _ignorar = false; return; }
        const abiertos = [...document.querySelectorAll('.modal.show')];
        if (!abiertos.length) return;
        _back = true; cerrarTop(); setTimeout(() => { _back = false; }, 50);
    });
    function _onMD(e) { _mdDown = e.target === e.currentTarget; }
    function _onClick(e) { if (!_mdDown) return; if (e.target === e.currentTarget) cerrar(e.target.id); }
    function abrir(id, cb) {
        const m = document.getElementById(id); if (!m) return;
        m.classList.add('show'); document.body.classList.add('modal-open');
        if (!_back && !_nav) history.pushState({ rckModal: id }, '');
        setTimeout(() => { m.addEventListener('mousedown', _onMD); m.addEventListener('click', _onClick); }, 100);
        cb?.();
    }
    function cerrar(id, cb) {
        const m = document.getElementById(id); if (!m) return;
        m.classList.remove('show');
        if (!document.querySelector('.modal.show')) document.body.classList.remove('modal-open');
        m.removeEventListener('mousedown', _onMD); m.removeEventListener('click', _onClick);
        if (!_back && !_nav) { _ignorar = true; history.back(); }
        cb?.();
    }
    function cerrarTodos() {
        document.querySelectorAll('.modal.show').forEach(m => {
            m.classList.remove('show');
            m.removeEventListener('mousedown', _onMD); m.removeEventListener('click', _onClick);
        });
        document.body.classList.remove('modal-open');
    }
    function cerrarTop() {
        const abiertos = [...document.querySelectorAll('.modal.show')];
        if (!abiertos.length) return; cerrar(abiertos[abiertos.length - 1].id);
    }
    function nav(desde, fn) {
        _nav = true; cerrar(desde);
        setTimeout(() => { fn(); _nav = false; }, 150);
    }
    return { abrir, cerrar, cerrarTodos, cerrarTop, nav };
})();

// ═══════════════════════════════════════════════════════
//  TOAST
// ═══════════════════════════════════════════════════════
const _toastQ = []; let _toastBusy = false, _currentToast = null;
function toast(msg, tipo = 'success') {
    if (_currentToast && _currentToast.msg === msg && _currentToast.tipo === tipo) return;
    if (_toastQ.some(t => t.msg === msg && t.tipo === tipo)) return;
    _toastQ.push({ msg, tipo }); _flushToast();
}
function _flushToast() {
    if (_toastBusy || !_toastQ.length) return;
    _currentToast = _toastQ.shift(); _toastBusy = true;
    const el = document.getElementById('toast');
    el.textContent = _currentToast.msg;
    el.className = `toast show ${_currentToast.tipo}`;
    setTimeout(() => {
        el.classList.remove('show');
        setTimeout(() => { el.className = 'toast'; _toastBusy = false; _currentToast = null; _flushToast(); }, 300);
    }, 2500);
}

// ═══════════════════════════════════════════════════════
//  CONFIRMAR
// ═══════════════════════════════════════════════════════
let _confirmarCb = null, _confirmarPadreId = null;
function confirmar(titulo, texto, cb) {
    document.getElementById('confirmar-titulo').textContent = titulo;
    document.getElementById('confirmar-texto').textContent = texto;
    _confirmarCb = cb;
    const abiertos = [...document.querySelectorAll('.modal.show')];
    _confirmarPadreId = abiertos.length ? abiertos[abiertos.length - 1].id : null;
    MM.abrir('modal-confirmar');
}

// ═══════════════════════════════════════════════════════
//  DARK MODE
// ═══════════════════════════════════════════════════════
function toggleDarkMode() {
    const dark = document.documentElement.classList.toggle('dark-mode');
    const iconUse = document.getElementById('dark-icon-use');
    if (iconUse) iconUse.setAttribute('href', dark ? '#icon-sun' : '#icon-moon');
    try { localStorage.setItem(APP_KEY + 'dark', dark ? '1' : '0'); } catch (_) { } // Actualizado
}

// ═══════════════════════════════════════════════════════
//  FAB DROPDOWN
// ═══════════════════════════════════════════════════════
let _fabOpen = false;
function toggleFab() {
    _fabOpen = !_fabOpen;
    document.getElementById('fab-menu')?.classList.toggle('show', _fabOpen);
    document.getElementById('btn-fab-main')?.classList.toggle('active', _fabOpen);
}
function cerrarFab() {
    _fabOpen = false;
    document.getElementById('fab-menu')?.classList.remove('show');
    document.getElementById('btn-fab-main')?.classList.remove('active');
}

// ═══════════════════════════════════════════════════════
//  TABS
// ═══════════════════════════════════════════════════════
let _tabActual = 'dashboard';
const TAB_ICONS = { dashboard: '#icon-dashboard', servicio: '#icon-service', inventario: '#icon-inventory' };
const TAB_LABELS = { dashboard: 'Dashboard', servicio: 'Servicio', inventario: 'Inventario' };

function switchTab(tab) {
    cerrarFab();
    if (_tabActual === tab) {
        if (document.getElementById('busq-global').value) { limpiarBusqueda(); }
        return;
    }
    ['dashboard', 'servicio', 'inventario'].forEach(t =>
        document.getElementById(`tab-${t}`).classList.toggle('activa', t === tab)
    );
    try { localStorage.setItem(APP_KEY + 'tab', tab); } catch (_) { }
    const headerTabTitle = document.getElementById('header-tab-title');
    if (headerTabTitle) headerTabTitle.innerHTML = `<svg class="svg-icon"><use href="${TAB_ICONS[tab]}"/></svg> ${TAB_LABELS[tab]}`;

    const saliente = document.getElementById(`panel-${_tabActual}`);
    const entrante = document.getElementById(`panel-${tab}`);
    _tabActual = tab;
    saliente.classList.remove('activa'); saliente.classList.add('tab-saliendo');
    setTimeout(() => {
        saliente.classList.remove('tab-saliendo');
        entrante.classList.add('activa', 'tab-entrando');
        entrante.addEventListener('animationend', () => entrante.classList.remove('tab-entrando'), { once: true });
    }, 180);
    renderTodo();
}

// ═══════════════════════════════════════════════════════
//  BÚSQUEDA
// ═══════════════════════════════════════════════════════
let _busqTimer = null;
function onBusqGlobal() {
    const val = document.getElementById('busq-global').value;
    const clearBtn = document.getElementById('busq-clear-btn');
    if (clearBtn) clearBtn.classList.toggle('visible', !!val);
    if (_busqTimer) clearTimeout(_busqTimer);
    _busqTimer = setTimeout(renderTodo, 300);
}
function limpiarBusqueda() {
    if (_busqTimer) clearTimeout(_busqTimer);
    document.getElementById('busq-global').value = '';
    const clearBtn = document.getElementById('busq-clear-btn');
    if (clearBtn) clearBtn.classList.remove('visible');
    renderTodo();
}

// ═══════════════════════════════════════════════════════
//  UI (modales y navegación)
// ═══════════════════════════════════════════════════════
const UI = {
    abrirServicio() {
        cerrarFab();
        const disponibles = state.racks.filter(r => r.estado === 'inventario');
        if (!disponibles.length) { toast('No hay racks disponibles para poner en servicio', 'error'); return; }
        const sel = document.getElementById('servicio-rack-select');
        sel.innerHTML = '<option value="">— Seleccioná un rack disponible —</option>' +
            disponibles.map(r => {
                const partes = [r.patrimonio, r.unidades ? r.unidades + 'U' : null, r.marca].filter(Boolean);
                return `<option value="${esc(r.id)}">${esc(partes.join(' · '))}</option>`;
            }).join('');
        sel.value = '';
        sel.classList.remove('error');
        ['servicio-edificio', 'servicio-piso', 'servicio-dependencia', 'servicio-numero'].forEach(id => {
            const el = document.getElementById(id); if (el) { el.value = ''; el.classList.remove('error'); }
        });
        MM.abrir('modal-rack-servicio', () => { if (!isMobile()) setTimeout(() => sel.focus(), 200); });
    },
    abrirNuevoRack() {
        cerrarFab();
        ['numero', 'patrimonio', 'marca', 'modelo', 'notas'].forEach(f => {
            const el = document.getElementById(`rack-${f}-nuevo`);
            if (el) { el.value = ''; el.classList.remove('error'); }
        });
        MM.abrir('modal-rack-nuevo', () => {
            if (!isMobile()) setTimeout(() => document.getElementById('rack-patrimonio-nuevo')?.focus(), 200);
        });
    },
    cerrarNuevoRack() { MM.cerrar('modal-rack-nuevo'); },
    abrirGist() { MM.nav('modal-ajustes', () => { GistSync.poblarModal(); MM.abrir('modal-gist'); }); },
    cerrarGist() { MM.nav('modal-gist', () => MM.abrir('modal-ajustes')); },
    abrirAjustes() { MM.abrir('modal-ajustes'); },
    cerrarAjustes() { MM.cerrar('modal-ajustes'); },
    abrirImportar() {
        MM.nav('modal-ajustes', () => {
            document.getElementById('importar-file-input').value = '';
            document.getElementById('importar-dropzone-label').textContent = 'Seleccioná o arrastrá un archivo .json';
            document.getElementById('importar-dropzone').style.borderColor = '';
            document.getElementById('importar-confirmar-btn').disabled = true;
            document.getElementById('importar-combinar-btn').disabled = true;
            _importarParsed = null;
            MM.abrir('modal-importar', () => setTimeout(() => document.getElementById('importar-file-input').click(), 400));
        });
    },
    cerrarImportar() { MM.nav('modal-importar', () => MM.abrir('modal-ajustes')); },
};

// ═══════════════════════════════════════════════════════
//  RACK CRUD
// ═══════════════════════════════════════════════════════
function _leerFormRack(sufijo) {
    const g = (id) => document.getElementById(`rack-${id}-${sufijo}`)?.value.trim() || '';
    return {
        patrimonio: g('patrimonio'),
        marca: g('marca'),
        modelo: g('modelo'),
        unidades: parseInt(document.getElementById(`rack-unidades-${sufijo}`)?.value) || null,
        notas: g('notas'),
    };
}

function guardarNuevoRack() {
    const datos = _leerFormRack('nuevo');
    const patEl = document.getElementById('rack-patrimonio-nuevo');
    const uEl = document.getElementById('rack-unidades-nuevo');
    let ok = true;
    if (!datos.patrimonio) { patEl.classList.add('error'); ok = false; }
    if (!datos.unidades) { uEl.classList.add('error'); ok = false; }
    if (!ok) { toast('Patrimonio y Unidades son obligatorios', 'error'); return; }
    if (datos.patrimonio.toLowerCase() !== 'no' && state.racks.some(r => r.patrimonio.toLowerCase() === datos.patrimonio.toLowerCase())) {
        patEl.classList.add('error');
        toast(`Ya existe un rack con patrimonio "${datos.patrimonio}"`, 'error');
        return;
    }
    historial.empujar(`Agregar rack (patrimonio ${datos.patrimonio})`);

    // CREACIÓN DEL IDENTIFICADOR BASADO EN EL ID
    const nuevoId = uid();
    const identificadorAutogenerado = nuevoId.toUpperCase();

    state.racks.push({ id: nuevoId, identificador: identificadorAutogenerado, estado: 'inventario', numero: '', ...datos });
    guardar(); renderTodo(); MM.cerrar('modal-rack-nuevo');
    toast(`Rack agregado al inventario`);
}

let _editandoRackId = null;
function abrirModalEditarRack(id) {
    const rack = state.racks.find(r => r.id === id); if (!rack) return;
    _editandoRackId = id;
    const set = (f, v) => {
        const el = document.getElementById(`rack-${f}-editar`);
        if (el) { el.value = v ?? ''; el.classList.remove('error'); }
    };
    set('patrimonio', rack.patrimonio);
    set('marca', rack.marca);
    set('modelo', rack.modelo);
    set('identificador', rack.identificador);
    set('notas', rack.notas);
    const uEl = document.getElementById('rack-unidades-editar');
    if (uEl) { uEl.value = rack.unidades ?? ''; uEl.classList.remove('error'); }

    // Botón baja
    const bajaBtn = document.getElementById('rack-editar-baja-btn');
    const bajaLabel = document.getElementById('baja-btn-label');
    if (bajaBtn && bajaLabel) {
        const esBaja = rack.estado === 'baja';
        bajaLabel.textContent = esBaja ? 'Reactivar al inventario' : 'Dar de baja';
        bajaBtn.classList.toggle('btn-baja--reactivar', esBaja);
    }

    MM.abrir('modal-rack-editar');
}

let _editandoServicioId = null;

function abrirModalEditarServicio(id) {
    const rack = state.racks.find(r => r.id === id); if (!rack) return;
    _editandoServicioId = id;
    const set = (fid, v) => {
        const el = document.getElementById(fid);
        if (el) { el.value = v ?? ''; el.classList.remove('error'); }
    };
    set('editar-servicio-numero', rack.numero);
    set('editar-servicio-edificio', rack.edificio);
    set('editar-servicio-piso', rack.piso);
    set('editar-servicio-dependencia', rack.dependencia);
    const info = document.getElementById('editar-servicio-info');
    if (info) {
        const partes = [rack.patrimonio, rack.unidades ? rack.unidades + 'U' : null, rack.marca, rack.modelo].filter(Boolean);
        info.textContent = partes.join(' · ');
    }
    MM.abrir('modal-rack-editar-servicio');
}

function guardarEditarServicio() {
    if (!_editandoServicioId) return;
    const numEl = document.getElementById('editar-servicio-numero');
    const numero = numEl?.value.trim() || '';
    if (!numero) { numEl?.classList.add('error'); toast('El número de rack es obligatorio', 'error'); return; }
    if (state.racks.some(r => r.id !== _editandoServicioId && r.numero && r.numero.toLowerCase() === numero.toLowerCase())) {
        numEl?.classList.add('error');
        toast(`El número "${numero}" ya está asignado a otro rack`, 'error');
        return;
    }
    const rack = state.racks.find(r => r.id === _editandoServicioId); if (!rack) return;
    historial.empujar(`Editar rack en servicio (${rack.numero})`);
    rack.numero = numero;
    rack.edificio = document.getElementById('editar-servicio-edificio')?.value.trim() || '';
    rack.piso = document.getElementById('editar-servicio-piso')?.value.trim() || '';
    rack.dependencia = document.getElementById('editar-servicio-dependencia')?.value.trim() || '';
    guardar(); renderTodo(); MM.cerrar('modal-rack-editar-servicio');
    toast('Rack actualizado');
}

function quitarDeServicio() {
    if (!_editandoServicioId) return;
    const rack = state.racks.find(r => r.id === _editandoServicioId); if (!rack) return;
    confirmar(
        `¿Quitar el rack "${rack.numero}" del servicio?`,
        'Volverá al inventario como disponible.',
        () => {
            historial.empujar(`Quitar de servicio rack (${rack.numero})`);
            rack.estado = 'inventario';
            guardar(); renderTodo(); MM.cerrar('modal-rack-editar-servicio');
            toast('Rack devuelto al inventario', 'info');
        }
    );
}


function guardarEditarRack() {
    if (!_editandoRackId) return;
    const datos = _leerFormRack('editar');
    const patEl = document.getElementById('rack-patrimonio-editar');
    const uEl = document.getElementById('rack-unidades-editar');
    let ok = true;
    if (!datos.patrimonio) { patEl.classList.add('error'); ok = false; }
    if (!datos.unidades) { uEl.classList.add('error'); ok = false; }
    if (!ok) { toast('Patrimonio y Unidades son obligatorios', 'error'); return; }
    if (datos.patrimonio.toLowerCase() !== 'no' && state.racks.some(r => r.id !== _editandoRackId && r.patrimonio.toLowerCase() === datos.patrimonio.toLowerCase())) {
        patEl.classList.add('error');
        toast(`Ya existe un rack con patrimonio "${datos.patrimonio}"`, 'error');
        return;
    }
    const rack = state.racks.find(r => r.id === _editandoRackId);
    historial.empujar(`Editar rack (patrimonio ${datos.patrimonio})`);
    const idx = state.racks.findIndex(r => r.id === _editandoRackId);
    if (idx !== -1) state.racks[idx] = { ...state.racks[idx], ...datos };
    guardar(); renderTodo(); MM.cerrar('modal-rack-editar');
    toast(`Rack actualizado`);
}

function toggleBajaRack() {
    if (!_editandoRackId) return;
    const rack = state.racks.find(r => r.id === _editandoRackId); if (!rack) return;
    const esBaja = rack.estado === 'baja';
    if (esBaja) {
        // Reactivar
        historial.empujar(`Reactivar rack (patrimonio ${rack.patrimonio})`);
        rack.estado = 'inventario';
        guardar(); renderTodo(); MM.cerrar('modal-rack-editar');
        toast(`Rack reactivado`);
    } else {
        // Dar de baja
        confirmar(
            `¿Dar de baja el rack "${rack.numero}"?`,
            'El rack quedará marcado como baja. Podés reactivarlo después.',
            () => {
                historial.empujar(`Dar de baja rack (patrimonio ${rack.patrimonio})`);
                rack.estado = 'baja';
                guardar(); renderTodo(); MM.cerrar('modal-rack-editar');
                toast(`Rack dado de baja`, 'info');
            }
        );
    }
}

function eliminarRackActual() {
    if (!_editandoRackId) return;
    const rack = state.racks.find(r => r.id === _editandoRackId); if (!rack) return;
    confirmar(
        `¿Eliminar rack "${rack.numero}"?`,
        'Esta acción se puede deshacer antes de cerrar la página.',
        () => {
            historial.empujar(`Eliminar rack (patrimonio ${rack.patrimonio})`);
            state.racks = state.racks.filter(r => r.id !== _editandoRackId);
            guardar(); renderTodo(); MM.cerrar('modal-rack-editar');
            toast('Rack eliminado', 'info');
        }
    );
}

function confirmarPonerEnServicio() {
    const sel = document.getElementById('servicio-rack-select');
    const id = sel?.value;
    if (!id) { sel?.classList.add('error'); toast('Seleccioná un rack', 'error'); return; }
    const rack = state.racks.find(r => r.id === id); if (!rack) return;
    const numEl = document.getElementById('servicio-numero');
    const numero = numEl?.value.trim() || '';
    if (!numero) { numEl?.classList.add('error'); toast('El número de rack es obligatorio', 'error'); return; }
    if (state.racks.some(r => r.numero && r.numero.toLowerCase() === numero.toLowerCase())) {
        numEl?.classList.add('error');
        toast(`El número "${numero}" ya está asignado a otro rack`, 'error');
        return;
    }
    const edificio = document.getElementById('servicio-edificio')?.value.trim() || '';
    const piso = document.getElementById('servicio-piso')?.value.trim() || '';
    const dependencia = document.getElementById('servicio-dependencia')?.value.trim() || '';
    historial.empujar(`Poner en servicio rack (patrimonio ${rack.patrimonio})`);
    rack.estado = 'servicio';
    rack.numero = numero;
    rack.edificio = edificio;
    rack.piso = piso;
    rack.dependencia = dependencia;
    guardar(); renderTodo(); MM.cerrar('modal-rack-servicio');
    toast(`Rack ${numero} puesto en servicio`);
    actualizarFabServicio();
}

function actualizarFabServicio() {
    const btn = document.getElementById('fab-rack-servicio');
    if (!btn) return;
    const hayDisponibles = state.racks.some(r => r.estado === 'inventario');
    btn.disabled = !hayDisponibles;
    btn.title = hayDisponibles ? '' : 'No hay racks disponibles';
    btn.classList.toggle('fab-menu-item--disabled', !hayDisponibles);
}

// ═══════════════════════════════════════════════════════
const ESTADO_BADGE = {
    inventario: '<span class="rack-badge rack-badge-inventario">Disponible</span>',
    baja: '<span class="rack-badge rack-badge-baja">Baja</span>',
};
function _badgeEstado(r) {
    if (r.estado === 'servicio') {
        const label = r.numero ? esc(r.numero) : 'En servicio';
        return `<span class="rack-badge rack-badge-servicio">${label}</span>`;
    }
    return ESTADO_BADGE[r.estado] || '';
}

function _getRacksFiltrados() {
    const busq = normalizarTexto(document.getElementById('busq-global')?.value || '');
    let racks = [...state.racks];
    if (busq) {
        racks = racks.filter(r => {
            const h = normalizarTexto([r.numero, r.patrimonio, r.marca, r.modelo, r.identificador, r.notas].join(' '));
            return busq.split(' ').every(t => h.includes(t));
        });
    }
    racks.sort((a, b) => (a.patrimonio || '').localeCompare(b.patrimonio || '', 'es', { numeric: true }));
    return racks;
}


function _filaRackInv(r) {
    return `<tr class="tr-clickable rack-estado-${r.estado}" data-rack-id="${esc(r.id)}">
        <td class="td-muted">${esc(r.patrimonio || '—')}</td>
        <td>${esc(r.marca || '—')}</td>
        <td class="td-muted">${esc(r.modelo || '—')}</td>
        <td class="td-muted">${esc(r.identificador || '—')}</td>
        <td class="td-muted td-center">${r.unidades != null ? esc(String(r.unidades)) + 'U' : '—'}</td>
        <td>${_badgeEstado(r)}</td>
    </tr>`;
}

function _filaRackServicio(r) {
    return `<tr class="tr-clickable rack-estado-${r.estado}" data-rack-id="${esc(r.id)}">
        <td class="td-rack-num">${esc(r.numero)}</td>
        <td>${esc(r.edificio || '—')}</td>
        <td class="td-muted">${esc(r.piso || '—')}</td>
        <td class="td-muted">${esc(r.dependencia || '—')}</td>
    </tr>`;
}

// ═══════════════════════════════════════════════════════
//  RENDER DASHBOARD
// ═══════════════════════════════════════════════════════
function renderDashboard() {
    // Stats sidebar
    const all = state.racks;
    const total = all.length;
    const enServ = all.filter(r => r.estado === 'servicio').length;
    const enInv = all.filter(r => r.estado === 'inventario').length;
    const enBaja = all.filter(r => r.estado === 'baja').length;

    const distRows = total ? [
        { label: 'Disponible', n: enInv, cls: 'dist-inventario' },
        { label: 'En servicio', n: enServ, cls: 'dist-servicio' },
        { label: 'Baja', n: enBaja, cls: 'dist-baja' },
    ].filter(e => e.n > 0).map(e => {
        const pct = Math.round((e.n / total) * 100);
        return `<div class="rack-dist-bar">
            <span class="rack-dist-label ${e.cls}">${e.label}</span>
            <div class="rack-dist-bar-track"><div class="rack-dist-bar-fill ${e.cls}" data-pct="${pct}"></div></div>
            <span class="rack-dist-count">${e.n}</span>
        </div>`;
    }).join('') : '<p class="td-muted td-sm">Sin datos</p>';

    document.getElementById('stats-grid').innerHTML = `
        <div class="stat-chip">
            <span class="stat-chip-label">Racks</span>
            <span class="stat-chip-value">${total}</span>
            <span class="stat-chip-sub">registrados</span>
        </div>
        <div class="stat-chip">
            <span class="stat-chip-label">Disponibles</span>
            <span class="stat-chip-value dist-inventario">${enInv}</span>
            <span class="stat-chip-sub">en inventario</span>
        </div>
        <div class="stat-chip">
            <span class="stat-chip-label">En Servicio</span>
            <span class="stat-chip-value dist-servicio">${enServ}</span>
            <span class="stat-chip-sub">activos</span>
        </div>
        <div class="stat-chip dist-card">
            <span class="stat-chip-label">Distribución</span>
            ${distRows}
        </div>`;

    // Animar barras
    requestAnimationFrame(() => {
        document.querySelectorAll('.rack-dist-bar-fill').forEach(el => {
            el.style.width = (el.dataset.pct || 0) + '%';
        });
    });
}

// ═══════════════════════════════════════════════════════
//  RENDER SERVICIO
// ═══════════════════════════════════════════════════════
function renderServicio() {
    const busq = normalizarTexto(document.getElementById('busq-global')?.value || '');
    let racks = state.racks.filter(r => r.estado === 'servicio');
    if (busq) {
        racks = racks.filter(r => {
            const h = normalizarTexto([r.numero, r.patrimonio, r.marca, r.modelo, r.identificador, r.notas].join(' '));
            return busq.split(' ').every(t => h.includes(t));
        });
    }
    racks.sort((a, b) => a.numero.localeCompare(b.numero, 'es', { numeric: true }));

    const tbody = document.getElementById('tabla-servicio');
    const empty = document.getElementById('servicio-empty');
    const count = document.getElementById('servicio-count');
    if (count) count.textContent = state.racks.filter(r => r.estado === 'servicio').length;

    if (!racks.length) {
        tbody.innerHTML = ''; empty.classList.remove('empty-state-hidden');
    } else {
        empty.classList.add('empty-state-hidden');
        tbody.innerHTML = racks.map(_filaRackServicio).join('');
    }
}

// ═══════════════════════════════════════════════════════
//  RENDER INVENTARIO
// ═══════════════════════════════════════════════════════
function renderInventario() {
    const racks = _getRacksFiltrados();
    const tbody = document.getElementById('tabla-inventario');
    const empty = document.getElementById('inventario-empty');
    const count = document.getElementById('inventario-count');
    if (count) count.textContent = state.racks.length;

    if (!racks.length) {
        tbody.innerHTML = ''; empty.classList.remove('empty-state-hidden');
    } else {
        empty.classList.add('empty-state-hidden');
        tbody.innerHTML = racks.map(_filaRackInv).join('');
    }
}

// ═══════════════════════════════════════════════════════
//  RENDER GLOBAL
// ═══════════════════════════════════════════════════════
function renderTodo() {
    renderDashboard();
    renderServicio();
    renderInventario();
    actualizarFabServicio();
}

// ═══════════════════════════════════════════════════════
//  EXPORTAR / IMPORTAR
// ═══════════════════════════════════════════════════════
async function exportarDatos() {
    MM.cerrar('modal-ajustes');
    const firma = await generarFirma(state);
    const exp = { ...state, _firma: firma };
    const blob = new Blob([JSON.stringify(exp, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `racks_${getHoyLocal()}.json`; a.click();
    URL.revokeObjectURL(url);
    toast('Datos exportados');
}

let _importarParsed = null;
function onImportarFileChange(e) {
    const file = e.target.files[0]; if (!file) return;
    const label = document.getElementById('importar-dropzone-label');
    const zone = document.getElementById('importar-dropzone');
    const btn = document.getElementById('importar-confirmar-btn');
    const btnC = document.getElementById('importar-combinar-btn');
    if (file.size > 5 * 1024 * 1024) {
        _importarParsed = null;
        label.innerHTML = '<span class="import-fail">✗ Archivo demasiado grande (máx 5 MB)</span>';
        zone.style.borderColor = 'var(--c-red)'; btn.disabled = true; btnC.disabled = true; return;
    }
    const reader = new FileReader();
    reader.onload = async ev => {
        try {
            const raw = parseSeguro(ev.target.result);
            const esValida = await verificarFirma(raw);
            const parsed = sanitizarEstado(raw);
            if (!parsed) throw new Error('Esquema inválido');
            _importarParsed = { ...parsed, _firmaValida: esValida };
            label.innerHTML = `<span class="${esValida ? 'import-ok' : 'import-warn'}">${esValida ? '✓' : '⚠️'} ${esc(file.name)}</span><br><span class="import-sub">${parsed.racks.length} racks</span>`;
            zone.style.borderColor = esValida ? 'var(--c-green)' : 'var(--c-orange)';
            btn.disabled = false; btnC.disabled = false;
        } catch (_) {
            _importarParsed = null;
            label.innerHTML = '<span class="import-fail">✗ Archivo inválido o dañado</span>';
            zone.style.borderColor = 'var(--c-red)'; btn.disabled = true; btnC.disabled = true;
        }
    };
    reader.readAsText(file);
}

function importarDatos(modo) {
    if (!_importarParsed) { toast('Seleccioná un archivo válido', 'error'); return; }
    const parsed = _importarParsed;
    const alerta = parsed._firmaValida ? '' : '⚠️ El archivo fue modificado externamente.\n\n';
    if (modo === 'reemplazar') {
        confirmar('¿Reemplazar todos los datos?', alerta + 'Todos los racks actuales serán reemplazados.', () => {
            historial.empujar('Importar y reemplazar');
            state.racks = parsed.racks || [];
            guardar(); MM.cerrar('modal-importar'); _importarParsed = null;
            renderTodo(); toast(`Datos reemplazados (${state.racks.length} racks)`);
        });
    } else {
        confirmar('¿Combinar datos?', alerta + 'Se agregarán los racks que no existan (por número de rack).', () => {
            historial.empujar('Combinar datos importados');
            const nums = new Set(state.racks.map(r => r.numero.toLowerCase()));
            let n = 0;
            (parsed.racks || []).forEach(r => { if (!nums.has(r.numero.toLowerCase())) { state.racks.push(r); nums.add(r.numero.toLowerCase()); n++; } });
            guardar(); MM.cerrar('modal-importar'); _importarParsed = null;
            renderTodo(); toast(n > 0 ? `+${n} racks combinados` : 'Sin cambios', n > 0 ? 'success' : 'info');
        });
    }
}

function restablecerDatos() {
    MM.cerrar('modal-ajustes');
    setTimeout(() => {
        confirmar('¿Restablecer todos los datos?', 'Se eliminarán todos los racks. Podés deshacer antes de cerrar la página.', () => {
            historial.empujar('Restablecer todos los datos');
            state.racks = [];
            guardar(); renderTodo(); toast('Datos restablecidos');
        });
    }, 200);
}

// ═══════════════════════════════════════════════════════
//  GIST SYNC
// ═══════════════════════════════════════════════════════
const GistSync = (() => {
    const CFG_KEY = APP_KEY + 'gist_cfg', FILENAME = 'racks_data.json', DEBOUNCE_MS = 3000;
    const RE_GIST = /^[a-f0-9]{20,40}$/i;
    let _cfg = { token: '', gistId: '', lastSync: null, auto: false };
    let _debounceTimer = null, _subiendo = false;

    function _cargarCfg() { try { const c = parseSeguro(localStorage.getItem(CFG_KEY) || 'null'); if (c) _cfg = { ..._cfg, ...c }; } catch (_) { } _actualizarBotonesAjustes(); }
    function _guardarCfg() { try { localStorage.setItem(CFG_KEY, JSON.stringify(_cfg)); } catch (_) { } }
    function _spinStart() { document.getElementById('btn-ajustes')?.classList.add('icon-btn-spinning'); }
    function _spinStop() { document.getElementById('btn-ajustes')?.classList.remove('icon-btn-spinning'); }
    function _setBusy(busy) {
        _subiendo = busy;
        ['btn-gist-subir', 'btn-gist-bajar'].forEach(id => { const b = document.getElementById(id); if (b) b.disabled = busy; });
        busy ? _spinStart() : _spinStop();
    }
    function _setStatus(msg) { const el = document.getElementById('gist-sync-status'); if (el) el.textContent = msg; }
    function _setStatusSync() { const d = new Date(_cfg.lastSync); _setStatus(`Sincronizado: ${d.toLocaleDateString('es-AR')}, ${d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}`); }
    function _actualizarBotonesAjustes() {
        const token = !!(_cfg.token || '').trim(), gist = !!(_cfg.gistId || '').trim();
        const bu = document.getElementById('btn-ajustes-gist-subir'), bd = document.getElementById('btn-ajustes-gist-bajar');
        if (bu) bu.classList.toggle('gist-quick-hidden', !(token && gist));
        if (bd) bd.classList.toggle('gist-quick-hidden', !gist);
    }
    function _linkBtn() {
        const id = document.getElementById('gist-id')?.value.trim();
        const btn = document.getElementById('gist-link-btn'); if (!btn) return;
        if (id) { btn.href = `https://gist.github.com/${id}`; btn.classList.add('show'); } else { btn.classList.remove('show'); }
    }
    function toggleToken() {
        const inp = document.getElementById('gist-token'), icon = document.getElementById('gist-eye-icon');
        if (!inp) return;
        const show = inp.type === 'password'; inp.type = show ? 'text' : 'password';
        if (icon) icon.setAttribute('href', show ? '#icon-eye-off' : '#icon-eye');
    }
    function toggleAuto() { document.getElementById('gist-autosync-toggle')?.classList.toggle('on'); }
    function guardarConfig() {
        const t = document.getElementById('gist-token')?.value.trim() || '';
        const g = document.getElementById('gist-id')?.value.trim() || '';
        const a = document.getElementById('gist-autosync-toggle')?.classList.contains('on') ?? false;
        if (g && !RE_GIST.test(g)) { toast('El Gist ID tiene un formato inválido', 'error'); document.getElementById('gist-id')?.classList.add('error'); return; }
        if (_cfg.token === t && _cfg.gistId === g && !!_cfg.auto === a) { UI.cerrarGist(); toast('Sin cambios', 'info'); return; }
        _cfg.token = t; _cfg.gistId = g; _cfg.auto = a;
        _guardarCfg(); _actualizarBotonesAjustes();
        toast('Configuración guardada'); UI.cerrarGist();
    }
    async function _ejecutarSubida(silent = false) {
        const token = _cfg.token, gistId = _cfg.gistId;
        if (!token) { if (!silent) toast('Ingresá el token primero', 'error'); return; }
        if (gistId && !RE_GIST.test(gistId)) { if (!silent) toast('Gist ID inválido', 'error'); return; }
        _setBusy(true); if (!silent) _setStatus('Subiendo…');
        const firma = await generarFirma(state);
        const exp = { ...state, _firma: firma };
        const body = { files: { [FILENAME]: { content: JSON.stringify(exp, null, 2) } } };
        try {
            let res;
            if (gistId) {
                res = await fetch(`https://api.github.com/gists/${gistId}`, { method: 'PATCH', headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            } else {
                body.description = 'Racks — Control de Activos'; body.public = false;
                res = await fetch('https://api.github.com/gists', { method: 'POST', headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (!gistId && data.id) { _cfg.gistId = data.id; const el = document.getElementById('gist-id'); if (el) el.value = data.id; _linkBtn(); }
            _cfg.lastSync = new Date().toISOString(); _guardarCfg(); _setStatusSync();
            if (!silent) toast('Datos subidos a Gist');
        } catch (err) { _setStatus(`Error: ${err.message}`); if (!silent) toast(`Error al subir: ${err.message}`, 'error'); }
        finally { _setBusy(false); }
    }
    function subir() { _ejecutarSubida(false); }
    function subirAuto() { if (!_cfg.auto || !_cfg.token) return; clearTimeout(_debounceTimer); _debounceTimer = setTimeout(() => { if (!_subiendo) _ejecutarSubida(true); }, DEBOUNCE_MS); }
    async function bajar() {
        const token = document.getElementById('gist-token')?.value.trim() || _cfg.token;
        const gistId = document.getElementById('gist-id')?.value.trim() || _cfg.gistId;
        if (!gistId) { toast('Ingresá el Gist ID primero', 'error'); return; }
        if (!RE_GIST.test(gistId)) { toast('Gist ID inválido', 'error'); return; }
        _setBusy(true); _setStatus('Bajando…');
        try {
            const headers = {}; if (token) headers['Authorization'] = `token ${token}`;
            const res = await fetch(`https://api.github.com/gists/${gistId}`, { headers });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const file = data.files?.[FILENAME];
            if (!file) throw new Error(`No se encontró "${FILENAME}" en el Gist`);
            let contenido = file.content;
            if (file.truncated) {
                const rawOrigin = new URL(file.raw_url).hostname;
                if (!rawOrigin.endsWith('.githubusercontent.com')) throw new Error('raw_url inválida');
                const r2 = await fetch(file.raw_url); contenido = await r2.text();
            }
            const rawRemoto = parseSeguro(contenido);
            const esValida = await verificarFirma(rawRemoto);
            const remoto = sanitizarEstado(rawRemoto);
            if (!remoto) throw new Error('Formato inválido');
            const nums = new Set(state.racks.map(r => r.numero.toLowerCase()));
            const novedades = (remoto.racks || []).filter(r => !nums.has(r.numero.toLowerCase())).length;
            const procesarBajada = () => {
                _setBusy(true);
                if (novedades === 0) {
                    _cfg.token = token; _cfg.gistId = gistId; _cfg.lastSync = new Date().toISOString(); _guardarCfg(); _setStatusSync(); toast('Sin cambios', 'info'); _setBusy(false); return;
                }
                historial.empujar(esValida ? 'Bajar desde Gist' : 'Bajar desde Gist (Forzado)');
                (remoto.racks || []).forEach(r => { if (!nums.has(r.numero.toLowerCase())) { state.racks.push(r); nums.add(r.numero.toLowerCase()); } });
                guardar(); renderTodo();
                _cfg.token = token; _cfg.gistId = gistId; _cfg.lastSync = new Date().toISOString(); _guardarCfg(); _setStatusSync();
                toast(`Datos combinados (+${novedades} racks)`, esValida ? 'success' : 'info'); _setBusy(false);
            };
            if (!esValida) { _setBusy(false); confirmar('Datos alterados', 'Los datos fueron modificados externamente. ¿Combinar de todos modos?', procesarBajada); }
            else procesarBajada();
        } catch (err) { _setStatus(`Error: ${err.message}`); toast(`Error al bajar: ${err.message}`, 'error'); }
        finally { _setBusy(false); }
    }
    function poblarModal() {
        const te = document.getElementById('gist-token'), ie = document.getElementById('gist-id'), to = document.getElementById('gist-autosync-toggle');
        if (te) te.value = _cfg.token || ''; if (ie) ie.value = _cfg.gistId || '';
        if (to) to.classList.toggle('on', !!_cfg.auto);
        if (_cfg.lastSync) _setStatusSync(); else _setStatus('Sin sincronizar');
        _linkBtn();
    }
    function init() { _cargarCfg(); }
    return { init, subir, subirAuto, bajar, poblarModal, guardarConfig, toggleToken, toggleAuto, _linkBtn };
})();

// ═══════════════════════════════════════════════════════
//  KEYBOARD + SCROLL
// ═══════════════════════════════════════════════════════
document.addEventListener('keydown', e => {
    const modalOpen = document.body.classList.contains('modal-open');
    
    if (e.key === 'Escape') {
        if (modalOpen) { MM.cerrarTop(); return; }
        if (_fabOpen) { cerrarFab(); return; }
        
        // Nueva lógica para el buscador
        const b = document.getElementById('busq-global');
        if (b) {
            if (b.value) {
                limpiarBusqueda();
                return; // Limpia el texto y frena acá
            } else if (document.activeElement === b) {
                b.blur();
                return; // Si ya estaba vacío y tenía foco, se lo quita
            }
        }
    }

    if (e.ctrlKey && !e.altKey) {
        if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); historial.undo(); return; }
        if (e.key === 'y' || e.key === 'Y') { e.preventDefault(); historial.redo(); return; }
    }
    if (!modalOpen && !_fabOpen && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const tag = document.activeElement?.tagName;
        const enInput = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
        if (e.key === '+' || e.key === '=') { e.preventDefault(); UI.abrirNuevoRack(); return; }
        if (!enInput && (e.key === 'Backspace' || (e.key.length === 1 && /[a-zA-Z0-9]/.test(e.key)))) {
            const b = document.getElementById('busq-global');
            if (b) { b.focus(); if (e.key === 'Backspace') { e.preventDefault(); b.value = b.value.slice(0, -1); onBusqGlobal(); } }
        }
    }
});

window.addEventListener('scroll', () => {
    const btn = document.getElementById('btn-scroll-top');
    if (btn) btn.classList.toggle('show', window.scrollY > window.innerHeight);
    const h = document.getElementById('main-header');
    if (h) h.classList.toggle('scrolled', window.scrollY > 50);
}, { passive: true });

document.addEventListener('input', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') e.target.classList.remove('error');
});

// ═══════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════
cargar();

try { if (localStorage.getItem(APP_KEY + 'dark') === '1') { document.getElementById('dark-icon-use')?.setAttribute('href', '#icon-sun'); } } catch (_) { }

try {
    const t = localStorage.getItem(APP_KEY + 'tab');
    if (t && ['servicio', 'inventario'].includes(t)) {
        document.getElementById('panel-dashboard').classList.remove('activa');
        document.getElementById(`panel-${t}`).classList.add('activa');
        document.getElementById('tab-dashboard').classList.remove('activa');
        document.getElementById(`tab-${t}`).classList.add('activa');
        _tabActual = t;
        const htt = document.getElementById('header-tab-title');
        if (htt) htt.innerHTML = `<svg class="svg-icon"><use href="${TAB_ICONS[t]}"/></svg> ${TAB_LABELS[t]}`;
    }
} catch (_) { }

renderTodo();
GistSync.init();

// ═══════════════════════════════════════════════════════
//  BINDINGS
// ═══════════════════════════════════════════════════════
function _initBindings() {
    // Tabs
    document.getElementById('tab-dashboard')?.addEventListener('click', () => switchTab('dashboard'));
    document.getElementById('tab-servicio')?.addEventListener('click', () => switchTab('servicio'));
    document.getElementById('tab-inventario')?.addEventListener('click', () => switchTab('inventario'));

    // Header
    document.getElementById('btn-dark-mode')?.addEventListener('click', toggleDarkMode);
    document.getElementById('btn-ajustes')?.addEventListener('click', () => UI.abrirAjustes());
    document.getElementById('btn-undo')?.addEventListener('click', () => historial.undo());
    document.getElementById('btn-redo')?.addEventListener('click', () => historial.redo());

    // Búsqueda
    document.getElementById('busq-global')?.addEventListener('input', onBusqGlobal);
    document.getElementById('busq-clear-btn')?.addEventListener('click', limpiarBusqueda);

    // FAB dropdown
    document.getElementById('btn-fab-main')?.addEventListener('click', toggleFab);
    document.getElementById('fab-nuevo-rack')?.addEventListener('click', () => UI.abrirNuevoRack());
    document.getElementById('fab-rack-servicio')?.addEventListener('click', () => UI.abrirServicio());
    document.getElementById('servicio-confirmar-btn')?.addEventListener('click', confirmarPonerEnServicio);
    document.getElementById('servicio-cancelar-btn')?.addEventListener('click', () => MM.cerrar('modal-rack-servicio'));

    // Modal editar rack en servicio
    document.getElementById('editar-servicio-guardar-btn')?.addEventListener('click', guardarEditarServicio);
    document.getElementById('editar-servicio-quitar-btn')?.addEventListener('click', quitarDeServicio);
    document.getElementById('editar-servicio-cancelar-btn')?.addEventListener('click', () => MM.cerrar('modal-rack-editar-servicio'));
    // Cerrar FAB al hacer click fuera
    document.addEventListener('click', e => {
        if (_fabOpen && !e.target.closest('#fab-container')) cerrarFab();
    });

    // Scroll top
    document.getElementById('btn-scroll-top')?.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

    // Modal nuevo rack
    document.getElementById('rack-nuevo-guardar-btn')?.addEventListener('click', guardarNuevoRack);
    document.getElementById('rack-nuevo-cancelar-btn')?.addEventListener('click', () => UI.cerrarNuevoRack());

    // Modal editar rack
    document.getElementById('rack-editar-guardar-btn')?.addEventListener('click', guardarEditarRack);
    document.getElementById('rack-editar-eliminar-btn')?.addEventListener('click', eliminarRackActual);
    document.getElementById('rack-editar-cancelar-btn')?.addEventListener('click', () => MM.cerrar('modal-rack-editar'));
    document.getElementById('rack-editar-baja-btn')?.addEventListener('click', toggleBajaRack);

    // Clics en filas de tablas
    document.getElementById('tabla-servicio')?.addEventListener('click', e => {
        const tr = e.target.closest('tr[data-rack-id]');
        if (tr) abrirModalEditarServicio(tr.dataset.rackId);
    });
    document.getElementById('tabla-inventario')?.addEventListener('click', e => {
        const tr = e.target.closest('tr[data-rack-id]');
        if (tr) abrirModalEditarRack(tr.dataset.rackId);
    });

    // Ajustes
    document.getElementById('ajustes-cerrar-btn')?.addEventListener('click', () => UI.cerrarAjustes());
    document.getElementById('ajustes-exportar-btn')?.addEventListener('click', exportarDatos);
    document.getElementById('ajustes-importar-btn')?.addEventListener('click', () => UI.abrirImportar());
    document.getElementById('ajustes-restablecer-btn')?.addEventListener('click', restablecerDatos);
    document.getElementById('ajustes-gist-main-btn')?.addEventListener('click', () => UI.abrirGist());
    document.getElementById('btn-ajustes-gist-subir')?.addEventListener('click', () => GistSync.subir());
    document.getElementById('btn-ajustes-gist-bajar')?.addEventListener('click', () => GistSync.bajar());

    // Modal Gist
    document.getElementById('gist-cerrar-btn')?.addEventListener('click', () => UI.cerrarGist());
    document.getElementById('gist-token-eye')?.addEventListener('click', () => GistSync.toggleToken());
    document.getElementById('gist-autosync-toggle')?.addEventListener('click', () => GistSync.toggleAuto());
    document.getElementById('gist-id')?.addEventListener('input', () => GistSync._linkBtn());
    document.getElementById('gist-guardar-config-btn')?.addEventListener('click', () => GistSync.guardarConfig());
    document.getElementById('btn-gist-subir')?.addEventListener('click', () => GistSync.subir());
    document.getElementById('btn-gist-bajar')?.addEventListener('click', () => GistSync.bajar());

    // Modal importar
    document.getElementById('importar-cerrar-btn')?.addEventListener('click', () => UI.cerrarImportar());
    document.getElementById('importar-file-input')?.addEventListener('change', onImportarFileChange);
    document.getElementById('importar-dropzone')?.addEventListener('click', () => document.getElementById('importar-file-input').click());
    document.getElementById('importar-confirmar-btn')?.addEventListener('click', () => importarDatos('reemplazar'));
    document.getElementById('importar-combinar-btn')?.addEventListener('click', () => importarDatos('combinar'));
    const dz = document.getElementById('importar-dropzone');
    if (dz) {
        dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('import-dropzone-drag'); });
        dz.addEventListener('dragleave', () => dz.classList.remove('import-dropzone-drag'));
        dz.addEventListener('drop', e => {
            e.preventDefault(); dz.classList.remove('import-dropzone-drag');
            const file = e.dataTransfer.files[0];
            if (file) { const dt = new DataTransfer(); dt.items.add(file); document.getElementById('importar-file-input').files = dt.files; onImportarFileChange({ target: { files: [file] } }); }
        });
    }

    // Modal confirmar
    document.getElementById('confirmar-ok')?.addEventListener('click', () => {
        MM.cerrar('modal-confirmar');
        const cb = _confirmarCb; _confirmarCb = null;
        cb?.();
    });
    document.getElementById('confirmar-cancelar')?.addEventListener('click', () => { _confirmarCb = null; MM.cerrar('modal-confirmar'); });

}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initBindings);
} else {
    _initBindings();
}
