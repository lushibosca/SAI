(function () {
    try { if (localStorage.getItem('RCK_dark') === '1') document.documentElement.classList.add('dark-mode'); } catch (e) { }
}());

// ═══════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function normalizarTexto(t) { if (!t) return ''; return t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, ' '); }
function getHoyLocal() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function formatFecha(iso) { if (!iso) return ''; if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return esc(iso); const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; }
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
    const core = { r: (obj.racks || []).map(x => [x.id, x.numero, x.marca, x.estado, x.edificio]) };
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
const ESTADOS_VALIDOS = new Set(['inventario', 'servicio', 'mantenimiento', 'baja']);
const RE_ID = /^[a-z0-9]+$/i;

function _s(v, max = 200) { if (typeof v !== 'string') return ''; return v.trim().slice(0, max); }
function _n(v) { const n = Number(v); return (Number.isFinite(n) && n >= 0) ? Math.floor(n) : 0; }

function _sanitizarRack(r) {
    if (!r || typeof r !== 'object') return null;
    const id = _s(r.id, 32), numero = _s(r.numero, 20);
    if (!id || !RE_ID.test(id) || !numero) return null;
    const estado = ESTADOS_VALIDOS.has(r.estado) ? r.estado : 'inventario';
    const unidades_raw = Number(r.unidades);
    const unidades = (Number.isFinite(unidades_raw) && unidades_raw > 0) ? Math.floor(unidades_raw) : null;
    return {
        id, numero, estado, unidades,
        patrimonio: _s(r.patrimonio, 30),
        marca: _s(r.marca, 50),
        edificio: _s(r.edificio, 50),
        piso: _s(r.piso, 20),
        lugar: _s(r.lugar, 80),
        p24: _n(r.p24), p48: _n(r.p48), fibra: _n(r.fibra),
        notas: _s(r.notas, 200),
        asig: r.asig ? {
            edificio: _s(r.asig.edificio, 50),
            piso: _s(r.asig.piso, 20),
            lugar: _s(r.asig.lugar, 80),
            fecha: (typeof r.asig.fecha === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.asig.fecha)) ? r.asig.fecha : '',
        } : null,
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
const CFG_DATA = 'RCK_data';

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
    if (!sessionStorage.getItem('_RCK_histBase')) sessionStorage.setItem('_RCK_histBase', String(window.history.length));
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
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('confirmar-ok').addEventListener('click', () => {
        MM.cerrar('modal-confirmar');
        const cb = _confirmarCb; _confirmarCb = null;
        if (_confirmarPadreId) { const id = _confirmarPadreId; _confirmarPadreId = null; setTimeout(() => { }, 50); }
        cb?.();
    });
    document.getElementById('confirmar-cancelar').addEventListener('click', () => { _confirmarCb = null; MM.cerrar('modal-confirmar'); });
});

// ═══════════════════════════════════════════════════════
//  DARK MODE
// ═══════════════════════════════════════════════════════
function toggleDarkMode() {
    const dark = document.documentElement.classList.toggle('dark-mode');
    const iconUse = document.getElementById('dark-icon-use');
    if (iconUse) iconUse.setAttribute('href', dark ? '#icon-sun' : '#icon-moon');
    try { localStorage.setItem('RCK_dark', dark ? '1' : '0'); } catch (_) { }
}

// ═══════════════════════════════════════════════════════
//  TABS
// ═══════════════════════════════════════════════════════
let _tabActual = 'dashboard';
const TAB_ICONS = { dashboard: '#icon-dashboard', servicio: '#icon-service', inventario: '#icon-inventory' };
const TAB_LABELS = { dashboard: 'Dashboard', servicio: 'Servicio', inventario: 'Inventario' };

function switchTab(tab) {
    if (_tabActual === tab) {
        if (document.getElementById('busq-global').value) { limpiarBusqueda(); }
        return;
    }
    ['dashboard', 'servicio', 'inventario'].forEach(t =>
        document.getElementById(`tab-${t}`).classList.toggle('activa', t === tab)
    );
    try { localStorage.setItem('RCK_tab', tab); } catch (_) { }
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
    document.getElementById('busq-clear-btn').style.display = val ? 'flex' : 'none';
    if (_busqTimer) clearTimeout(_busqTimer);
    _busqTimer = setTimeout(renderTodo, 300);
}
function limpiarBusqueda() {
    if (_busqTimer) clearTimeout(_busqTimer);
    document.getElementById('busq-global').value = '';
    document.getElementById('busq-clear-btn').style.display = 'none';
    renderTodo();
}

// ═══════════════════════════════════════════════════════
//  ESTADO SELECTOR
// ═══════════════════════════════════════════════════════
function selEstado(sufijo, estado) {
    const sel = document.getElementById(`estado-selector-${sufijo}`);
    if (!sel) return;
    sel.querySelectorAll('.estado-btn').forEach(btn => btn.classList.toggle('activo', btn.dataset.estado === estado));
    const wrap = document.getElementById(`asig-wrap-${sufijo}`);
    if (wrap) wrap.style.display = estado === 'servicio' ? '' : 'none';
}
function _getEstado(sufijo) {
    const activo = document.getElementById(`estado-selector-${sufijo}`)?.querySelector('.estado-btn.activo');
    return activo ? activo.dataset.estado : 'inventario';
}

// ═══════════════════════════════════════════════════════
//  UI (modales y navegación)
// ═══════════════════════════════════════════════════════
const UI = {
    abrirNuevoRack() {
        selEstado('nuevo', 'inventario');
        ['numero', 'patrimonio', 'marca', 'edificio', 'piso', 'lugar', 'notas'].forEach(f => {
            const el = document.getElementById(`rack-${f}-nuevo`);
            if (el) { el.value = ''; el.classList.remove('error'); }
        });
        ['unidades', 'p24', 'p48', 'fibra'].forEach(f => {
            const el = document.getElementById(`rack-${f}-nuevo`); if (el) el.value = '';
        });
        ['asig-edificio', 'asig-piso', 'asig-lugar'].forEach(f => {
            const el = document.getElementById(`rack-${f}-nuevo`); if (el) el.value = '';
        });
        const fe = document.getElementById('rack-asig-fecha-nuevo'); if (fe) fe.value = getHoyLocal();
        MM.abrir('modal-rack-nuevo', () => { if (!isMobile()) setTimeout(() => document.getElementById('rack-numero-nuevo')?.focus(), 200); });
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
    const gi = (id) => { const v = parseInt(document.getElementById(`rack-${id}-${sufijo}`)?.value || '0', 10); return isNaN(v) ? 0 : Math.max(0, v); };
    const numero = g('numero'), estado = _getEstado(sufijo);
    let asig = null;
    if (estado === 'servicio') {
        asig = {
            edificio: g('asig-edificio'), piso: g('asig-piso'),
            lugar: g('asig-lugar'), fecha: document.getElementById(`rack-asig-fecha-${sufijo}`)?.value || '',
        };
    }
    return {
        numero, patrimonio: g('patrimonio'), marca: g('marca'), edificio: g('edificio'), piso: g('piso'), lugar: g('lugar'), notas: g('notas'),
        unidades: gi('unidades') || null, p24: gi('p24'), p48: gi('p48'), fibra: gi('fibra'), estado, asig
    };
}

function guardarNuevoRack() {
    const datos = _leerFormRack('nuevo');
    if (!datos.numero) { document.getElementById('rack-numero-nuevo').classList.add('error'); toast('El número de rack es obligatorio', 'error'); return; }
    if (state.racks.some(r => r.numero.toLowerCase() === datos.numero.toLowerCase())) {
        document.getElementById('rack-numero-nuevo').classList.add('error'); toast(`El rack "${datos.numero}" ya existe`, 'error'); return;
    }
    historial.empujar(`Agregar rack ${datos.numero}`);
    state.racks.push({ id: uid(), ...datos });
    guardar(); renderTodo(); MM.cerrar('modal-rack-nuevo');
    toast(`Rack ${datos.numero} agregado`);
}

let _editandoRackId = null;
function abrirModalEditarRack(id) {
    const rack = state.racks.find(r => r.id === id); if (!rack) return;
    _editandoRackId = id;
    const set = (f, v) => { const el = document.getElementById(`rack-${f}-editar`); if (el) { el.value = v ?? ''; el.classList.remove('error'); } };
    set('numero', rack.numero); set('patrimonio', rack.patrimonio); set('marca', rack.marca);
    set('edificio', rack.edificio); set('piso', rack.piso); set('lugar', rack.lugar); set('notas', rack.notas);
    set('unidades', rack.unidades ?? ''); set('p24', rack.p24 || ''); set('p48', rack.p48 || ''); set('fibra', rack.fibra || '');
    selEstado('editar', rack.estado || 'inventario');
    if (rack.asig) {
        const sa = (f, v) => { const el = document.getElementById(`rack-asig-${f}-editar`); if (el) el.value = v || ''; };
        sa('edificio', rack.asig.edificio); sa('piso', rack.asig.piso); sa('lugar', rack.asig.lugar);
        const fe = document.getElementById('rack-asig-fecha-editar'); if (fe) fe.value = rack.asig.fecha || '';
    } else {
        ['edificio', 'piso', 'lugar'].forEach(f => { const el = document.getElementById(`rack-asig-${f}-editar`); if (el) el.value = ''; });
        const fe = document.getElementById('rack-asig-fecha-editar'); if (fe) fe.value = getHoyLocal();
    }
    MM.abrir('modal-rack-editar');
}

function guardarEditarRack() {
    if (!_editandoRackId) return;
    const datos = _leerFormRack('editar');
    if (!datos.numero) { document.getElementById('rack-numero-editar').classList.add('error'); toast('El número de rack es obligatorio', 'error'); return; }
    if (state.racks.some(r => r.id !== _editandoRackId && r.numero.toLowerCase() === datos.numero.toLowerCase())) {
        document.getElementById('rack-numero-editar').classList.add('error'); toast(`El rack "${datos.numero}" ya existe`, 'error'); return;
    }
    historial.empujar(`Editar rack ${datos.numero}`);
    const idx = state.racks.findIndex(r => r.id === _editandoRackId);
    if (idx !== -1) state.racks[idx] = { ...state.racks[idx], ...datos };
    guardar(); renderTodo(); MM.cerrar('modal-rack-editar');
    toast(`Rack ${datos.numero} actualizado`);
}

function eliminarRackActual() {
    if (!_editandoRackId) return;
    const rack = state.racks.find(r => r.id === _editandoRackId); if (!rack) return;
    confirmar(`¿Eliminar rack "${rack.numero}"?`, 'Esta acción se puede deshacer antes de cerrar la página.', () => {
        historial.empujar(`Eliminar rack ${rack.numero}`);
        state.racks = state.racks.filter(r => r.id !== _editandoRackId);
        guardar(); renderTodo(); MM.cerrar('modal-rack-editar');
        toast('Rack eliminado', 'info');
    });
}

// ═══════════════════════════════════════════════════════
//  RENDER HELPERS
// ═══════════════════════════════════════════════════════
const ESTADO_BADGE = {
    inventario: '<span class="rack-badge rack-badge-inventario">Inventario</span>',
    servicio: '<span class="rack-badge rack-badge-servicio">Servicio</span>',
    mantenimiento: '<span class="rack-badge rack-badge-mantenimiento">Mantenim.</span>',
    baja: '<span class="rack-badge rack-badge-baja">Baja</span>',
};
function _ports(r) {
    const parts = [];
    if (r.p24) parts.push(`24p:${r.p24}`);
    if (r.p48) parts.push(`48p:${r.p48}`);
    if (r.fibra) parts.push(`F:${r.fibra}`);
    return parts.join(' ');
}

// ─── Filtro estado activo ───
let _filtroEstado = null;
function setFiltroEstado(e) { _filtroEstado = (_filtroEstado === e) ? null : e; renderFilterChips(); renderTodo(); }

function renderFilterChips() {
    const CHIPS = [
        { key: 'inventario', label: 'Inventario' },
        { key: 'servicio', label: 'Servicio' },
        { key: 'mantenimiento', label: 'Mantenim.' },
        { key: 'baja', label: 'Baja' },
    ];
    ['filter-chips-dash', 'filter-chips-inv'].forEach(id => {
        const el = document.getElementById(id); if (!el) return;
        el.innerHTML = CHIPS.map(c => `
            <button class="filter-chip${_filtroEstado === c.key ? ' activo' : ''}" onclick="setFiltroEstado('${c.key}')">${c.label}</button>
        `).join('');
    });
}

// ═══════════════════════════════════════════════════════
//  RENDER DASHBOARD
// ═══════════════════════════════════════════════════════
function _getRacksFiltrados() {
    const busq = normalizarTexto(document.getElementById('busq-global')?.value || '');
    let racks = [...state.racks];
    if (_filtroEstado) racks = racks.filter(r => r.estado === _filtroEstado);
    if (busq) {
        racks = racks.filter(r => {
            const h = normalizarTexto([r.numero, r.patrimonio, r.marca, r.edificio, r.piso, r.lugar, r.notas].join(' '));
            return busq.split(' ').every(t => h.includes(t));
        });
    }
    racks.sort((a, b) => a.numero.localeCompare(b.numero, 'es', { numeric: true }));
    return racks;
}

function renderDashboard() {
    const racks = _getRacksFiltrados();
    const tbody = document.getElementById('tabla-racks');
    const empty = document.getElementById('racks-empty');
    if (!racks.length) {
        tbody.innerHTML = ''; empty.classList.remove('empty-state-hidden');
    } else {
        empty.classList.add('empty-state-hidden');
        tbody.innerHTML = racks.map(r => {
            const loc = [r.edificio, r.piso].filter(Boolean).join(' ');
            return `<tr class="tr-clickable rack-estado-${r.estado}" onclick="abrirModalEditarRack('${esc(r.id)}')">
                <td style="font-weight:800;color:var(--accent)">${esc(r.numero)}</td>
                <td>${esc(r.marca || r.patrimonio || '—')}</td>
                <td style="font-size:0.82rem;color:var(--text-muted)">${esc(loc || '—')}</td>
                <td>${ESTADO_BADGE[r.estado] || ''}</td>
                <td style="font-size:0.78rem;color:var(--text-muted)">${esc(_ports(r))}</td>
            </tr>`;
        }).join('');
    }

    // stats sidebar
    const all = state.racks;
    const total = all.length, enServ = all.filter(r => r.estado === 'servicio').length;
    const enInv = all.filter(r => r.estado === 'inventario').length;
    const enMant = all.filter(r => r.estado === 'mantenimiento').length;
    const enBaja = all.filter(r => r.estado === 'baja').length;

    const distRows = total ? [
        { label: 'Inventario', n: enInv, color: 'var(--c-blue)' },
        { label: 'Servicio', n: enServ, color: 'var(--c-green)' },
        { label: 'Mantenim.', n: enMant, color: 'var(--c-orange)' },
        { label: 'Baja', n: enBaja, color: 'var(--c-red)' },
    ].filter(e => e.n > 0).map(e => {
        const pct = Math.round((e.n / total) * 100);
        return `<div class="rack-dist-bar">
            <span class="rack-dist-label" style="color:${e.color}">${e.label}</span>
            <div class="rack-dist-bar-track"><div class="rack-dist-bar-fill" style="width:${pct}%;background:${e.color}"></div></div>
            <span class="rack-dist-count">${e.n}</span>
        </div>`;
    }).join('') : '<p style="font-size:0.82rem;color:var(--text-muted)">Sin datos</p>';

    document.getElementById('stats-grid').innerHTML = `
        <div class="stat-chip">
            <span class="stat-chip-label">Racks</span>
            <span class="stat-chip-value">${total}</span>
            <span class="stat-chip-sub">registrados</span>
        </div>
        <div class="stat-chip">
            <span class="stat-chip-label">En Servicio</span>
            <span class="stat-chip-value" style="color:var(--c-green)">${enServ}</span>
            <span class="stat-chip-sub">activos</span>
        </div>
        <div class="stat-chip">
            <span class="stat-chip-label">Inventario</span>
            <span class="stat-chip-value" style="color:var(--c-blue)">${enInv}</span>
            <span class="stat-chip-sub">disponibles</span>
        </div>
        <div class="rack-sidebar-chip">
            <span class="stat-chip-label" style="margin-bottom:0.5rem">Distribución</span>
            ${distRows}
        </div>
    `;
}

// ═══════════════════════════════════════════════════════
//  RENDER SERVICIO
// ═══════════════════════════════════════════════════════
function renderServicio() {
    const busq = normalizarTexto(document.getElementById('busq-global')?.value || '');
    const tbody = document.getElementById('tabla-servicio');
    const empty = document.getElementById('servicio-empty');
    const count = document.getElementById('servicio-count');

    let racks = state.racks.filter(r => r.estado === 'servicio');
    if (busq) {
        racks = racks.filter(r => {
            const h = normalizarTexto([r.numero, r.marca, r.edificio, r.asig?.edificio, r.asig?.lugar, r.lugar].join(' '));
            return busq.split(' ').every(t => h.includes(t));
        });
    }
    racks.sort((a, b) => a.numero.localeCompare(b.numero, 'es', { numeric: true }));
    count.textContent = racks.length;

    if (!racks.length) { tbody.innerHTML = ''; empty.classList.remove('empty-state-hidden'); return; }
    empty.classList.add('empty-state-hidden');

    tbody.innerHTML = racks.map(r => {
        const loc = r.asig ? [r.asig.edificio, r.asig.piso, r.asig.lugar].filter(Boolean).join(' · ') : (r.edificio || '—');
        return `<tr class="tr-clickable" onclick="abrirModalEditarRack('${esc(r.id)}')">
            <td class="rack-num-cell" style="font-weight:800;color:var(--accent)">${esc(r.numero)}</td>
            <td>${esc(r.marca || '—')}</td>
            <td style="font-size:0.82rem">${esc(loc || '—')}</td>
            <td style="font-size:0.82rem;color:var(--text-muted)">${r.asig?.fecha ? formatFecha(r.asig.fecha) : '—'}</td>
            <td style="font-size:0.78rem;color:var(--text-muted)">${esc(_ports(r))}</td>
        </tr>`;
    }).join('');
}

// ═══════════════════════════════════════════════════════
//  RENDER INVENTARIO
// ═══════════════════════════════════════════════════════
function renderInventario() {
    const busq = normalizarTexto(document.getElementById('busq-global')?.value || '');
    const tbody = document.getElementById('tabla-inventario');
    const empty = document.getElementById('inventario-empty');
    const count = document.getElementById('inventario-count');

    let racks = [...state.racks];
    if (_filtroEstado) racks = racks.filter(r => r.estado === _filtroEstado);
    if (busq) {
        racks = racks.filter(r => {
            const h = normalizarTexto([r.numero, r.patrimonio, r.marca, r.edificio, r.piso, r.lugar, r.notas].join(' '));
            return busq.split(' ').every(t => h.includes(t));
        });
    }
    racks.sort((a, b) => a.numero.localeCompare(b.numero, 'es', { numeric: true }));
    count.textContent = racks.length;

    if (!racks.length) { tbody.innerHTML = ''; empty.classList.remove('empty-state-hidden'); return; }
    empty.classList.add('empty-state-hidden');

    tbody.innerHTML = racks.map(r => {
        const loc = [r.edificio, r.piso, r.lugar].filter(Boolean).join(' · ');
        return `<tr class="tr-clickable rack-estado-${r.estado}" onclick="abrirModalEditarRack('${esc(r.id)}')">
            <td style="font-weight:800;color:var(--accent)">${esc(r.numero)}</td>
            <td style="font-size:0.82rem;color:var(--text-muted)">${esc(r.patrimonio || '—')}</td>
            <td>${esc(r.marca || '—')}</td>
            <td style="font-size:0.82rem;color:var(--text-muted)">${esc(loc || '—')}</td>
            <td style="text-align:center">${r.unidades ? esc(String(r.unidades)) : '—'}</td>
            <td>${ESTADO_BADGE[r.estado] || ''}</td>
            <td style="font-size:0.78rem;color:var(--text-muted)">${esc(_ports(r))}</td>
        </tr>`;
    }).join('');
}

// ═══════════════════════════════════════════════════════
//  RENDER GLOBAL
// ═══════════════════════════════════════════════════════
function renderTodo() {
    renderFilterChips();
    renderDashboard();
    renderServicio();
    renderInventario();
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
    const CFG_KEY = 'RCK_gist_cfg', FILENAME = 'racks_data.json', DEBOUNCE_MS = 3000;
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
        if (bu) bu.style.display = (token && gist) ? 'flex' : 'none';
        if (bd) bd.style.display = gist ? 'flex' : 'none';
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
//  KEYBOARD + SCROLL + MISC
// ═══════════════════════════════════════════════════════
document.addEventListener('keydown', e => {
    const modalOpen = document.body.classList.contains('modal-open');
    if (e.key === 'Escape' && modalOpen) { MM.cerrarTop(); return; }
    if (e.ctrlKey && !e.altKey) {
        if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); historial.undo(); return; }
        if (e.key === 'y' || e.key === 'Y') { e.preventDefault(); historial.redo(); return; }
    }
    if (!modalOpen && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const tag = document.activeElement?.tagName;
        const enInput = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
        if (e.key === '+' || e.key === '=') { e.preventDefault(); UI.abrirNuevoRack(); return; }
        if (!enInput && (e.key === 'Backspace' || (e.key.length === 1 && /[a-zA-Z0-9]/.test(e.key)))) {
            const b = document.getElementById('busq-global'); if (b) { b.focus(); if (e.key === 'Backspace') { e.preventDefault(); b.value = b.value.slice(0, -1); onBusqGlobal(); } }
        }
    }
});

window.addEventListener('scroll', () => {
    const btn = document.getElementById('btn-scroll-top');
    if (btn) btn.classList.toggle('show', window.scrollY > window.innerHeight);
    const h = document.getElementById('main-header');
    if (h) h.classList.toggle('scrolled', window.scrollY > 50);
}, { passive: true });

document.addEventListener('input', e => { if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') e.target.classList.remove('error'); });

// Delegación botones cerrar
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('rack-nuevo-cancelar-btn')?.addEventListener('click', () => UI.cerrarNuevoRack());
    document.getElementById('rack-editar-cancelar-btn')?.addEventListener('click', () => MM.cerrar('modal-rack-editar'));
    document.getElementById('ajustes-cerrar-btn')?.addEventListener('click', () => UI.cerrarAjustes());
    document.getElementById('gist-cerrar-btn')?.addEventListener('click', () => UI.cerrarGist());
    document.getElementById('importar-cerrar-btn')?.addEventListener('click', () => UI.cerrarImportar());

    // import dropzone drag
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
});

// ═══════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════
cargar();

// dark icon
try { if (localStorage.getItem('RCK_dark') === '1') { document.getElementById('dark-icon-use')?.setAttribute('href', '#icon-sun'); } } catch (_) { }

// restore tab
try {
    const t = localStorage.getItem('RCK_tab');
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

renderFilterChips();
renderTodo();
GistSync.init();