(() => {
    'use strict';

    // ════════════════════════════════════════════════════════════════════════════
    // § BOOT — dark-mode y tab inicial (síncrono, antes del parse completo)
    // ════════════════════════════════════════════════════════════════════════════
    ; (() => {
        try {
            const t = localStorage.getItem('cctv_tema');
            if (t === 'true' || t === null) document.body.classList.add('dark-mode');
            const saved = JSON.parse(localStorage.getItem('cctv_tab') || 'null');
            const tab = (saved && saved.tab && (Date.now() - saved.ts) < 3600000) ? saved.tab : 'dashboard';
            document.body.setAttribute('data-tab-inicial', tab);
        } catch (_) { }
    })();

    // ════════════════════════════════════════════════════════════════════════════
    // § CONSTANTES — literales compartidos entre módulos
    // ════════════════════════════════════════════════════════════════════════════

    // Tabs de la aplicación
    const TABS = ['dashboard', 'activos', 'produccion'];

    // Tiempo de expiración de estado guardado en localStorage
    const UNA_HORA = 60 * 60 * 1000;

    // Claves localStorage
    const LS = {
        TEMA: 'cctv_tema',
        TAB: 'cctv_tab',
        ACTIVOS_ORDEN: 'cctv_activos_orden',
        ACTIVOS_RECORDAR: 'cctv_activos_recordar',
        ACTIVOS_COLLAPSED: 'cctv_act_collapsed',
        PISOS_COLLAPSED: 'cctv_pisos_collapsed',
    };

    // Formas de cámara (orden canónico)
    const FORMAS = ['domo', 'bullet', 'turret', 'minidomo', 'minibullet', 'domo-ptz'];

    // Formas con etiqueta para UI
    const FORMAS_DEF = [
        { key: 'domo', label: 'Domo' },
        { key: 'bullet', label: 'Bullet' },
        { key: 'turret', label: 'Turret' },
        { key: 'minidomo', label: 'Mini domo' },
        { key: 'minibullet', label: 'Mini bullet' },
        { key: 'domo-ptz', label: 'Domo PTZ' },
    ];

    // Estados de dispositivo con etiqueta para UI
    const ESTADOS_DEF = [
        { key: 'produccion', label: 'En producción', labelPlural: 'En producción' },
        { key: 'disponible', label: 'Disponible', labelPlural: 'Disponibles' },
        { key: 'averiado', label: 'Averiado', labelPlural: 'Averiados' },
        { key: 'revisar', label: 'En revisión', labelPlural: 'A revisar' },
        { key: 'desafectado', label: 'Desafectado', labelPlural: 'Desafectados' },
    ];

    // Lookup rápido estado → etiqueta singular/plural
    const ESTADO_LABEL = Object.fromEntries(ESTADOS_DEF.map(e => [e.key, e.label]));
    const ESTADO_LABEL_PLURAL = Object.fromEntries(ESTADOS_DEF.map(e => [e.key, e.labelPlural]));

    // ════════════════════════════════════════════════════════════════════════════
    // § UTILIDADES / SCHEMA (S) — sanitización, validación, tipos, edificios
    // ════════════════════════════════════════════════════════════════════════════
    const S = (() => {
        const MAX_JSON = 4 * 1024 * 1024;
        const SCHEMA_V = 1;
        const MAX_STR = 500;

        const RE_ID = /^[a-z0-9]+$/i;
        const RE_FECHA = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

        function sanitize(str, max = MAX_STR) {
            if (typeof str !== 'string') return '';
            return str
                .replace(/[<>"'`]/g, '')
                .replace(/javascript:/gi, '')
                .replace(/data:/gi, '')
                .replace(/on\w+\s*=/gi, '')
                .replace(/[\x00-\x1F\x7F]/g, '')
                .trim()
                .substring(0, max);
        }

        function _strSeguro(v, maxLen = MAX_STR) {
            if (typeof v !== 'string') return null;
            const s = sanitize(v, maxLen);
            return s.length ? s : null;
        }

        function genId() {
            if (window.crypto?.getRandomValues) {
                const a = new Uint32Array(4);
                crypto.getRandomValues(a);
                return Array.from(a, n => n.toString(36)).join('');
            }
            return Date.now().toString(36) + Math.random().toString(36).slice(2);
        }

        function fechaISO() {
            const d = new Date(), p = n => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
        }

        function deepClone(o) {
            try { return structuredClone(o); }
            catch { return JSON.parse(JSON.stringify(o)); }
        }

        function safeParse(json) {
            if (!json) return null;
            try {
                return JSON.parse(json, (k, v) => {
                    if (['__proto__', 'constructor', 'prototype'].includes(k)) return undefined;
                    return v;
                });
            } catch { return null; }
        }

        async function generarFirma(obj) {
            if (!obj) return '0';
            const core = {
                d: (obj.dispositivos || []).map(x => [
                    x.id, x.tipo, x.estado || null, x.mac || null, x.serial || null, x.canales || null
                ]),
                g: (obj.grabadores || []).map(x => [
                    x.id, x.dispositivoId || null, x.canales_n || 16,
                    (x.canales_data || []).map(c => [c.canal, c.dispositivoId || null])
                ]),
                op: (obj.otros_prod || []).map(x => [
                    x.id, x.dispositivoId || null, x.descripcion || null
                ]),
                t: obj.tiposCustom || {},
                e: obj.edificios || []
            };
            const buf = new TextEncoder().encode(JSON.stringify(core));
            const hash = await crypto.subtle.digest('SHA-256', buf);
            return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
        }

        async function verificarFirma(raw) {
            if (!raw || typeof raw !== 'object' || !raw.hash) return false;
            const firmaCalculada = await generarFirma(raw);
            return raw.hash === firmaCalculada;
        }

        const TIPOS_BUILTIN = {
            camara: { label: 'Cámara', emoji: '📹', badge: 'badge-camara', dot: 'var(--c-blue)', builtin: true },
            nvr: { label: 'NVR', emoji: '📟', badge: 'badge-nvr', dot: 'var(--c-green)', builtin: true },
            dvr: { label: 'DVR', emoji: '📼', badge: 'badge-dvr', dot: 'var(--c-orange)', builtin: true },
        };

        const KEY_TIPOS = 'cctv_tipos_custom';
        let TIPOS = { ...TIPOS_BUILTIN };

        function cargarTipos() {
            try {
                const raw = localStorage.getItem(KEY_TIPOS);
                if (!raw) return;
                const custom = safeParse(raw);
                if (typeof custom !== 'object' || Array.isArray(custom)) return;
                Object.entries(custom).forEach(([k, v]) => {
                    if (TIPOS_BUILTIN[k]) return;
                    if (typeof v.label !== 'string' || typeof v.emoji !== 'string') return;
                    TIPOS[k] = { label: sanitize(v.label, 50), emoji: sanitize(v.emoji, 10), badge: 'badge-otro', dot: 'var(--c-gold)', builtin: false };
                });
            } catch { }
        }

        function guardarTipos() {
            const custom = {};
            Object.entries(TIPOS).forEach(([k, v]) => {
                if (!v.builtin) custom[k] = { label: v.label, emoji: v.emoji };
            });
            localStorage.setItem(KEY_TIPOS, JSON.stringify(custom));
        }
        cargarTipos();

        const KEY_EDIFICIOS = 'cctv_edificios';
        let _edificios = [];

        function cargarEdificios() {
            try {
                const raw = localStorage.getItem(KEY_EDIFICIOS);
                if (!raw) return;
                const parsed = safeParse(raw);
                if (Array.isArray(parsed)) {
                    _edificios = parsed.filter(e => typeof e === 'string' && e.trim().length > 0).map(e => sanitize(e, 60));

                    _edificios.sort((a, b) => a.localeCompare(b));
                }
            } catch { }
        }

        function guardarEdificios() {

            _edificios.sort((a, b) => a.localeCompare(b));
            localStorage.setItem(KEY_EDIFICIOS, JSON.stringify(_edificios));
        }
        cargarEdificios();

        function validarIP(ip) {
            if (!ip) return true;

            if (ip.includes('.') && !ip.includes(':')) {
                const partes = ip.split('.');
                if (partes.length !== 4) return false;
                return partes.every(p => {
                    if (!/^\d+$/.test(p)) return false;
                    if (p.length > 1 && p[0] === '0') return false;
                    const n = Number(p);
                    return n >= 0 && n <= 255;
                });
            }

            return validarIPv6(ip);
        }

        function validarIPv6(ip) {

            const raw = ip.split('%')[0];
            if (raw === '::') return true;
            const sides = raw.split('::');
            if (sides.length > 2) return false;
            const grupos = sides.flatMap(s => s ? s.split(':') : []);
            if (sides.length === 1 && grupos.length !== 8) return false;
            if (sides.length === 2) {
                const totalGrupos = (sides[0] ? sides[0].split(':').length : 0)
                    + (sides[1] ? sides[1].split(':').length : 0);
                if (totalGrupos > 7) return false;
            }

            const last = grupos[grupos.length - 1];
            if (last && last.includes('.')) {
                const ipv4part = last;
                const partes = ipv4part.split('.');
                if (partes.length !== 4) return false;
                if (!partes.every(p => /^\d+$/.test(p) && Number(p) <= 255)) return false;
                grupos.pop();
            }
            return grupos.every(g => /^[0-9A-Fa-f]{1,4}$/.test(g));
        }


        function validarMAC(mac) {
            if (!mac) return true;
            if (/^sinrelevarn?\d{1,3}$/i.test(mac)) return true;
            return /^([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}$/.test(mac);
        }

        function sanitizarDisp(d, extraTipos = {}) {
            if (!d || typeof d !== 'object') return null;
            const id = _strSeguro(d.id, 32);
            if (!id || !RE_ID.test(id)) return null;

            const tipo = (TIPOS[d.tipo] || extraTipos[d.tipo]) ? d.tipo : 'otro';
            const ESTADOS = ['', 'averiado', 'revisar', 'desafectado'];

            const obj = {
                id,
                tipo,
                estado: ESTADOS.includes(d.estado) ? d.estado : '',
                marca: sanitize(d.marca || '', 50),
                modelo: sanitize(d.modelo || '', 60),
                serial: sanitize(d.serial || '', 80),
                mac: sanitize(d.mac || '', 500),
                patrimonio: sanitize(d.patrimonio || '', 60),
                firmware: sanitize(d.firmware || '', 80),
            };

            if (tipo === 'camara') {
                const formaNorm = (d.forma || '').toLowerCase().replace(/\s+/g, '-');
                obj.forma = FORMAS.includes(formaNorm) ? formaNorm : '';
            }
            if (['nvr', 'dvr'].includes(tipo)) {
                const c = parseInt(d.canales);
                obj.canales = Number.isFinite(c) && c >= 1 && c <= 256 ? c : 16;
            }
            return obj;
        }

        function sanitizarGrab(g) {
            if (!g || typeof g !== 'object') return null;
            const id = _strSeguro(g.id, 32);
            if (!id || !RE_ID.test(id)) return null;

            const canales_n = parseInt(g.canales ?? g.canales_n);
            const n = Number.isFinite(canales_n) && canales_n >= 1 && canales_n <= 256 ? canales_n : 16;

            const slots = [];
            const canalMap = {};
            if (Array.isArray(g.canales_data)) {
                g.canales_data.forEach(c => {
                    if (typeof c === 'object' && c.canal) canalMap[c.canal] = c;
                });
            }

            for (let i = 1; i <= n; i++) {
                const existente = canalMap[i] || null;
                slots.push({
                    canal: i,
                    dispositivoId: _strSeguro(existente?.dispositivoId, 32) || null,
                    descripcion: sanitize(existente?.descripcion || '', 80),
                    ip: validarIP(existente?.ip) ? sanitize(existente?.ip || '', 46) : '',
                    puerto: sanitize(existente?.puerto || '', 10),
                    edificio: sanitize(existente?.edificio || '', 60),
                    piso: sanitize(existente?.piso || '', 4),
                    rack: sanitize(existente?.rack || '', 40),
                    comentarios: sanitize(existente?.comentarios || '', 300),
                });
            }

            return {
                id,
                descripcion: sanitize(g.descripcion || '', 80),
                tipo: ['nvr', 'dvr'].includes(g.tipo) ? g.tipo : 'nvr',
                marca: sanitize(g.marca || '', 50),
                modelo: sanitize(g.modelo || '', 60),
                ip: validarIP(g.ip) ? sanitize(g.ip || '', 46) : '',
                edificio: sanitize(g.edificio || '', 60),
                piso: sanitize(g.piso || '', 4),
                rack: sanitize(g.rack || '', 40),
                puerto: sanitize(g.puerto || '', 10),
                mac: sanitize(g.mac || '', 500),
                comentarios: sanitize(g.comentarios || '', 300),
                dispositivoId: _strSeguro(g.dispositivoId, 32) || null,
                canales_n: n,
                canales_data: slots,
            };
        }

        function sanitizarOtroProd(o) {
            if (!o || typeof o !== 'object') return null;
            const id = _strSeguro(o.id, 32);
            if (!id || !RE_ID.test(id)) return null;

            return {
                id,
                dispositivoId: _strSeguro(o.dispositivoId, 32) || null,
                descripcion: sanitize(o.descripcion || '', 80),
                ip: validarIP(o.ip) ? sanitize(o.ip || '', 46) : '',
                edificio: sanitize(o.edificio || '', 60),
                piso: sanitize(o.piso || '', 4),
                rack: sanitize(o.rack || '', 40),
                puerto: sanitize(o.puerto || '', 10),
                comentarios: sanitize(o.comentarios || '', 300),
            };
        }

        function sanitizarDataTotal(raw) {
            if (!raw || typeof raw !== 'object') return null;

            const dispositivos = Array.isArray(raw.dispositivos)
                ? raw.dispositivos.map(sanitizarDisp).filter(Boolean)
                : [];

            const grabadores = Array.isArray(raw.grabadores)
                ? raw.grabadores.map(sanitizarGrab).filter(Boolean)
                : [];

            return { dispositivos, grabadores };
        }

        function normalizarPiso(p) {
            if (!p || typeof p !== 'string') return '';
            const s = sanitize(p, 4).toUpperCase();

            if (/^-?\d+$/.test(s)) return parseInt(s, 10).toString();
            return s;
        }

        return {
            sanitize, genId, fechaISO, deepClone, safeParse, MAX_JSON, SCHEMA_V, TIPOS_BUILTIN,
            get TIPOS() { return TIPOS; }, guardarTipos, cargarTipos,
            get edificios() { return _edificios; }, guardarEdificios, cargarEdificios,
            generarFirma, verificarFirma, sanitizarDisp, sanitizarGrab, sanitizarOtroProd, sanitizarDataTotal,
            validarIP, validarIPv6, validarMAC, normalizarPiso
        };
    })();


    // ════════════════════════════════════════════════════════════════════════════
    // § MODAL MANAGER (MM) — apertura/cierre de modales, Escape, click-fuera
    // ════════════════════════════════════════════════════════════════════════════
    const MM = (() => {
        let _mdDown = false;
        const _onCerrar = {};

        function _onMD(e) { _mdDown = e.target === e.currentTarget; }
        function _onClick(e) {
            if (!_mdDown) return;
            if (e.target === e.currentTarget) _cerrarConPadre(e.target.id);
        }

        function _cerrarConPadre(id) {
            const fn = _onCerrar[id];
            if (fn) { fn(); } else { cerrar(id); }
        }

        function abrir(id, optsOrCb) {
            const m = document.getElementById(id); if (!m) return;
            let cb, onEscape;
            if (typeof optsOrCb === 'function') {
                cb = optsOrCb;
            } else if (optsOrCb && typeof optsOrCb === 'object') {
                cb = optsOrCb.cb;
                onEscape = optsOrCb.onEscape;
            }
            if (onEscape) {
                _onCerrar[id] = onEscape;
            } else {
                delete _onCerrar[id];
            }
            m.classList.add('show');
            document.body.classList.add('modal-open');
            setTimeout(() => {
                m.addEventListener('mousedown', _onMD);
                m.addEventListener('click', _onClick);
            }, 100);
            cb?.();
        }

        function cerrar(id, cb) {
            const m = document.getElementById(id); if (!m) return;
            delete _onCerrar[id];
            m.classList.remove('show');
            if (!document.querySelector('.modal.show')) {
                document.body.classList.remove('modal-open');
            }
            m.removeEventListener('mousedown', _onMD);
            m.removeEventListener('click', _onClick);
            cb?.();
        }

        function cerrarTodos() {
            document.querySelectorAll('.modal.show').forEach(m => {
                delete _onCerrar[m.id];
                m.classList.remove('show');
                m.removeEventListener('mousedown', _onMD);
                m.removeEventListener('click', _onClick);
            });
            document.body.classList.remove('modal-open');
        }

        function cerrarTop() {
            const abiertos = [...document.querySelectorAll('.modal.show')];
            if (!abiertos.length) return;
            const conHandler = abiertos.filter(m => _onCerrar[m.id]);
            const target = conHandler.length ? conHandler[conHandler.length - 1] : abiertos[abiertos.length - 1];
            _cerrarConPadre(target.id);
        }

        return { abrir, cerrar, cerrarTodos, cerrarTop };
    })();


    // ════════════════════════════════════════════════════════════════════════════
    // § NOTIFICACIONES — toast queue y modal de confirmación
    // ════════════════════════════════════════════════════════════════════════════
    function confirmarModal(texto, labelOk = 'Eliminar') {
        return new Promise(resolve => {
            document.getElementById('modal-confirmar-texto').textContent = texto;
            document.getElementById('modal-confirmar-label').textContent = labelOk;
            const ok = document.getElementById('modal-confirmar-ok');
            const can = document.getElementById('modal-confirmar-cancel');
            let resuelto = false;
            function si() { if (!resuelto) { resuelto = true; cleanup(); resolve(true); } }
            function no() { if (!resuelto) { resuelto = true; cleanup(); resolve(false); } }
            function onEscape(e) {
                if (e.key === 'Escape') no();
            }
            function cleanup() {
                ok.removeEventListener('click', si);
                can.removeEventListener('click', no);
                document.removeEventListener('keydown', onEscape, true);
                MM.cerrar('modal-confirmar');
            }
            ok.addEventListener('click', si);
            can.addEventListener('click', no);
            document.addEventListener('keydown', onEscape, true);
            MM.abrir('modal-confirmar');
        });
    }

    const _toastQueue = [];
    let _toastActivo = false;
    let _toastUltimo = null;

    function toast(msg, tipo = 'success') {
        if (_toastUltimo && _toastUltimo.msg === msg && _toastUltimo.tipo === tipo) return;
        if (_toastQueue.some(t => t.msg === msg && t.tipo === tipo)) return;
        _toastQueue.push({ msg, tipo });
        _procesarToastQueue();
    }

    function _procesarToastQueue() {
        if (_toastActivo || _toastQueue.length === 0) return;
        const { msg, tipo } = _toastQueue.shift();
        _toastActivo = true;
        _toastUltimo = { msg, tipo };
        const el = document.getElementById('toast'); if (!el) { _toastActivo = false; return; }
        el.textContent = msg;
        el.className = `toast show ${tipo}`;
        setTimeout(() => {
            el.classList.remove('show');
            setTimeout(() => {
                el.className = 'toast';
                _toastActivo = false;
                _toastUltimo = null;
                _procesarToastQueue();
            }, 300);
        }, 3000);
    }


    // ════════════════════════════════════════════════════════════════════════════
    // § STORE — datos en memoria, persistencia localStorage
    // ════════════════════════════════════════════════════════════════════════════
    const KEY = 'cctv_data_v1';
    let _data = { dispositivos: [], grabadores: [], otros_prod: [] };

    // Caches de derived data — se invalidan en cada guardar()/cargar()
    let _cacheAsignaciones = null;
    let _cacheDupMacs = null;
    let _cacheDupPatrimonios = null;

    function _invalidarCaches() {
        _cacheAsignaciones = null;
        _cacheDupMacs = null;
        _cacheDupPatrimonios = null;
    }

    function cargar() {
        try {
            const raw = localStorage.getItem(KEY);
            if (!raw) return;
            const d = S.safeParse(raw);
            _data.dispositivos = Array.isArray(d.dispositivos) ? d.dispositivos : [];
            _data.grabadores = Array.isArray(d.grabadores) ? d.grabadores : [];
            _data.otros_prod = Array.isArray(d.otros_prod) ? d.otros_prod : [];
        } catch { _data = { dispositivos: [], grabadores: [], otros_prod: [] }; }
        _invalidarCaches();
    }

    function guardar() {
        try {
            localStorage.setItem(KEY, JSON.stringify(_data));
            _invalidarCaches();
            GistSync.subirAuto();
            return true;
        }
        catch { toast('Error al guardar (almacenamiento lleno)', 'error'); return false; }
    }

    // ════════════════════════════════════════════════════════════════════════════
    // § HISTORIAL — undo/redo stack
    // ════════════════════════════════════════════════════════════════════════════
    const historial = (() => {
        const MAX = 30;
        let _pasado = [];
        let _futuro = [];

        function _actualizarBotones() {
            const btnU = document.getElementById('btn-undo');
            const btnR = document.getElementById('btn-redo');
            if (btnU) btnU.disabled = _pasado.length === 0;
            if (btnR) btnR.disabled = _futuro.length === 0;
        }

        function empujar(label) {
            _pasado.push({
                data: S.deepClone(_data),
                tipos: S.deepClone(S.TIPOS),
                edificios: S.deepClone(S.edificios),
                label
            });
            if (_pasado.length > MAX) _pasado.shift();
            _futuro = [];
            _actualizarBotones();
        }

        function _aplicarEstado(e) {
            _data = e.data;

            Object.keys(S.TIPOS).forEach(k => delete S.TIPOS[k]);
            Object.assign(S.TIPOS, e.tipos);
            S.guardarTipos();

            S.edificios.length = 0;
            S.edificios.push(...e.edificios);
            S.guardarEdificios();

            guardar();
            render();
            _actualizarBotones();
        }

        function undo() {
            if (!_pasado.length) return;
            const entrada = _pasado.pop();
            _futuro.push({
                data: S.deepClone(_data),
                tipos: S.deepClone(S.TIPOS),
                edificios: S.deepClone(S.edificios),
                label: entrada.label
            });
            _aplicarEstado(entrada);
            toast(`Deshecho: ${entrada.label}`, 'info');
        }

        function redo() {
            if (!_futuro.length) return;
            const entrada = _futuro.pop();
            _pasado.push({
                data: S.deepClone(_data),
                tipos: S.deepClone(S.TIPOS),
                edificios: S.deepClone(S.edificios),
                label: entrada.label
            });
            _aplicarEstado(entrada);
            toast(`Rehecho: ${entrada.label}`, 'info');
        }

        return { empujar, undo, redo };
    })();

    document.addEventListener('keydown', e => {

        if (e.ctrlKey && !e.altKey && !e.shiftKey) {
            if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); historial.undo(); return; }
            if (e.key === 'y' || e.key === 'Y') { e.preventDefault(); historial.redo(); return; }
        }

        if (e.key === 'Escape') {

            if (document.querySelector('.modal.show')) {
                MM.cerrarTop();
                return;
            }

            const input = document.getElementById('input-busqueda');
            if (input && input.value) {
                UI.limpiarBusqueda();
                return;
            }

            if (input && document.activeElement === input) {
                input.blur();
                return;
            }
        }
    });


    // ════════════════════════════════════════════════════════════════════════════
    // § HELPERS — esc, validación de campos, utilidades de render
    // ════════════════════════════════════════════════════════════════════════════
    function esc(s) {
        return s == null ? '' : String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function esSerialPendiente(serial) {
        return /^relevar$/i.test(serial.trim());
    }

    function validarCampoIP(elementId) {
        const el = document.getElementById(elementId);
        const ip = el?.value.trim() || '';
        if (!S.validarIP(ip)) {
            el.classList.add('error');
            toast(`IP inválida: "${ip}"`, 'error');
            return false;
        }
        el.classList.remove('error');
        return true;
    }

    function validarCampoMAC(elementId) {
        const el = document.getElementById(elementId);
        const raw = el?.value.trim() || '';
        if (!raw) { el.classList.remove('error'); return true; }
        const tokens = raw.split(',').map(t => t.trim()).filter(Boolean);
        const invalidos = tokens.filter(t => !S.validarMAC(t));
        if (invalidos.length) {
            el.classList.add('error');
            toast(`MAC inválida: "${invalidos[0]}"`, 'error');
            return false;
        }
        el.classList.remove('error');
        return true;
    }


    // ════════════════════════════════════════════════════════════════════════════
    // § GIST SYNC — sincronización con GitHub Gist
    // ════════════════════════════════════════════════════════════════════════════
    const GistSync = (() => {
        const CFG_KEY = 'cctv_gist_cfg';
        const FILENAME = 'cctv_data.json';
        const DEBOUNCE_MS = 3000;
        const RE_GIST_ID = /^[a-f0-9]{20,40}$/i;

        let _cfg = { token: '', gistId: '', lastSync: null, auto: false };
        let _debounceTimer = null;
        let _subiendo = false;

        function _cargarCfg() {
            try { const c = S.safeParse(localStorage.getItem(CFG_KEY) || 'null'); if (c) _cfg = { ..._cfg, ...c }; } catch (_) { }
            _actualizarBotonesAjustes();
        }

        function _guardarCfg() {
            try { localStorage.setItem(CFG_KEY, JSON.stringify(_cfg)); } catch (_) { }
        }

        function _spinStart() {
            document.querySelector('.header-buttons [title="Ajustes"]')?.classList.add('icon-btn-spinning');
        }
        function _spinStop() {
            document.querySelector('.header-buttons [title="Ajustes"]')?.classList.remove('icon-btn-spinning');
        }

        function _setBusy(busy) {
            _subiendo = busy;
            ['btn-gist-subir', 'btn-gist-bajar'].forEach(id => {
                const btn = document.getElementById(id);
                if (btn) btn.disabled = busy;
            });
            if (busy) _spinStart(); else _spinStop();
        }

        function _setStatus(msg) {
            const el = document.getElementById('gist-sync-status');
            if (el) el.textContent = msg;
        }

        function _setStatusSync() {
            if (!_cfg.lastSync) return;
            const d = new Date(_cfg.lastSync);
            const ts = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            _setStatus(`Sincronizado: ${d.toLocaleDateString('es-AR')}, ${ts}`);
        }

        function _actualizarLinkBtn() {
            const id = document.getElementById('gist-id')?.value.trim();
            const btn = document.getElementById('gist-link-btn');
            if (!btn) return;
            if (id) {
                btn.href = `https://gist.github.com/${id}`;
                btn.style.display = 'flex';
            } else {
                btn.style.display = 'none';
            }
        }

        function _actualizarToggleUI() {
            const toggle = document.getElementById('gist-autosync-toggle');
            if (toggle) toggle.classList.toggle('on', !!_cfg.auto);
        }

        function _actualizarBotonesAjustes() {
            const visible = !!((_cfg.token || '').trim()) && !!((_cfg.gistId || '').trim());
            const display = visible ? 'flex' : 'none';
            const btnUp = document.getElementById('btn-ajustes-gist-subir');
            const btnDn = document.getElementById('btn-ajustes-gist-bajar');
            if (btnUp) btnUp.style.display = display;
            if (btnDn) btnDn.style.display = display;
        }

        async function _validarScopeToken(token) {

            try {
                const res = await fetch('https://api.github.com/user', {
                    headers: { Authorization: `token ${token}` }
                });
                if (!res.ok) return { ok: false, error: `Error HTTP ${res.status}` };
                const scopeHeader = res.headers.get('x-oauth-scopes') || '';
                const scopes = scopeHeader.split(',').map(s => s.trim()).filter(Boolean);
                const peligrosos = scopes.filter(s => !['gist', 'read:user'].includes(s));
                return { ok: true, scopes, peligrosos };
            } catch (e) {
                return { ok: false, error: e.message };
            }
        }

        function toggleToken() {
            const inp = document.getElementById('gist-token');
            const icon = document.getElementById('gist-eye-icon');
            if (!inp) return;
            const mostrar = inp.type === 'password';
            inp.type = mostrar ? 'text' : 'password';
            if (icon) icon.setAttribute('href', mostrar ? '#icon-eye-off' : '#icon-eye');
        }

        function toggleAuto() {
            const toggle = document.getElementById('gist-autosync-toggle');
            if (toggle) toggle.classList.toggle('on');
        }

        function guardarConfig() {
            const tokenEl = document.getElementById('gist-token');
            const idEl = document.getElementById('gist-id');
            const toggleEl = document.getElementById('gist-autosync-toggle');

            const nuevoToken = tokenEl?.value.trim() || '';
            const nuevoGistId = idEl?.value.trim() || '';
            const nuevoAuto = toggleEl ? toggleEl.classList.contains('on') : false;

            if (nuevoGistId && !RE_GIST_ID.test(nuevoGistId)) {
                toast('El Gist ID tiene un formato inválido', 'error');
                if (idEl) idEl.classList.add('error');
                return;
            }

            const tokenActual = _cfg.token || '';
            const idActual = _cfg.gistId || '';
            const autoActual = !!_cfg.auto;

            if (tokenActual === nuevoToken && idActual === nuevoGistId && autoActual === nuevoAuto) {
                UI.cerrarGist();
                toast('Sin cambios', 'info');
                return;
            }

            _cfg.token = nuevoToken;
            _cfg.gistId = nuevoGistId;
            _cfg.auto = nuevoAuto;

            _guardarCfg();
            _actualizarBotonesAjustes();

            if (autoActual !== nuevoAuto) {
                toast(nuevoAuto ? 'Sincronización automática activada' : 'Sincronización automática desactivada');
            } else {
                toast('Configuración guardada');
            }

            if (nuevoToken && nuevoToken !== tokenActual) {
                _validarScopeToken(nuevoToken).then(r => {
                    if (!r.ok) return;
                    if (r.peligrosos && r.peligrosos.length > 0) {
                        const listaScopes = r.peligrosos.join(', ');
                        toast(`⚠️ El token tiene permisos extra: ${listaScopes}. Recomendamos usar solo scope "gist".`, 'warning');
                    }
                });
            }

            UI.cerrarGist();
        }

        async function _generarPayload() {
            const disps = _data.dispositivos.map(d => S.sanitizarDisp(d)).filter(Boolean);
            const grabs = _data.grabadores.map(g => S.sanitizarGrab(g)).filter(Boolean);
            const otros = (_data.otros_prod || []).map(S.sanitizarOtroProd).filter(Boolean);
            const tiposCustom = {};
            Object.entries(S.TIPOS).forEach(([k, v]) => {
                if (!v.builtin) tiposCustom[k] = { label: v.label, emoji: v.emoji };
            });
            const payload = {
                dispositivos: disps,
                grabadores: grabs,
                otros_prod: otros,
                tiposCustom,
                edificios: S.edificios.slice(),
                version: S.SCHEMA_V,
                fecha: S.fechaISO()
            };

            payload.hash = await S.generarFirma(payload);
            return payload;
        }

        async function _ejecutarSubida(silencioso = false) {
            const token = _cfg.token;
            const gistId = _cfg.gistId;
            if (!token) { if (!silencioso) toast('Ingresá el token primero', 'error'); return; }
            if (gistId && !RE_GIST_ID.test(gistId)) {
                if (!silencioso) toast('Gist ID inválido', 'error');
                return;
            }

            _setBusy(true);
            if (!silencioso) _setStatus('Subiendo…');

            const payloadData = await _generarPayload();
            const body = { files: { [FILENAME]: { content: JSON.stringify(payloadData, null, 2) } } };

            try {
                let res, data;
                if (gistId) {
                    res = await fetch(`https://api.github.com/gists/${gistId}`, {
                        method: 'PATCH',
                        headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify(body),
                    });
                } else {
                    body.description = 'CCTV — Control de Activos';
                    body.public = false;
                    res = await fetch('https://api.github.com/gists', {
                        method: 'POST',
                        headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify(body),
                    });
                }

                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                data = await res.json();

                if (!gistId && data.id) {
                    _cfg.gistId = data.id;
                    const el = document.getElementById('gist-id');
                    if (el) el.value = data.id;
                    _actualizarLinkBtn();
                }

                _cfg.lastSync = new Date().toISOString();
                _guardarCfg();
                _setStatusSync();
                if (!silencioso) toast('Datos subidos a Gist');

            } catch (err) {
                _setStatus(`Error: ${err.message}`);
                if (!silencioso) toast(`Error al subir: ${err.message}`, 'error');
            } finally {
                _setBusy(false);
            }
        }

        function subir() { _ejecutarSubida(false); }

        function subirAuto() {
            if (!_cfg.auto || !_cfg.token) return;
            clearTimeout(_debounceTimer);
            _debounceTimer = setTimeout(() => {
                if (!_subiendo) _ejecutarSubida(true);
            }, DEBOUNCE_MS);
        }

        // ── Helper: merge de entidades (dispositivos, grabadores, otros_prod) ──────
        // Acepta datos ya sanitizados o crudos (los sanitiza internamente).
        // NO maneja tipos/edificios — eso lo hace _combinarDatosRemotos.
        function _combinarEntidades(remoto) {
            let cDispsAdd = 0, cDispsUpd = 0;
            let cGrabsAdd = 0, cGrabsUpd = 0;
            let cOtrosAdd = 0, cOtrosUpd = 0;

            const mapD = new Map(_data.dispositivos.map(d => [d.id, d]));
            const mapG = new Map(_data.grabadores.map(g => [g.id, g]));
            const mapO = new Map((_data.otros_prod || []).map(o => [o.id, o]));

            (remoto.dispositivos || []).forEach(d => {
                const san = d._sanitized ? d : S.sanitizarDisp(d, remoto.tiposCustom || {});
                if (!san) return;
                if (!mapD.has(san.id)) {
                    _data.dispositivos.push(san); mapD.set(san.id, san); cDispsAdd++;
                } else {
                    const loc = mapD.get(san.id);
                    let updated = false;
                    ['marca', 'modelo', 'serial', 'mac', 'patrimonio', 'firmware', 'forma', 'estado'].forEach(k => {
                        if (!loc[k] && san[k]) { loc[k] = san[k]; updated = true; }
                    });
                    if (updated) cDispsUpd++;
                }
            });

            (remoto.grabadores || []).forEach(g => {
                const san = g._sanitized ? g : S.sanitizarGrab(g);
                if (!san) return;
                if (!mapG.has(san.id)) {
                    _data.grabadores.push(san); mapG.set(san.id, san); cGrabsAdd++;
                } else {
                    const loc = mapG.get(san.id);
                    let updated = false;
                    ['marca', 'modelo', 'ip', 'edificio', 'piso', 'rack', 'puerto', 'mac', 'comentarios', 'dispositivoId'].forEach(k => {
                        if (!loc[k] && san[k]) { loc[k] = san[k]; updated = true; }
                    });
                    san.canales_data.forEach(cRem => {
                        const cLoc = loc.canales_data.find(c => c.canal === cRem.canal);
                        if (cLoc) {
                            if (!cLoc.dispositivoId && cRem.dispositivoId) {
                                const dispLocal = _data.dispositivos.find(d => d.id === cRem.dispositivoId);
                                const inactivo = dispLocal && ['averiado', 'revisar', 'desafectado'].includes(dispLocal.estado);
                                if (!inactivo) { cLoc.dispositivoId = cRem.dispositivoId; updated = true; }
                            }
                            ['descripcion', 'ip', 'puerto', 'edificio', 'piso', 'rack', 'comentarios'].forEach(k => {
                                if (!cLoc[k] && cRem[k]) { cLoc[k] = cRem[k]; updated = true; }
                            });
                        }
                    });
                    if (updated) cGrabsUpd++;
                }
            });

            (remoto.otros_prod || []).forEach(o => {
                const san = o._sanitized ? o : S.sanitizarOtroProd(o);
                if (!san) return;
                if (!mapO.has(san.id)) {
                    if (!_data.otros_prod) _data.otros_prod = [];
                    _data.otros_prod.push(san); mapO.set(san.id, san); cOtrosAdd++;
                } else {
                    const loc = mapO.get(san.id);
                    let updated = false;
                    ['dispositivoId', 'descripcion', 'ip', 'edificio', 'piso', 'rack', 'puerto', 'comentarios'].forEach(k => {
                        if (!loc[k] && san[k]) { loc[k] = san[k]; updated = true; }
                    });
                    if (updated) cOtrosUpd++;
                }
            });

            return { cDispsAdd, cDispsUpd, cGrabsAdd, cGrabsUpd, cOtrosAdd, cOtrosUpd };
        }

        function _combinarDatosRemotos(remoto) {
            let cTipos = 0, cEdif = 0;

            const res = _combinarEntidades(remoto);

            if (remoto.tiposCustom && typeof remoto.tiposCustom === 'object') {
                Object.entries(remoto.tiposCustom).forEach(([k, v]) => {
                    if (S.TIPOS_BUILTIN[k]) return;
                    if (v && v.label && !S.TIPOS[k]) {
                        S.TIPOS[k] = { label: v.label, emoji: v.emoji || '📦', badge: 'badge-otro', dot: 'var(--c-gold)', builtin: false };
                        cTipos++;
                    }
                });
                if (cTipos > 0) S.guardarTipos();
            }

            if (Array.isArray(remoto.edificios)) {
                const existentes = new Set(S.edificios.map(e => e.toLowerCase()));
                remoto.edificios.forEach(e => {
                    if (typeof e === 'string' && e.trim()) {
                        const lim = S.sanitize(e.trim(), 60);
                        if (!existentes.has(lim.toLowerCase())) {
                            S.edificios.push(lim);
                            existentes.add(lim.toLowerCase());
                            cEdif++;
                        }
                    }
                });
                if (cEdif > 0) S.guardarEdificios();
            }

            return { ...res, cTipos, cEdif };
        }

        async function bajar() {
            const token = document.getElementById('gist-token')?.value.trim() || _cfg.token;
            const gistId = document.getElementById('gist-id')?.value.trim() || _cfg.gistId;
            if (!token) { toast('Ingresá el token primero', 'error'); return; }
            if (!gistId) { toast('Ingresá el Gist ID primero', 'error'); return; }
            if (!RE_GIST_ID.test(gistId)) { toast('Gist ID inválido', 'error'); return; }

            _setBusy(true);
            _setStatus('Bajando…');

            try {
                const res = await fetch(`https://api.github.com/gists/${gistId}`, {
                    headers: { Authorization: `token ${token}` },
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();

                const file = data.files?.[FILENAME];
                if (!file) throw new Error(`No se encontró "${FILENAME}" en el Gist`);

                let contenido = file.content;
                if (file.truncated) {
                    const rawOrigin = new URL(file.raw_url).hostname;
                    if (!rawOrigin.endsWith('.githubusercontent.com')) throw new Error('raw_url inválida');
                    const r2 = await fetch(file.raw_url);
                    contenido = await r2.text();
                }

                const remoto = S.safeParse(contenido);
                if (!remoto || typeof remoto !== 'object') throw new Error('Formato inválido');

                let esValida = true;
                if (remoto.hash) {
                    esValida = await S.verificarFirma(remoto);
                }

                const procesarBajada = () => {
                    _setBusy(true);

                    const dataStringAntes = JSON.stringify(_data);
                    const tiposStringAntes = JSON.stringify(S.TIPOS);
                    const edifStringAntes = JSON.stringify(S.edificios);

                    const backupData = S.deepClone(_data);
                    const backupTipos = S.deepClone(S.TIPOS);
                    const backupEdif = [...S.edificios];

                    const resMerge = _combinarDatosRemotos(remoto);

                    const dataStringDespues = JSON.stringify(_data);
                    const tiposStringDespues = JSON.stringify(S.TIPOS);
                    const edifStringDespues = JSON.stringify(S.edificios);

                    const huboCambios = (dataStringAntes !== dataStringDespues || tiposStringAntes !== tiposStringDespues || edifStringAntes !== edifStringDespues);

                    _data = backupData;
                    Object.keys(S.TIPOS).forEach(k => delete S.TIPOS[k]);
                    Object.assign(S.TIPOS, backupTipos);
                    S.edificios.length = 0;
                    S.edificios.push(...backupEdif);

                    if (!huboCambios) {
                        _cfg.token = token; _cfg.gistId = gistId; _cfg.lastSync = new Date().toISOString();
                        _guardarCfg(); _setStatusSync();
                        toast('Sin cambios para combinar', 'info');
                        _setBusy(false);
                        return;
                    }

                    historial.empujar(esValida ? 'Bajar desde Gist' : 'Bajar desde Gist (Forzado)');
                    _combinarDatosRemotos(remoto);

                    guardar();
                    render();
                    _cfg.token = token; _cfg.gistId = gistId; _cfg.lastSync = new Date().toISOString();
                    _guardarCfg(); _setStatusSync();

                    const msgs = [];
                    if (resMerge.cDispsAdd) msgs.push(`+${resMerge.cDispsAdd} disp`);
                    if (resMerge.cDispsUpd) msgs.push(`~${resMerge.cDispsUpd} disp`);
                    if (resMerge.cGrabsAdd) msgs.push(`+${resMerge.cGrabsAdd} grab`);
                    if (resMerge.cGrabsUpd) msgs.push(`~${resMerge.cGrabsUpd} grab`);
                    if (resMerge.cTipos) msgs.push(`+${resMerge.cTipos} tipos`);
                    if (resMerge.cEdif) msgs.push(`+${resMerge.cEdif} edif`);

                    toast(esValida ? `Datos combinados (${msgs.join(', ')})` : `Datos alterados combinados (${msgs.join(', ')})`, esValida ? 'success' : 'info');
                    _setBusy(false);
                };

                if (!esValida) {
                    _setBusy(false);
                    confirmarModal('Los datos en GitHub han sido modificados manualmente. ¿Querés combinarlos de todos modos?', 'Combinar').then(ok => {
                        if (ok) procesarBajada();
                    });
                } else {
                    procesarBajada();
                }

            } catch (err) {
                _setStatus(`Error: ${err.message}`);
                toast(`Error al bajar: ${err.message}`, 'error');
                _setBusy(false);
            }
        }

        function poblarModal() {
            _cargarCfg();
            const tokenEl = document.getElementById('gist-token');
            const idEl = document.getElementById('gist-id');
            const eyeIcon = document.getElementById('gist-eye-icon');
            if (tokenEl) { tokenEl.value = _cfg.token || ''; tokenEl.type = 'password'; }
            if (idEl) idEl.value = _cfg.gistId || '';
            if (eyeIcon) eyeIcon.setAttribute('href', '#icon-eye');
            _actualizarLinkBtn();
            _actualizarToggleUI();
            if (_cfg.lastSync) _setStatusSync(); else _setStatus('');

            const scopeWarn = document.getElementById('gist-scope-warning');
            if (scopeWarn) scopeWarn.style.display = 'none';
            if (_cfg.token) {
                _validarScopeToken(_cfg.token).then(r => {
                    if (!r.ok || !scopeWarn) return;
                    if (r.peligrosos && r.peligrosos.length > 0) {
                        scopeWarn.style.display = '';
                        scopeWarn.innerHTML = `⚠️ <strong>Permisos excesivos detectados:</strong> Este token tiene los scopes <code>${r.peligrosos.join(', ')}</code> además de <code>gist</code>. Recomendamos crear un token nuevo con solo el scope <code>gist</code>.`;
                    }
                });
            }
        }

        function init() {
            _cargarCfg();
            const idEl = document.getElementById('gist-id');
            if (idEl) idEl.addEventListener('input', _actualizarLinkBtn);
            _actualizarBotonesAjustes();
        }

        async function verificarAlAbrir() {
            if (!_cfg.auto || !_cfg.token || !_cfg.gistId) return;

            _spinStart();
            try {
                const res = await fetch(`https://api.github.com/gists/${_cfg.gistId}`, {
                    headers: { Authorization: `token ${_cfg.token}` },
                });
                if (!res.ok) return;

                const data = await res.json();
                const file = data.files?.[FILENAME];
                if (!file) return;

                let contenido = file.content;
                if (file.truncated) {
                    const rawOrigin = new URL(file.raw_url).hostname;
                    if (!rawOrigin.endsWith('.githubusercontent.com')) return;
                    const r2 = await fetch(file.raw_url);
                    contenido = await r2.text();
                }

                const remoto = S.safeParse(contenido);
                if (!remoto) return;

                let esValida = true;
                if (remoto.hash) {
                    esValida = await S.verificarFirma(remoto);
                }

                const dataStringAntes = JSON.stringify(_data);
                const tiposStringAntes = JSON.stringify(S.TIPOS);
                const edifStringAntes = JSON.stringify(S.edificios);

                const backupData = S.deepClone(_data);
                const backupTipos = S.deepClone(S.TIPOS);
                const backupEdif = [...S.edificios];

                const resMerge = _combinarDatosRemotos(remoto);

                const dataStringDespues = JSON.stringify(_data);
                const tiposStringDespues = JSON.stringify(S.TIPOS);
                const edifStringDespues = JSON.stringify(S.edificios);

                const huboCambios = (dataStringAntes !== dataStringDespues || tiposStringAntes !== tiposStringDespues || edifStringAntes !== edifStringDespues);

                _data = backupData;
                Object.keys(S.TIPOS).forEach(k => delete S.TIPOS[k]);
                Object.assign(S.TIPOS, backupTipos);
                S.edificios.length = 0;
                S.edificios.push(...backupEdif);

                if (!huboCambios) return;

                const desc = document.querySelector('.gist-novedades-desc');
                if (desc) {
                    desc.innerHTML = esValida
                        ? 'Se encontraron mejoras o registros en GitHub que no están en este dispositivo:'
                        : 'Se encontraron registros en GitHub.<br><strong class="gist-warn-altered">⚠️ Atención: Los datos fueron alterados manualmente.</strong>';
                }

                const detalle = document.getElementById('gist-novedades-detalle');
                if (detalle) {
                    const chips = [];
                    if (resMerge.cDispsAdd) chips.push(`<div class="gist-novedades-chip"><span class="gist-novedades-chip-label">Dispositivos nuevos</span><span class="gist-novedades-chip-count">+${resMerge.cDispsAdd}</span></div>`);
                    if (resMerge.cDispsUpd) chips.push(`<div class="gist-novedades-chip"><span class="gist-novedades-chip-label">Dispositivos a enriquecer</span><span class="gist-novedades-chip-count gist-novedades-chip-count--purple">~${resMerge.cDispsUpd}</span></div>`);
                    if (resMerge.cGrabsAdd) chips.push(`<div class="gist-novedades-chip"><span class="gist-novedades-chip-label">Grabadores nuevos</span><span class="gist-novedades-chip-count">+${resMerge.cGrabsAdd}</span></div>`);
                    if (resMerge.cGrabsUpd) chips.push(`<div class="gist-novedades-chip"><span class="gist-novedades-chip-label">Grabadores a enriquecer</span><span class="gist-novedades-chip-count gist-novedades-chip-count--purple">~${resMerge.cGrabsUpd}</span></div>`);
                    if (resMerge.cOtrosAdd) chips.push(`<div class="gist-novedades-chip"><span class="gist-novedades-chip-label">Otros disp. nuevos</span><span class="gist-novedades-chip-count">+${resMerge.cOtrosAdd}</span></div>`);
                    if (resMerge.cOtrosUpd) chips.push(`<div class="gist-novedades-chip"><span class="gist-novedades-chip-label">Otros a enriquecer</span><span class="gist-novedades-chip-count gist-novedades-chip-count--purple">~${resMerge.cOtrosUpd}</span></div>`);
                    if (resMerge.cTipos) chips.push(`<div class="gist-novedades-chip"><span class="gist-novedades-chip-label">Tipos Custom</span><span class="gist-novedades-chip-count">+${resMerge.cTipos}</span></div>`);
                    if (resMerge.cEdif) chips.push(`<div class="gist-novedades-chip"><span class="gist-novedades-chip-label">Edificios</span><span class="gist-novedades-chip-count">+${resMerge.cEdif}</span></div>`);
                    detalle.innerHTML = chips.join('');
                }

                const btnOk = document.getElementById('gist-novedades-ok');
                if (btnOk) {
                    btnOk.onclick = () => {
                        historial.empujar(esValida ? 'Bajar novedades desde Gist' : 'Bajar novedades desde Gist (Forzado)');
                        _combinarDatosRemotos(remoto);
                        guardar();
                        render();
                        MM.cerrar('modal-gist-novedades');
                        const msgs = [];
                        if (resMerge.cDispsAdd) msgs.push(`+${resMerge.cDispsAdd} disp`);
                        if (resMerge.cDispsUpd) msgs.push(`~${resMerge.cDispsUpd} disp`);
                        if (resMerge.cGrabsAdd) msgs.push(`+${resMerge.cGrabsAdd} grab`);
                        if (resMerge.cGrabsUpd) msgs.push(`~${resMerge.cGrabsUpd} grab`);
                        if (resMerge.cOtrosAdd) msgs.push(`+${resMerge.cOtrosAdd} otros`);
                        if (resMerge.cOtrosUpd) msgs.push(`~${resMerge.cOtrosUpd} otros`);
                        if (resMerge.cTipos) msgs.push(`+${resMerge.cTipos} tipos`);
                        if (resMerge.cEdif) msgs.push(`+${resMerge.cEdif} edif`);
                        toast(esValida ? `Datos combinados (${msgs.join(', ')})` : `Datos alterados combinados (${msgs.join(', ')})`, esValida ? 'success' : 'info');
                    };
                }

                setTimeout(() => MM.abrir('modal-gist-novedades'), 600);

            } catch (_) {
            } finally {
                _spinStop();
            }
        }

        return { subir, bajar, subirAuto, verificarAlAbrir, toggleToken, toggleAuto, guardarConfig, poblarModal, init, actualizarBotonesAjustes: _actualizarBotonesAjustes, _generarPayload, _combinarEntidades };
    })();


    // ════════════════════════════════════════════════════════════════════════════
    // § RENDER — funciones de renderizado (dashboard, activos, producción)
    // ════════════════════════════════════════════════════════════════════════════
    let _filtrosPrevios = null;
    let _estadoColapsadoPrevio = null;
    let _estadoPisosPrevio = null;

    function _calcIdsEnProd() {
        const { grabadores: grabs, otros_prod: otros = [] } = _data;
        return new Set([
            ...grabs.flatMap(g => g.canales_data.filter(c => c.dispositivoId).map(c => c.dispositivoId)),
            ...grabs.filter(g => g.dispositivoId).map(g => g.dispositivoId),
            ...otros.filter(o => o.dispositivoId).map(o => o.dispositivoId),
        ]);
    }

    function render() {
        renderDashboard();
        renderActivos();
        renderProduccion();
    }

    // ── Estado del dashboard ──────────────────────────────────────────────────
    const _dash = {
        tipoAbierto: null,
        tipoAbiertoPrevio: null,
        estadoAbierto: null,
        estadoAbiertoPrevio: null,
        camarasVista: 'edificio',
    };

    function _setCamarasVista(vista) {
        if (_dash.camarasVista === vista) return;
        _dash.camarasVista = vista;

        const disps = _data.dispositivos;
        const grabs = _data.grabadores;
        const idsEnProd = _calcIdsEnProd();

        _renderResumenCamaras(disps, grabs, idsEnProd);
    };

    // ── Estado de la vista activos ────────────────────────────────────────────
    let _activosRecordarEstado = (() => {
        try { return localStorage.getItem(LS.ACTIVOS_RECORDAR) === 'true'; } catch { return false; }
    })();
    const _activos = {
        orden: (() => {
            try {
                let v = localStorage.getItem(LS.ACTIVOS_ORDEN);
                if (v === 'tipo') v = 'forma';
                return ['estado', 'forma', 'marca', 'edificio-piso'].includes(v) ? v : 'forma';
            } catch { return 'forma'; }
        })(),
        collapsed: (() => {
            if (_activosRecordarEstado) {
                try {
                    const saved = JSON.parse(localStorage.getItem(LS.ACTIVOS_COLLAPSED));
                    if (Array.isArray(saved)) return new Set(saved);
                } catch { }
            }
            return new Set();
        })(),
        pisosCollapsed: (() => {
            if (_activosRecordarEstado) {
                try {
                    const saved = JSON.parse(localStorage.getItem(LS.PISOS_COLLAPSED));
                    if (Array.isArray(saved)) return new Set(saved);
                } catch { }
            }
            return new Set();
        })(),
    };

    // (UI state props se añaden directamente al objeto UI abajo)

    function _guardarColapsados() {
        if (_activosRecordarEstado) {
            try {
                localStorage.setItem(LS.ACTIVOS_COLLAPSED, JSON.stringify([..._activos.collapsed]));
                localStorage.setItem(LS.PISOS_COLLAPSED, JSON.stringify([..._activos.pisosCollapsed]));
            } catch { }
        }
    };

    function _togglePisoActivos(floorKey) {
        const col = _activos.pisosCollapsed;
        const floorContainer = document.querySelector(`.sub-grupo-piso[data-floor-key="${CSS.escape(floorKey)}"]`);
        if (!floorContainer) return;

        const grid = floorContainer.querySelector('.activos-grid-transition');
        const chevron = floorContainer.querySelector('.nvr-chevron');

        if (col.has(floorKey)) {
            col.delete(floorKey);
            grid.classList.remove('collapsed');
            if (chevron) chevron.style.transform = '';
            grid.style.maxHeight = grid.scrollHeight + 'px';
            grid.addEventListener('transitionend', () => grid.style.maxHeight = '', { once: true });
        } else {
            col.add(floorKey);
            grid.style.maxHeight = grid.scrollHeight + 'px';
            grid.getBoundingClientRect();
            grid.classList.add('collapsed');
            if (chevron) chevron.style.transform = 'rotate(-90deg)';
            grid.style.maxHeight = '';
        }
        if (_guardarColapsados) _guardarColapsados();
    };

    function _estadosDeDisps(dispsDelTipo, idsEnProd) {
        const res = { produccion: 0, disponible: 0, averiado: 0, revisar: 0, desafectado: 0 };
        dispsDelTipo.forEach(d => {
            if (d.estado === 'averiado') res.averiado++;
            else if (d.estado === 'revisar') res.revisar++;
            else if (d.estado === 'desafectado') res.desafectado++;
            else if (idsEnProd.has(d.id)) res.produccion++;
            else res.disponible++;
        });
        return res;
    }

    function _toggleTipoDetalle(tipoKey) {
        if (_dash.tipoAbierto !== tipoKey) _dash.estadoAbierto = null;
        _dash.tipoAbierto = _dash.tipoAbierto === tipoKey ? null : tipoKey;

        const disps = _data.dispositivos;
        const grabs = _data.grabadores;
        const idsEnProd = _calcIdsEnProd();
        _renderResumenGeneral(disps, idsEnProd);
    };

    function _toggleEstadoDetalle(estadoKey) {
        if (_dash.tipoAbierto !== 'camara') return;

        _dash.estadoAbierto = _dash.estadoAbierto === estadoKey ? null : estadoKey;

        const disps = _data.dispositivos;
        const grabs = _data.grabadores;
        const idsEnProd = _calcIdsEnProd();
        _renderResumenGeneral(disps, idsEnProd);
    };

    function _inyectarStaggerChips() {
        if (document.getElementById('stagger-chips-css')) return;
        const A = '.dash-slide-wrap.en-detalle .dash-slide-panel:last-child';
        const B = '.dash-slide-wrap:not(.en-detalle) .dash-slide-panel:first-child';
        let css = '';
        for (let i = 1; i <= 20; i++) {
            css += `${A} .stat-chip:nth-child(${i}){transition-delay:${(i * 0.04).toFixed(2)}s}`;
            css += `${B} .stat-chip:nth-child(${i}){transition-delay:${(0.04 + (i - 1) * 0.03).toFixed(2)}s}`;
        }
        const el = document.createElement('style');
        el.id = 'stagger-chips-css';
        el.textContent = css;
        document.head.appendChild(el);
    }

    function _renderResumenGeneral(disps, idsEnProd) {
        const tiposConDisps = new Set(disps.map(d => d.tipo));
        const tiposBuitin = Object.keys(S.TIPOS_BUILTIN);
        const tiposCustom = Object.keys(S.TIPOS).filter(k => !S.TIPOS_BUILTIN[k] && tiposConDisps.has(k)).sort();
        const tiposOrden = [...tiposBuitin, ...tiposCustom];


        const depth = (!_dash.tipoAbierto) ? 0 : (!_dash.estadoAbierto ? 1 : 2);

        const getTiposHtml = () => {
            const chipTotal = `
                    <div class="dash-chip-main">
                        <div class="stat-chip-valor">${disps.length}</div>
                        <div class="stat-chip-label">Dispositivos en total</div>
                    </div>`;

            const chipsTipo = tiposOrden.map(tipoKey => {
                const tc = S.TIPOS[tipoKey];
                if (!tc) return '';
                const n = disps.filter(d => d.tipo === tipoKey).length;
                return `
                        <div class="stat-chip stat-chip-tipo" data-action="toggle-tipo" data-tipo="${tipoKey}">
                            <div class="stat-chip-valor">${n}</div>
                            <div class="stat-chip-label">${tc.emoji} ${(tc.label + (tipoKey === 'camara' ? 's' : '')).toUpperCase()}</div>
                            <span class="stat-chip-arrow">▶</span>
                        </div>`;
            }).join('');

            return `
                    <div class="dash-resumen-grid">
                        <div class="dash-resumen-col-info">${chipTotal}</div>
                        <div class="dash-resumen-col-data"><div class="dashboard-grid">${chipsTipo}</div></div>
                    </div>`;
        };

        const getEstadosHtml = (tipoOverride) => {
            const tipo = tipoOverride || _dash.tipoAbierto;
            if (!tipo || !S.TIPOS[tipo]) return '';

            const tc = S.TIPOS[tipo];
            const dispsDelTipo = disps.filter(d => d.tipo === tipo);
            const est = _estadosDeDisps(dispsDelTipo, idsEnProd);

            const chipSeleccionado = `
                    <div class="dash-chip-main clickable" data-action="toggle-tipo" data-tipo="${tipo}">
                        <div class="stat-chip-valor">${dispsDelTipo.length}</div>
                        <div class="stat-chip-label">${tc.emoji} ${(tc.label + (tipo === 'camara' ? 's' : '')).toUpperCase()}</div>
                        <div class="dash-chip-btn-group">
                            <div class="stat-chip-volver dash-chip-btn">◀ VOLVER</div>
                        </div>
                    </div>`;

            const chipsEstado = ESTADOS_DEF.map(e => {
                const n = est[e.key];
                const esCamara = tipo === 'camara';
                const clickable = n > 0
                    ? `class="stat-chip stat-chip-tipo" data-action="toggle-estado-o-ir" data-tipo="${tipo}" data-estado="${e.key}" data-es-camara="${esCamara}"`
                    : `class="stat-chip" data-action="stop"`;
                return `
                        <div ${clickable}>
                            <div class="stat-chip-valor stat-chip-val--${e.key}">${n}</div>
                            <div class="stat-chip-label">${e.label}</div>
                            ${(esCamara && n > 0) ? '<span class="stat-chip-arrow">▶</span>' : ''}
                        </div>`;
            }).join('');

            return `
                    <div class="dash-resumen-grid">
                        <div class="dash-resumen-col-info">${chipSeleccionado}</div>
                        <div class="dash-resumen-col-data"><div class="dashboard-grid">${chipsEstado}</div></div>
                    </div>`;
        };

        const getFormasHtml = (estadoOverride) => {
            const estado = estadoOverride || _dash.estadoAbierto;
            if (!estado) return '';

            const camarasDelEstado = disps.filter(d => d.tipo === 'camara' && (d.estado || (idsEnProd.has(d.id) ? 'produccion' : 'disponible')) === estado);

            const conteo = {};
            camarasDelEstado.forEach(d => { const k = d.forma || '__sin__'; conteo[k] = (conteo[k] || 0) + 1; });

            const chipEstado = `
                    <div class="dash-chip-main clickable" data-action="toggle-estado" data-estado="${estado}">
                        <div class="stat-chip-valor stat-chip-val--${estado}">${camarasDelEstado.length}</div>
                        <div class="stat-chip-label stat-chip-val--${estado}">${(ESTADO_LABEL_PLURAL[estado] || estado).toUpperCase()}</div>
                        <div class="dash-chip-btn-group">
                            <div class="stat-chip-volver dash-chip-btn">◀ VOLVER</div>
                            <div class="stat-chip-volver dash-chip-btn" data-action="ir-activos" data-tipo="camara" data-estado="${estado}">VER TODOS ▶</div>
                        </div>
                    </div>`;

            const filas = FORMAS_DEF.filter(f => conteo[f.key] > 0);
            if (conteo['__sin__'] > 0) filas.push({ key: '', label: 'Sin forma' });

            const chipsForma = filas.map(f => `
                        <div class="stat-chip stat-chip-tipo" data-action="ir-activos" data-tipo="camara" data-estado="${estado}" data-forma="${f.key}">
                            <div class="stat-chip-valor">${conteo[f.key || '__sin__']}</div>
                            <div class="stat-chip-label">${f.label.toUpperCase()}</div>
                        </div>`).join('');

            return `
                    <div class="dash-resumen-grid">
                        <div class="dash-resumen-col-info">${chipEstado}</div>
                        <div class="dash-resumen-col-data"><div class="dashboard-grid">${chipsForma}</div></div>
                    </div>`;
        };

        let htmlIzq = '', htmlDer = '';
        let enDetalle = depth > 0;
        let isSlidingAtrasNivel2 = false;

        const saltandoNivel = (_dash.estadoAbiertoPrevio !== _dash.estadoAbierto && _dash.tipoAbierto && _dash.tipoAbiertoPrevio === _dash.tipoAbierto);
        const saltandoAdelante = saltandoNivel && _dash.estadoAbierto !== null;
        const saltandoAtras = saltandoNivel && _dash.estadoAbierto === null;

        if (depth === 0) {
            htmlIzq = getTiposHtml();
            htmlDer = getEstadosHtml(_dash.tipoAbiertoPrevio);
        }
        else if (depth === 1) {
            htmlIzq = getTiposHtml();
            htmlDer = getEstadosHtml();

            if (saltandoAtras) {

                htmlIzq = getEstadosHtml();
                htmlDer = getFormasHtml(_dash.estadoAbiertoPrevio);
                enDetalle = false;
                isSlidingAtrasNivel2 = true;
            }
        }
        else if (depth === 2) {
            htmlIzq = getEstadosHtml();
            htmlDer = getFormasHtml();
        }

        const contenedor = document.getElementById('dash-disp-tree');
        let wrap = contenedor.querySelector('.dash-slide-wrap');
        if (!wrap) {
            contenedor.innerHTML = `
                        <div class="dash-slide-wrap">
                            <div class="dash-slide-panel" id="dash-panel-izq"></div>
                            <div class="dash-slide-panel" id="dash-panel-der"></div>
                        </div>`;
            wrap = contenedor.querySelector('.dash-slide-wrap');
        }

        const panelIzq = wrap.querySelector('#dash-panel-izq');
        const panelDer = wrap.querySelector('#dash-panel-der');

        const alturaActual = contenedor.offsetHeight;
        const esPrimeraCarga = alturaActual === 0;

        if (_dash.tipoAbiertoPrevio === _dash.tipoAbierto && _dash.estadoAbiertoPrevio === _dash.estadoAbierto && !esPrimeraCarga) {
            panelIzq.innerHTML = htmlIzq;
            panelDer.innerHTML = htmlDer;
            return;
        }

        if (saltandoAdelante && !esPrimeraCarga) {
            wrap.style.transition = 'none';
            wrap.classList.remove('en-detalle');
            panelIzq.innerHTML = getEstadosHtml();
            void wrap.offsetWidth;
            wrap.style.transition = '';
        }

        _dash.tipoAbiertoPrevio = _dash.tipoAbierto;
        _dash.estadoAbiertoPrevio = _dash.estadoAbierto;

        if (!esPrimeraCarga) {
            contenedor.style.transition = 'none';
            contenedor.style.height = alturaActual + 'px';
        }

        panelIzq.style.height = '';
        panelIzq.style.overflow = '';
        panelDer.style.height = '';
        panelDer.style.overflow = '';

        panelIzq.innerHTML = htmlIzq;
        panelDer.innerHTML = htmlDer;

        void contenedor.offsetHeight;

        const panelActivo = enDetalle ? panelDer : panelIzq;
        const alturaObjetivo = panelActivo.offsetHeight;

        if (esPrimeraCarga) {
            wrap.classList.toggle('en-detalle', enDetalle);
            if (enDetalle) {
                panelIzq.style.height = '0px';
                panelIzq.style.overflow = 'hidden';
            } else {
                panelDer.style.height = '0px';
                panelDer.style.overflow = 'hidden';
            }
        } else {
            requestAnimationFrame(() => {
                contenedor.style.transition = 'height 0.35s cubic-bezier(0.4, 0, 0.2, 1)';
                wrap.classList.toggle('en-detalle', enDetalle);
                if (alturaObjetivo > 0) contenedor.style.height = alturaObjetivo + 'px';

                setTimeout(() => {
                    if (contenedor.style.height === alturaObjetivo + 'px') {
                        contenedor.style.height = '';
                        contenedor.style.transition = '';

                        if (isSlidingAtrasNivel2) {

                            wrap.style.transition = 'none';
                            panelIzq.innerHTML = getTiposHtml();
                            panelDer.innerHTML = getEstadosHtml();
                            wrap.classList.add('en-detalle');
                            void wrap.offsetWidth;
                            wrap.style.transition = '';

                            panelIzq.style.height = '0px';
                            panelIzq.style.overflow = 'hidden';
                            panelDer.style.height = '';
                            panelDer.style.overflow = '';
                        } else {
                            if (enDetalle) {
                                panelIzq.style.height = '0px';
                                panelIzq.style.overflow = 'hidden';
                            } else {
                                panelDer.style.height = '0px';
                                panelDer.style.overflow = 'hidden';
                            }
                        }
                    }
                }, 360);
            });
        }
    }

    function _renderResumenGrabadores(grabs) {
        const dashGrabadores = document.getElementById('dash-grabadores');
        if (grabs.length === 0) {
            dashGrabadores.innerHTML = `<div class="dash-empty-text">Sin grabadores en producción</div>`;
            return;
        }

        let totalCanales = 0, totalOcupados = 0;
        grabs.forEach(g => {
            totalCanales += g.canales_n;
            totalOcupados += g.canales_data.filter(c => c.dispositivoId).length;
        });
        const totalLibres = totalCanales - totalOcupados;
        const pctOcupado = totalCanales > 0 ? Math.round((totalOcupados / totalCanales) * 100) : 0;
        const pctLibre = totalCanales > 0 ? (100 - pctOcupado) : 0;

        const htmlTotales = `
                <div class="dash-grab-totales">
                    <div class="dash-grab-totales-title">Canales de grabación</div>
                    <div class="dash-grab-grid">
                        <div class="dash-grab-col">
                            <div class="dash-grab-label">Capacidad Instalada</div>
                            <div class="dash-grab-val">${totalCanales}</div>
                        </div>
                        <div class="dash-grab-col--mid">
                            <div class="dash-grab-label">Utilizados</div>
                            <div class="dash-grab-val dash-grab-val--blue">${totalOcupados} <span class="dash-grab-val-sub">(${pctOcupado}%)</span></div>
                        </div>
                        <div class="dash-grab-col">
                            <div class="dash-grab-label">Disponibles</div>
                            <div class="dash-grab-val dash-grab-val--green">${totalLibres} <span class="dash-grab-val-sub">(${pctLibre}%)</span></div>
                        </div>
                    </div>
                </div>`;

        const grabDatos = grabs.map(g => {
            const ocup = g.canales_data.filter(c => c.dispositivoId).length;
            const libre = g.canales_n - ocup;
            const pct = Math.round((ocup / g.canales_n) * 100);
            let colorBarra = 'var(--c-red)';
            if (pct <= 35) colorBarra = 'var(--c-green)';
            else if (pct <= 65) colorBarra = 'var(--c-blue)';
            else if (pct <= 85) colorBarra = 'var(--c-orange)';
            return { g, ocup, libre, pct, colorBarra };
        });

        const htmlLista = grabDatos.map(({ g, ocup, libre, pct, colorBarra }) => {
            return `<div class="dash-grab-row">
                    <div class="dash-grab-row-header">
                        <span class="dash-grab-row-nombre">${esc(g.descripcion)}</span>                        
                        ${g.ip ? `<span class="dash-grab-row-ip ip-copiable" data-copy="${esc(g.ip)}" title="Copiar IP">${esc(g.ip)}</span>` : `<span class="dash-grab-row-ip"></span>`}
                    </div>
                    <div class="dash-grab-row-stats">
                        <span>${ocup}/${g.canales_n} ocupados · ${libre} libres</span>
                        <span class="dash-grab-row-pct" data-pct-target="${pct}">0%</span>
                    </div>
                    <div class="dash-grab-barra">
                        <div class="dash-grab-barra-fill" style="width:0%;background:${colorBarra}" data-pct-target="${pct}"></div>
                    </div>
                </div>`;
        }).join('');

        dashGrabadores.innerHTML = htmlTotales + htmlLista;

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {

                dashGrabadores.querySelectorAll('.dash-grab-barra-fill').forEach(fill => {
                    const target = parseInt(fill.dataset.pctTarget, 10) || 0;
                    fill.style.width = target + '%';
                });

                dashGrabadores.querySelectorAll('.dash-grab-row-pct').forEach(span => {
                    const target = parseInt(span.dataset.pctTarget, 10) || 0;
                    if (target === 0) { span.textContent = '0%'; return; }
                    const duration = 900;
                    const start = performance.now();
                    function tick(now) {
                        const elapsed = now - start;
                        const progress = Math.min(elapsed / duration, 1);
                        const eased = 1 - Math.pow(1 - progress, 3);
                        span.textContent = Math.round(eased * target) + '%';
                        if (progress < 1) requestAnimationFrame(tick);
                    }
                    requestAnimationFrame(tick);
                });
            });
        });
    }

    function _toggleEdificio(rowEl) {
        const container = document.getElementById('dash-camaras');
        const wrapper = rowEl.parentNode;
        const pisos = wrapper.querySelector('.dash-edif-pisos');
        const yaAbierto = pisos.classList.contains('dash-edif-pisos--open');

        container.querySelectorAll('.dash-edif-pisos--open').forEach(p => {
            p.classList.remove('dash-edif-pisos--open');
        });
        container.querySelectorAll('.dash-edif-row--open').forEach(r => {
            r.classList.remove('dash-edif-row--open');
            r.style.borderBottom = '';
        });

        if (!yaAbierto) {
            pisos.classList.add('dash-edif-pisos--open');
            rowEl.classList.add('dash-edif-row--open');
            rowEl.style.borderBottom = 'none';
        }
    }

    function _renderResumenCamaras(disps, grabs, idsEnProd) {
        const camarasDisps = disps.filter(d => d.tipo === 'camara');
        const enProd = camarasDisps.filter(d => idsEnProd.has(d.id)).length;

        ['forma', 'edificio', 'modelo'].forEach(v => {
            const btn = document.getElementById(`mini-tab-${v}`);
            if (btn) btn.classList.toggle('activa', _dash.camarasVista === v);
        });

        let vistaHtml = '';

        if (_dash.camarasVista === 'forma' || _dash.camarasVista === 'modelo') {
            const campoAgrupar = _dash.camarasVista === 'forma' ? 'forma' : 'modelo';

            const conteo = {};
            camarasDisps.forEach(d => {
                const valor = d[campoAgrupar] || '';
                const k = valor.trim() || '__sin_valor__';
                if (!conteo[k]) conteo[k] = { total: 0, prod: 0, averiado: 0, revisar: 0, desafectado: 0 };
                conteo[k].total++;
                if (d.estado === 'averiado') conteo[k].averiado++;
                else if (d.estado === 'revisar') conteo[k].revisar++;
                else if (d.estado === 'desafectado') conteo[k].desafectado++;
                else if (idsEnProd.has(d.id)) conteo[k].prod++;
            });

            let filasRaw = [];
            if (_dash.camarasVista === 'forma') {
                filasRaw = FORMAS_DEF.map(f => ({ label: f.label, ...(conteo[f.key] || { total: 0, prod: 0, averiado: 0, revisar: 0, desafectado: 0 }) }))
                    .filter(f => f.total > 0)
                    .sort((a, b) => a.label.localeCompare(b.label));
                if (conteo['__sin_valor__']?.total > 0) filasRaw.push({ label: 'Sin forma', ...conteo['__sin_valor__'] });
            } else {

                filasRaw = Object.entries(conteo)
                    .map(([k, v]) => ({ label: k === '__sin_valor__' ? 'Sin modelo' : k, ...v }))
                    .sort((a, b) => a.label.localeCompare(b.label));
            }

            if (filasRaw.length === 0) {
                vistaHtml = `<div class="dash-empty-text anim-in">Sin cámaras registradas</div>`;
            } else {
                const col = (txt, color) => `<span class="dash-cam-label-small" style="color:${color}">${txt}</span>`;
                const val = (n, color) => `<span class="dash-cam-val" style="color:${color}">${n}</span>`;
                const header = `
                        <div class="dash-cam-header dash-cam-header--border anim-in">
                            <span class="dash-cam-row-label"></span>
                            ${col('TOTAL', 'var(--text-disabled)')}
                            ${col('PROD.', 'var(--c-blue)')}
                            ${col('DISP.', 'var(--c-green)')}
                            ${col('AVER.', 'var(--c-red)')}
                            ${col('REVIS.', 'var(--c-purple)')}
                            ${col('DESAF.', 'var(--text-muted)')}
                        </div>`;
                const esModoModelo = _dash.camarasVista === 'modelo';
                const rows = filasRaw.map((f, i) => {
                    const esCopiable = esModoModelo && f.label !== 'Sin modelo';
                    const labelSpan = esCopiable
                        ? `<span class="dash-cam-row-label text-truncate ip-copiable" data-copy="${esc(f.label)}" title="Copiar modelo">${esc(f.label)}</span>`
                        : `<span class="dash-cam-row-label text-truncate" title="${esc(f.label)}">${esc(f.label)}</span>`;
                    return `
                        <div class="dash-cam-row anim-in${i < filasRaw.length - 1 ? ' dash-cam-row--border' : ''}" style="animation-delay: ${(i + 1) * 0.03}s; animation-fill-mode: both;">
                            ${labelSpan}
                            ${val(f.total, 'var(--text-main)')}
                            ${val(f.prod, 'var(--c-blue)')}
                            ${val(f.total - f.prod - f.averiado - f.revisar - f.desafectado, 'var(--c-green)')}
                            ${val(f.averiado, 'var(--c-red)')}
                            ${val(f.revisar, 'var(--c-purple)')}
                            ${val(f.desafectado, 'var(--text-muted)')}
                        </div>`;
                }).join('');
                vistaHtml = header + rows;
            }
        }

        else {

            const conteoEdificio = {};
            grabs.forEach(g => {
                g.canales_data.forEach(c => {
                    if (!c.dispositivoId) return;
                    const disp = camarasDisps.find(d => d.id === c.dispositivoId);
                    if (!disp) return;
                    const edif = c.edificio?.trim() || '__sin_edificio__';
                    const piso = S.normalizarPiso(c.piso) || '__sin_piso__';
                    if (!conteoEdificio[edif]) conteoEdificio[edif] = { ids: new Set(), pisos: {} };
                    conteoEdificio[edif].ids.add(c.dispositivoId);
                    if (!conteoEdificio[edif].pisos[piso]) conteoEdificio[edif].pisos[piso] = { ids: new Set() };
                    if (!conteoEdificio[edif].pisos[piso].ids.has(c.dispositivoId)) {
                        conteoEdificio[edif].pisos[piso].ids.add(c.dispositivoId);
                    }
                });
            });

            const filas = Object.entries(conteoEdificio)
                .filter(([k]) => k !== '__sin_edificio__')
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([label, v]) => ({ label, total: v.ids.size, pisos: v.pisos }));
            if (conteoEdificio['__sin_edificio__']) {
                const v = conteoEdificio['__sin_edificio__'];
                filas.push({ label: 'Sin edificio', total: v.ids.size, pisos: v.pisos });
            }

            if (filas.length === 0) {
                vistaHtml = enProd === 0
                    ? `<div class="dash-empty-text anim-in">Sin cámaras en producción</div>`
                    : `<div class="dash-empty-text anim-in">Ningún canal tiene edificio asignado</div>`;
            } else {
                const chevron = `<svg class="dash-edif-chevron" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>`;

                vistaHtml = filas.map((f, i) => {
                    const pisosOrdenados = Object.entries(f.pisos)
                        .sort((a, b) => {
                            if (a[0] === '__sin_piso__') return 1;
                            if (b[0] === '__sin_piso__') return -1;
                            return _getPisoPeso(a[0]) - _getPisoPeso(b[0]);
                        });
                    const pisosHtml = pisosOrdenados.map(([piso, pd]) => {
                        const label = piso === '__sin_piso__' ? 'Sin piso' : piso;
                        return `
                                <div class="dash-edif-piso-row">
                                    <div style="display:flex;align-items:center;justify-content:space-between;width:100%">
                                        <span class="dash-edif-piso-label">${esc(label)}</span>
                                        <span class="dash-cam-val" style="color:var(--c-orange);font-size:var(--fs-base)">${pd.ids.size}</span>
                                    </div>
                                </div>`;
                    }).join('');
                    return `
                            <div>
                                <div class="dash-edif-row anim-in" style="animation-delay:${i * 0.03}s;animation-fill-mode:both"
                                    data-action="toggle-edificio">
                                    <span class="dash-edif-label">${chevron}${esc(f.label)}</span>
                                    <span class="dash-cam-val" style="color:var(--text-main)">${f.total}</span>
                                </div>
                                <div class="dash-edif-pisos">
                                    ${pisosHtml}
                                </div>
                            </div>`;
                }).join('');
            }
        }

        document.getElementById('dash-camaras').innerHTML = `<div class="flex-col">${vistaHtml}</div>`;
    }

    function renderDashboard() {
        _inyectarStaggerChips();
        const disps = _data.dispositivos;
        const grabs = [..._data.grabadores].sort((a, b) => (a.descripcion || '').localeCompare(b.descripcion || ''));
        const idsEnProd = _calcIdsEnProd();
        _renderResumenGeneral(disps, idsEnProd);
        _renderResumenGrabadores(grabs);
        _renderResumenCamaras(disps, grabs, idsEnProd);
    }

    function _buildAsignaciones() {
        if (_cacheAsignaciones) return _cacheAsignaciones;
        const asignaciones = {};
        const pushAsig = (dispId, asig) => {
            (asignaciones[dispId] || (asignaciones[dispId] = [])).push(asig);
        };
        _data.grabadores.forEach(g => {
            if (g.dispositivoId) pushAsig(g.dispositivoId, { tipo: 'grabador', grab: g });
            g.canales_data.forEach(c => {
                if (c.dispositivoId) pushAsig(c.dispositivoId, { tipo: 'canal', grab: g, slot: c });
            });
        });
        (_data.otros_prod || []).forEach(o => {
            if (o.dispositivoId) pushAsig(o.dispositivoId, { tipo: 'otro_prod', item: o });
        });
        return (_cacheAsignaciones = asignaciones);
    }

    function _buildDupPatrimonios(disps) {
        if (_cacheDupPatrimonios) return _cacheDupPatrimonios;
        const counts = {};
        disps.forEach(d => {
            if (d.patrimonio) {
                const k = d.patrimonio.trim().toUpperCase();
                if (k) counts[k] = (counts[k] || 0) + 1;
            }
        });
        return (_cacheDupPatrimonios = new Set(Object.keys(counts).filter(k => counts[k] > 1)));
    }

    function _getPisoPeso(p) {
        if (p === 'SIN ASIGNAR') return 9999;
        const s = p.trim().toUpperCase();
        if (s.includes('SS')) return -(parseInt(s.replace(/\D/g, '')) || 1);
        if (s === 'PB') return 0;
        if (s.includes('EP')) return (parseInt(s.replace(/\D/g, '')) || 1) * 0.1;
        if (s === 'TERRAZA' || s === 'AZOTEA' || s === 'TZ') return 1000;
        const n = parseInt(s);
        return isNaN(n) ? 500 : n;
    }

    function _getGroupLabel(d, asignaciones) {
        if (_activos.orden === 'estado') {
            const est = getEstadoEfectivo(d, asignaciones);
            return ESTADO_LABEL_PLURAL[est] || est.toUpperCase();
        }
        if (_activos.orden === 'marca') return (d.marca || 'SIN MARCA').toUpperCase();
        if (_activos.orden === 'edificio-piso') {
            const asig = (asignaciones[d.id] || [])[0];
            if (!asig) return 'SIN ASIGNAR';
            const edif = asig.tipo === 'canal' ? asig.slot.edificio
                : asig.tipo === 'otro_prod' ? asig.item.edificio
                    : asig.grab.edificio;
            return (edif || 'SIN ASIGNAR').toUpperCase();
        }
        if (d.tipo === 'camara') return d.forma ? d.forma.replace(/-/g, ' ').toUpperCase() : 'CÁMARA (SIN FORMA)';
        return (S.TIPOS[d.tipo]?.label || d.tipo).toUpperCase();
    }

    function _getGroupSortKey(d, asignaciones) {
        const ORDEN_ESTADO = { produccion: 0, disponible: 1, revisar: 2, averiado: 3, desafectado: 4 };
        if (_activos.orden === 'estado') return ORDEN_ESTADO[getEstadoEfectivo(d, asignaciones)] ?? 9;
        if (_activos.orden === 'marca') return (d.marca || 'zzz').trim().toLowerCase();
        const label = _getGroupLabel(d, asignaciones);
        return (_activos.orden === 'edificio-piso' && label === 'SIN ASIGNAR') ? 'zzzzz' : label.toLowerCase();
    }

    function _renderAsignInfo(d, asignaciones, tieneMacDuplicada) {
        const asigs = asignaciones[d.id] || [];
        if (!asigs.length) return '';

        const isDup = tieneMacDuplicada(d);
        const badgeProdClass = isDup ? 'badge-estado-revisar' : 'badge-estado-produccion';
        const hoverTitle = isDup ? 'title="⚠️ MAC Duplicada en Producción"' : '';
        const ipCopiable = (ip) => `<div class="text-truncate ip-copiable" data-copy="${esc(ip)}" title="Copiar IP">${esc(ip)}</div>`;

        const bloques = asigs.map(asig => {
            if (asig.tipo === 'canal') return { linea: [esc(asig.grab.descripcion), `CANAL ${asig.slot.canal}`].join(' · '), desc: asig.slot.descripcion || 'EN PRODUCCIÓN', ip: asig.slot.ip || '' };
            if (asig.tipo === 'otro_prod') return { linea: '', desc: asig.item.descripcion || 'EN PRODUCCIÓN', ip: asig.item.ip || '' };
            return { linea: '', desc: asig.grab.descripcion || 'EN PRODUCCIÓN', ip: asig.grab.ip || '' };
        });

        if (bloques.length === 1) {
            const b = bloques[0];
            return (b.desc ? `<div class="text-truncate"><span class="badge ${badgeProdClass}" ${hoverTitle}>${esc(b.desc)}</span></div>` : '')
                + (b.linea ? `<div class="text-truncate">${b.linea}</div>` : '')
                + (b.ip ? ipCopiable(b.ip) : '');
        }

        const allDesc = bloques.map(b => b.desc);
        const allIp = bloques.map(b => b.ip);
        const descUnica = allDesc.every(v => v === allDesc[0]) ? allDesc[0] : null;
        const ipUnica = allIp.every(v => v === allIp[0]) ? allIp[0] : null;

        const descComunHtml = (descUnica) ? `<div class="text-truncate"><span class="badge ${badgeProdClass}" ${hoverTitle}>${esc(descUnica)}</span></div>` : '';
        const ipComunHtml = (ipUnica) ? ipCopiable(ipUnica) : '';
        const bloquesHtml = bloques.map(b => {
            const lineaH = b.linea ? `<div class="text-truncate">${b.linea}</div>` : '';
            const ipH = (!ipUnica && b.ip) ? ipCopiable(b.ip) : '';
            return (lineaH || ipH) ? `<div class="asig-bloque">${lineaH}${ipH}</div>` : '';
        }).filter(Boolean);

        return descComunHtml
            + (bloquesHtml.length ? `<div class="asig-multi">${bloquesHtml.join('<div class="asig-sep"></div>')}</div>` : '')
            + ipComunHtml;
    }

    function _renderItemActivo(d, asignaciones, tieneMacDuplicada, dupPatrimonios) {
        const ESTADO_BADGE = { averiado: ['Averiado', 'badge-estado-averiado'], revisar: ['A revisar', 'badge-estado-revisar'], desafectado: ['Desafectado', 'badge-estado-desafectado'], disponible: ['Disponible', 'badge-estado-disponible'] };
        const tc = S.TIPOS[d.tipo] || { emoji: '📦', label: d.tipo };
        const titulo = d.mac || d.serial || '—';
        const estadoEfectivo = getEstadoEfectivo(d, asignaciones);
        const tipoBadgeLabel = (d.tipo === 'camara' && d.forma ? d.forma.replace(/-/g, ' ') : tc.label).toUpperCase();

        const asignInfo = _renderAsignInfo(d, asignaciones, tieneMacDuplicada);
        const [estLabel, estClase] = ESTADO_BADGE[estadoEfectivo] || [];
        const estadoBadgeHtml = estLabel ? `<span class="badge ${estClase} text-truncate">${estLabel}</span>` : '';
        const derechaHtml = estadoBadgeHtml || asignInfo ? `<div class="activo-info-derecha">${estadoBadgeHtml}${asignInfo}</div>` : '';

        const linea3Parts = [
            (d.serial && d.mac) ? `S/N: ${esc(d.serial)}` : '',
            d.patrimonio ? `<span class="${dupPatrimonios.has(d.patrimonio.trim().toUpperCase()) ? 'pat-dup' : ''}">PAT: ${esc(d.patrimonio)}</span>` : ''
        ].filter(Boolean);

        return `<div class="dispositivo-item tipo-${esc(d.tipo)} estado-${estadoEfectivo} anim-in" data-disp-id="${esc(d.id)}">
                    <div class="dispositivo-info">
                        <div class="dispositivo-nombre">${tc.emoji} ${tipoBadgeLabel}<span class="sep-muted">-</span>${esc(titulo)} </div>
                        <div class="dispositivo-meta">${d.modelo ? `<span>${esc(d.modelo)}</span>` : ''}</div>
                        ${linea3Parts.length ? `<div class="disp-linea3">${linea3Parts.join(' · ')}</div>` : ''}
                    </div>${derechaHtml}</div>`;
    }

    function _renderSubgruposPiso(items, gLabel, asignaciones, colClass, renderItem) {
        const pisos = {};
        items.forEach(d => {
            const asig = (asignaciones[d.id] || [])[0];
            let p = 'SIN ASIGNAR';
            if (asig) p = (asig.tipo === 'canal' ? asig.slot.piso : asig.tipo === 'otro_prod' ? asig.item.piso : asig.grab.piso) || 'SIN ASIGNAR';
            p = S.normalizarPiso(p) || 'SIN ASIGNAR';
            (pisos[p] || (pisos[p] = [])).push(d);
        });

        const sortedPisos = Object.keys(pisos).sort((a, b) => {
            const diff = _getPisoPeso(a) - _getPisoPeso(b);
            return diff !== 0 ? diff : a.localeCompare(b, undefined, { numeric: true });
        });

        return sortedPisos.map(p => {
            const floorKey = `${gLabel}|${p}`;
            const isFloorCollapsed = _activos.pisosCollapsed.has(floorKey);
            return `<div class="sub-grupo-piso" data-floor-key="${esc(floorKey)}" style="margin-bottom: 0.5rem;">
                        <div class="grupo-piso-header" data-toggle-piso="${esc(floorKey)}" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;padding:0.4rem 0.5rem;border-radius:var(--radius-sm);margin-bottom:0.25rem;">
                            <span class="section-label" style="margin:0;opacity:0.8;font-size:0.7rem;border-left:2px solid var(--c-orange);padding-left:0.5rem;">
                                PISO: ${esc(p)} <span style="font-weight:normal;margin-left:0.3rem;">(${pisos[p].length})</span>
                            </span>
                            <svg class="nvr-chevron" style="${isFloorCollapsed ? 'transform:rotate(-90deg);' : ''}width:14px;height:14px;stroke:var(--text-muted);" viewBox="0 0 24 24"><use href="#icon-chevron-down"/></svg>
                        </div>
                        <div class="activos-grid-transition ${colClass}${isFloorCollapsed ? ' collapsed' : ''}">
                            ${pisos[p].map(renderItem).join('')}
                        </div>
                    </div>`;
        }).join('');
    }

    function _toggleGrupoActivos(groupId) {
        const col = _activos.collapsed;
        const card = document.querySelector(`.grupo-activos-card[data-grupo="${CSS.escape(groupId)}"]`);
        if (!card) return;
        const grid = card.querySelector('.activos-grid-transition');
        const chevron = card.querySelector('.nvr-chevron');
        if (col.has(groupId)) {
            col.delete(groupId);
            grid.classList.remove('collapsed');
            chevron.style.transform = '';
            grid.style.maxHeight = grid.scrollHeight + 'px';
            grid.addEventListener('transitionend', () => grid.style.maxHeight = '', { once: true });
        } else {
            col.add(groupId);
            grid.style.maxHeight = grid.scrollHeight + 'px';
            grid.getBoundingClientRect();
            grid.classList.add('collapsed');
            chevron.style.transform = 'rotate(-90deg)';
            grid.style.maxHeight = '';
        }
        if (_guardarColapsados) _guardarColapsados();
    }

    function renderActivos() {

        const selOrden = document.getElementById('sel-vista-orden');
        if (selOrden && selOrden.value !== _activos.orden) selOrden.value = _activos.orden;

        const lista = document.getElementById('lista-dispositivos');
        const disps = _data.dispositivos;
        const query = (document.getElementById('input-busqueda')?.value || '').trim().toLowerCase();
        lista.classList.toggle('no-anim', !!query);

        if (disps.length === 0) {
            lista.innerHTML = `<div class="empty-state"><svg class="icon icon-line icon--lg-muted"><use href="#icon-camera"/></svg>Sin dispositivos registrados.<br>Usá el botón <strong>+</strong> para agregar uno.</div>`;
            const contador = document.getElementById('contador-dispositivos');
            if (contador) contador.textContent = '0';
            return;
        }

        const asignaciones = _buildAsignaciones();
        const tieneMacDuplicada = _calcDupMacs();
        const dupPatrimonios = _buildDupPatrimonios(disps);
        const dispLabel = d => d.mac || d.serial || '';

        let sorted = [...disps].sort((a, b) => {
            const keyA = _getGroupSortKey(a, asignaciones);
            const keyB = _getGroupSortKey(b, asignaciones);
            if (keyA !== keyB) {
                if (typeof keyA === 'number' && typeof keyB === 'number') return keyA - keyB;
                return String(keyA).localeCompare(String(keyB));
            }
            const mA = (a.marca || '').toLowerCase(), mB = (b.marca || '').toLowerCase();
            if (mA !== mB) return mA.localeCompare(mB);
            const modA = (a.modelo || '').toLowerCase(), modB = (b.modelo || '').toLowerCase();
            if (modA !== modB) return modA.localeCompare(modB);
            return dispLabel(a).localeCompare(dispLabel(b));
        });

        if (query) {
            const { tokens, tokenRegexes } = _tokenizar(query);
            sorted = sorted.map(d => ({ d, score: scoreDispositivo(d, { tokens, tokenRegexes, query, asignaciones }) }))
                .filter(({ score }) => score < Infinity)
                .sort((a, b) => a.score - b.score)
                .map(({ d }) => d);
        }

        if (sorted.length === 0) {
            lista.innerHTML = `<div class="empty-state"><svg class="icon icon-line icon--lg-muted"><use href="#icon-search"/></svg>Sin resultados para "<strong>${esc(query)}</strong>".</div>`;
            document.getElementById('contador-dispositivos').textContent = '0';
            return;
        }

        const contador = document.getElementById('contador-dispositivos');
        if (contador) contador.textContent = query ? `${sorted.length} / ${disps.length}` : sorted.length;

        const colClass = 'lista-2col';
        const renderItem = d => _renderItemActivo(d, asignaciones, tieneMacDuplicada, dupPatrimonios);

        const grupos = {};
        sorted.forEach(d => {
            const gLabel = _getGroupLabel(d, asignaciones);
            (grupos[gLabel] || (grupos[gLabel] = [])).push(d);
        });

        if (!document.getElementById('activos-grid-transition-css')) {
            const el = document.createElement('style');
            el.id = 'activos-grid-transition-css';
            el.textContent = '.activos-grid-transition{transition:max-height 0.3s ease,opacity 0.25s ease;overflow:hidden}.activos-grid-transition.collapsed{max-height:0!important;opacity:0!important}';
            document.head.appendChild(el);
        }
        let html = ``;

        Object.entries(grupos).forEach(([gLabel, items]) => {
            const isCollapsed = _activos.collapsed.has(gLabel);
            const itemsHtml = _activos.orden === 'edificio-piso'
                ? _renderSubgruposPiso(items, gLabel, asignaciones, colClass, renderItem)
                : `<div class="${colClass}">${items.map(renderItem).join('')}</div>`;

            html += `<div class="grupo-activos-card" data-grupo="${esc(gLabel)}">
        <div class="grupo-activos-header" data-toggle-grupo="${esc(gLabel)}">
            <span class="grupo-activos-header-label">${esc(gLabel)} <span class="badge badge-otro badge--grupo-count">${items.length}</span></span>
            <svg class="nvr-chevron" style="${isCollapsed ? 'transform:rotate(-90deg);' : ''}stroke:var(--c-orange);" viewBox="0 0 24 24"><use href="#icon-chevron-down"/></svg>
        </div>
        <div class="activos-grid-transition${isCollapsed ? ' collapsed' : ''}">${itemsHtml}</div>
    </div>`;
        });

        lista.innerHTML = html;

        if (!lista._delegRegistrada) {
            lista._delegRegistrada = true;
            lista.addEventListener('click', e => {
                if (e.target.closest('[data-copy]')) return; // deja que el handler de data-copy lo maneje
                const item = e.target.closest('.dispositivo-item[data-disp-id]');
                if (item) { UI.abrirEditarDispositivo(item.dataset.dispId); return; }
                const headerGrupo = e.target.closest('.grupo-activos-header[data-toggle-grupo]');
                if (headerGrupo) { _toggleGrupoActivos(headerGrupo.dataset.toggleGrupo); return; }
                const headerPiso = e.target.closest('.grupo-piso-header[data-toggle-piso]');
                if (headerPiso) { _togglePisoActivos(headerPiso.dataset.togglePiso); }
            });
        }
    }

    function renderProduccion() {
        const lista = document.getElementById('lista-grabadores');
        const grabs = [..._data.grabadores].sort((a, b) => (a.descripcion || '').localeCompare(b.descripcion || ''));

        const tieneMacDuplicada = _calcDupMacs();

        if (grabs.length === 0) {
            lista.innerHTML = `<div class="empty-state">
                    <svg class="icon icon-line icon--lg-muted"><use href="#icon-server"/></svg>
                    Sin grabadores registrados.<br>Usá el botón <strong>+</strong> para agregar uno.
                </div>`;
            return;
        }

        lista.innerHTML = grabs.map(g => {
            const canalesHtml = g.canales_data.map(c => {
                const disp = c.dispositivoId ? _data.dispositivos.find(d => d.id === c.dispositivoId) : null;

                if (disp) {
                    const tituloCanal = c.descripcion || disp.mac || disp.serial || '—';
                    const isDup = tieneMacDuplicada(disp);
                    const badgeStyle = isDup ? 'background: var(--c-purple);' : '';
                    const tituloHover = isDup ? `[MAC DUPLICADA] ${esc(tituloCanal)}` : esc(tituloCanal);

                    return `<div class="canal-slot-lista ocupado" data-canal="${c.canal}">
                                <div class="canal-numero" style="${badgeStyle}">CH ${c.canal}</div>
                                <div class="canal-dispositivo-nombre" title="${tituloHover}">${esc(tituloCanal)}</div>
                                <div class="canal-dispositivo-ip ${c.ip ? 'ip-copiable' : ''}" ${c.ip ? `data-copy="${esc(c.ip)}" title="Copiar IP"` : ''}>${c.ip ? esc(c.ip) : ''}</div>
                            </div>`;
                } else {
                    return `<div class="canal-slot-lista vacio" data-canal="${c.canal}">
                                <div class="canal-numero">CH ${c.canal}</div>
                                <div class="canal-vacio-label">Vacío</div>
                                <div></div>
                            </div>`;
                }
            }).join('');

            const ocupados = g.canales_data.filter(c => c.dispositivoId).length;
            const libres = g.canales_n - ocupados;
            const collapsed = !_grabExpanded.has(g.id);
            const gridClass = 'nvr-canales-grid';

            return `<div class="nvr-card anim-in${collapsed ? ' collapsed' : ''}" data-grab-id="${esc(g.id)}">
                    <div class="nvr-card-header nvr-header-toggle">
                        <div class="nvr-card-header-info">
                            <div class="nvr-card-nombre">
                                <span>${g.tipo === 'nvr' ? '📟' : '📼'} ${esc(g.descripcion)}</span>
                                <span class="badge badge-${g.tipo}-filled">${g.tipo.toUpperCase()}</span>
                                ${g.ip ? `<span class="nvr-card-ip ip-copiable" data-copy="${esc(g.ip)}" title="Copiar IP">${esc(g.ip)}</span>` : ''}
                            </div>
                            <div class="nvr-card-meta">
                                ${g.modelo ? `${esc(g.modelo)} · ` : ''}<span class="nvr-card-meta-ocupados">${ocupados}/${g.canales_n}</span> ocupados · <span class="nvr-card-meta-libres">${libres}</span> libres
                            </div>
                        </div>
                        <svg class="nvr-chevron" viewBox="0 0 24 24"><use href="#icon-chevron-down"/></svg>
                        <button class="icon-btn nvr-btn-editar" title="Editar Grabador">
                            <svg class="icon icon-line"><use href="#icon-edit"/></svg>
                        </button>
                    </div>
                    <div class="${gridClass}${collapsed ? ' collapsed' : ''}"><div class="nvr-canales-grid-inner">${canalesHtml}</div></div>
                </div>`;
        }).join('');

        if (!lista._delegRegistrada) {
            lista._delegRegistrada = true;
            lista.addEventListener('click', function (e) {
                if (e.target.closest('[data-copy]')) return; // deja que el handler de data-copy lo maneje
                const btnEdit = e.target.closest('.nvr-btn-editar');
                if (btnEdit) {
                    e.stopPropagation();
                    const card = btnEdit.closest('[data-grab-id]');
                    if (card) UI.abrirEditarGrabador(card.dataset.grabId);
                    return;
                }
                const header = e.target.closest('.nvr-header-toggle');
                if (header) {
                    const card = header.closest('[data-grab-id]');
                    if (card) UI.toggleGrabColapse(card.dataset.grabId);
                    return;
                }
                const slot = e.target.closest('.canal-slot-lista[data-canal]');
                if (slot) {
                    const card = slot.closest('[data-grab-id]');
                    if (card) UI.abrirAsignarCanal(card.dataset.grabId, +slot.dataset.canal);
                    return;
                }
            });
        }

        const listaOtros = document.getElementById('lista-otros-prod');
        const otros = _data.otros_prod || [];
        if (otros.length === 0) {
            listaOtros.innerHTML = `<div class="dash-empty-text dash-empty-text--center">Sin otros dispositivos en producción</div>`;
        } else {
            listaOtros.innerHTML = otros.map(o => {
                const disp = o.dispositivoId ? _data.dispositivos.find(d => d.id === o.dispositivoId) : null;
                const tc = disp ? (S.TIPOS[disp.tipo] || { emoji: '📦' }) : { emoji: '❓' };
                const desc = o.descripcion || (disp ? (disp.mac || disp.serial || 'Sin descripción') : 'Sin dispositivo asignado');
                const p = o.ip || '';
                return `
                        <div class="dispositivo-item anim-in" data-otro-id="${esc(o.id)}">
                            <div class="dispositivo-info">
                                <div class="dispositivo-nombre">${tc.emoji} ${esc(desc)}</div>
                                <div class="dispositivo-meta">
                                    ${disp ? `<span class="badge badge-otro">${S.TIPOS[disp.tipo]?.label?.toUpperCase() || disp.tipo.toUpperCase()}</span>` : ''}
                                    ${disp && disp.modelo ? `<span>${esc(disp.modelo)}</span>` : ''}
                                </div>
                            </div>
                            <div class="activo-info-derecha">
                                ${p ? `<div class="text-truncate nvr-card-ip">${esc(p)}</div>` : ''}
                                ${o.edificio ? `<div class="text-truncate">${esc(o.edificio)}${o.piso ? ` (Píso ${esc(o.piso)})` : ''}</div>` : ''}
                            </div>
                        </div>`;
            }).join('');
        }

        if (!listaOtros._delegRegistrada) {
            listaOtros._delegRegistrada = true;
            listaOtros.addEventListener('click', function (e) {
                const item = e.target.closest('.dispositivo-item[data-otro-id]');
                if (item) { UI.abrirEditarOtroProd(item.dataset.otroId); }
            });
        }
    }

    // ── Estado de edición activa ──────────────────────────────────────────────
    const _edicion = {
        dispId: null,
        grabId: null,
        otroProdId: null,
        canalGrabId: null,
        canalN: null,
        snapshotDisp: null,
        snapshotGrab: null,
        snapshotCanal: null,
        snapshotOtroProd: null,
        canalDesdeDispId: null,
        volverDesdeCanal: false,
        canalDispOcupados: new Set(),
        canalDispHighlight: -1,
        edificiosOrigen: 'ajustes',
        edificiosSnapForm: null,
        estado: '',
    };
    let _tabActual = (() => {
        try {
            const saved = JSON.parse(localStorage.getItem(LS.TAB) || 'null');
            if (saved && TABS.includes(saved.tab) && (Date.now() - saved.ts) < UNA_HORA) {
                return saved.tab;
            }
        } catch (_) { }
        return 'dashboard';
    })();
    let _busqTimer = null;
    let _importarParsed = null;

    function _actualizarBotonesEstado(estadoActual) {
        _edicion.estado = estadoActual;
        ['averiado', 'revisar', 'desafectado'].forEach(e => {
            const btn = document.getElementById(`btn-estado-${e}`);
            if (btn) btn.classList.toggle('activo', estadoActual === e);
        });
    }
    const KEY_EXPANDED = 'cctv_grab_expanded';
    const _grabExpanded = (() => {
        try {
            const saved = JSON.parse(localStorage.getItem(KEY_EXPANDED) || 'null');
            if (saved && Array.isArray(saved.ids) && (Date.now() - saved.ts) < UNA_HORA) {
                localStorage.setItem(KEY_EXPANDED, JSON.stringify({ ids: saved.ids, ts: Date.now() }));
                return new Set(saved.ids);
            }
        } catch (_) { }
        localStorage.removeItem(KEY_EXPANDED);
        return new Set();
    })();

    const ESTADO_ALIAS = {
        produccion: ['produccion', 'producción', 'operativo'],
        disponible: ['disponible'],
        averiado: ['averiado'],
        revisar: ['revisar', 'a revisar'],
        desafectado: ['desafectado'],
    };

    const BUSQ_CAMPOS = [
        { id: 'tipo', label: 'Tipo de dispositivo' },
        { id: 'mac', label: 'MAC' },
        { id: 'serial', label: 'Serial' },
        { id: 'marca', label: 'Marca' },
        { id: 'modelo', label: 'Modelo' },
        { id: 'patrimonio', label: 'Patrimonio' },
        { id: 'forma', label: 'Forma (cámara)' },
        { id: 'canal', label: 'Descripción' },
        { id: 'estado', label: 'Estado' },
        { id: 'ubicacion', label: 'Ubicación' },
        { id: 'ip', label: 'Dirección IP' },
    ];
    const KEY_BUSQ = 'cctv_busq_activos';

    function getEstadoEfectivo(d, asignaciones) {
        return d.estado || (asignaciones[d.id]?.length ? 'produccion' : 'disponible');
    }

    function _tokenizar(query) {
        let qNorm = query
            .replace(/\bdomo\s+ptz\b/gi, 'domo-ptz')
            .replace(/\bmini\s+domo\b/gi, 'minidomo')
            .replace(/\bmini\s+bullet\b/gi, 'minibullet');

        const tokens = (qNorm.match(/"[^"]+"|\S+/g) || []).map(t => t.replace(/"/g, ''));
        const tokenRegexes = tokens.map(t => new RegExp('(?<![a-z0-9])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![a-z0-9])', 'i'));
        return { tokens, tokenRegexes };
    }

    function scoreDispositivo(d, { tokens, tokenRegexes, query, asignaciones }) {
        const asigD = asignaciones[d.id] || [];
        const hayCanal = _busqActivos.has('canal')
            ? asigD.map(a => {
                if (a.tipo === 'canal') return (a.slot.descripcion || '').toLowerCase();
                if (a.tipo === 'otro_prod') return (a.item.descripcion || '').toLowerCase();
                if (a.tipo === 'grabador') return (a.grab.descripcion || '').toLowerCase();
                return '';
            }).filter(Boolean).join(' ')
            : '';
        const tipoKey = _busqActivos.has('tipo') ? d.tipo.toLowerCase() : '';
        const tipoLabel = _busqActivos.has('tipo') ? (S.TIPOS[d.tipo]?.label || '').toLowerCase() : '';

        const camposMap = { mac: d.mac, serial: d.serial, marca: d.marca, modelo: d.modelo, patrimonio: d.patrimonio };
        const campos = Object.entries(camposMap).filter(([k, v]) => v && _busqActivos.has(k)).map(([, v]) => v.toLowerCase());

        const formaKey = _busqActivos.has('forma') ? (d.forma || '').toLowerCase() : '';

        if (_busqActivos.has('ubicacion')) {
            const edifDisp = (d.edificio || '').trim();
            const pisoDisp = (d.piso || '').trim();
            if (edifDisp || pisoDisp) campos.push([edifDisp, pisoDisp].filter(Boolean).join(' ').toLowerCase());
            asigD.forEach(a => {
                if (a.tipo === 'canal' && a.slot) {
                    const edifCanal = (a.slot.edificio || '').trim();
                    const pisoCanal = (a.slot.piso || '').trim();
                    if (edifCanal || pisoCanal) campos.push([edifCanal, pisoCanal].filter(Boolean).join(' ').toLowerCase());
                }
                if (a.tipo === 'otro_prod' && a.item) {
                    const edifOtro = (a.item.edificio || '').trim();
                    const pisoOtro = (a.item.piso || '').trim();
                    if (edifOtro || pisoOtro) campos.push([edifOtro, pisoOtro].filter(Boolean).join(' ').toLowerCase());
                }
            });
        }

        if (_busqActivos.has('ip')) {
            asigD.forEach(a => {
                if (a.tipo === 'canal' && a.slot && a.slot.ip) campos.push(a.slot.ip.toLowerCase());
                if (a.tipo === 'otro_prod' && a.item && a.item.ip) campos.push(a.item.ip.toLowerCase());
                if (a.tipo === 'grabador' && a.grab && a.grab.ip) campos.push(a.grab.ip.toLowerCase());
            });
        }

        let estadoTextos = [];
        if (_busqActivos.has('estado')) {
            const estadoEfectivo = getEstadoEfectivo(d, asignaciones);
            estadoTextos = ESTADO_ALIAS[estadoEfectivo] || [estadoEfectivo];
        }

        if (campos.some(c => c.includes(query)) || (hayCanal && hayCanal.includes(query))) return 0;
        if (formaKey && query === formaKey) return 0;

        let total = 0;
        for (let ti = 0; ti < tokens.length; ti++) {
            const t = tokens[ti];
            const re = tokenRegexes[ti];
            if (tipoKey === t) { total += 0; continue; }
            if (tipoLabel === t) { total += 1; continue; }

            if (formaKey && t === formaKey) { total += 0; continue; }

            if (re.test(tipoKey) || re.test(tipoLabel)) { total += 2; continue; }
            if (campos.some(c => re.test(c))) { total += 3; continue; }
            if (t.length > 1 && campos.some(c => c.includes(t))) { total += 4; continue; }
            if (hayCanal && re.test(hayCanal)) { total += 5; continue; }
            if (t.length > 1 && hayCanal && hayCanal.includes(t)) { total += 6; continue; }
            if (estadoTextos.some(s => s === t)) { total += 1; continue; }
            if (t.length > 1 && estadoTextos.some(s => s.includes(t))) { total += 2; continue; }
            return Infinity;
        }
        return total;
    }

    function _calcDupMacs() {
        if (_cacheDupMacs) return _cacheDupMacs;
        const macCounts = {};
        function _contarMac(dispId) {
            if (!dispId) return;
            const d = _data.dispositivos.find(x => x.id === dispId);
            if (d && d.mac) {
                d.mac.split(',').forEach(m => {
                    const k = m.trim().toUpperCase();
                    if (k && !k.startsWith('SINRELEVAR')) macCounts[k] = (macCounts[k] || 0) + 1;
                });
            }
        }
        const grabs = _data.grabadores;
        grabs.forEach(g => {
            _contarMac(g.dispositivoId);
            g.canales_data.forEach(c => _contarMac(c.dispositivoId));
        });
        (_data.otros_prod || []).forEach(o => _contarMac(o.dispositivoId));
        const dupMacs = new Set(Object.keys(macCounts).filter(k => macCounts[k] > 1));
        return (_cacheDupMacs = (d) => d?.mac?.split(',').some(m => dupMacs.has(m.trim().toUpperCase())) ?? false);
    }
    const _busqActivos = (() => {
        try {
            const saved = JSON.parse(localStorage.getItem(KEY_BUSQ) || 'null');
            if (Array.isArray(saved)) {
                const validos = saved.filter(id => BUSQ_CAMPOS.some(f => f.id === id));
                return new Set(validos);
            }
        } catch (_) { }
        return new Set(BUSQ_CAMPOS.map(f => f.id));
    })();

    function _guardarBusqActivos() {
        try { localStorage.setItem(KEY_BUSQ, JSON.stringify([..._busqActivos])); } catch (_) { }
    }

    function _forzarFiltros(...ids) {
        if (!_filtrosPrevios) _filtrosPrevios = new Set(_busqActivos);
        _busqActivos.clear();
        ids.forEach(id => _busqActivos.add(id));
        _guardarBusqActivos();
        _sincFiltrosUI();
    }

    function _restaurarColapsos() {
        if (_estadoColapsadoPrevio) {
            _activos.collapsed = new Set(_estadoColapsadoPrevio);
            _estadoColapsadoPrevio = null;
        }
        if (_estadoPisosPrevio) {
            _activos.pisosCollapsed = new Set(_estadoPisosPrevio);
            _estadoPisosPrevio = null;
        }
    }

    function _expandirTodosLosGrupos() {
        if (!_activos.collapsed) _activos.collapsed = new Set();
        if (!_activos.pisosCollapsed) _activos.pisosCollapsed = new Set();
        if (!_estadoColapsadoPrevio) {
            _estadoColapsadoPrevio = new Set(_activos.collapsed);
        }
        if (!_estadoPisosPrevio) {
            _estadoPisosPrevio = new Set(_activos.pisosCollapsed);
        }
        _activos.collapsed.clear();
        _activos.pisosCollapsed.clear();
    }

    function _sincFiltrosUI() {
        const btnAll = document.getElementById('btn-toggle-all-filtros');
        if (btnAll) btnAll.textContent = _busqActivos.size > 0 ? 'Desactivar todo' : 'Activar todo';
        const btnFiltros = document.getElementById('btn-filtros-busqueda');
        if (btnFiltros) btnFiltros.classList.toggle('tiene-desactivados', _busqActivos.size < BUSQ_CAMPOS.length);
        document.querySelectorAll('[id^="filtro-cb-"]').forEach(cb => {
            cb.checked = _busqActivos.has(cb.id.replace('filtro-cb-', ''));
        });
    }


    // ════════════════════════════════════════════════════════════════════════════
    // § UI — controlador de interfaz (modales, tabs, acciones del usuario)
    // ════════════════════════════════════════════════════════════════════════════
    const UI = {

        alternarTema() {
            const oscuro = document.body.classList.toggle('dark-mode');
            localStorage.setItem(LS.TEMA, String(oscuro));
            const use = document.querySelector('#icono-tema use');
            if (use) use.setAttribute('href', oscuro ? '#icon-sun' : '#icon-moon');
        },

        copiarAlPortapapeles(texto, event) {
            if (event) {
                event.preventDefault();
                event.stopPropagation();
            }
            if (!texto) return;

            if (!navigator.clipboard || !window.isSecureContext) {
                const textArea = document.createElement("textarea");
                textArea.value = texto;
                textArea.style.position = "fixed";
                textArea.style.left = "-999999px";
                document.body.appendChild(textArea);
                textArea.focus();
                textArea.select();
                try {
                    document.execCommand('copy');
                    toast(`IP copiada: ${texto}`, 'success');
                } catch (err) {
                    toast('No se pudo copiar al portapapeles', 'error');
                }
                textArea.remove();
                return;
            }

            navigator.clipboard.writeText(texto).then(() => {
                toast(`IP copiada: ${texto}`, 'success');
            }).catch(() => {
                toast('No se pudo copiar al portapapeles', 'error');
            });
        },

        abrirGist() {
            MM.cerrar('modal-ajustes');
            setTimeout(() => {
                GistSync.poblarModal();
                MM.abrir('modal-gist', { onEscape: () => UI.cerrarGist() });
            }, 150);
        },

        cerrarGist() {
            MM.cerrar('modal-gist');
            setTimeout(() => UI.abrirAjustes(), 150);
        },

        abrirAjustes() {
            const oscuro = document.body.classList.contains('dark-mode');
            const use = document.querySelector('#icono-tema use');
            if (use) use.setAttribute('href', oscuro ? '#icon-sun' : '#icon-moon');

            const toggleRecordar = document.getElementById('toggle-recordar-grupos');
            if (toggleRecordar) toggleRecordar.classList.toggle('on', _activosRecordarEstado);

            MM.abrir('modal-ajustes');
        },

        toggleRecordarGrupos() {
            _activosRecordarEstado = !_activosRecordarEstado;
            try { localStorage.setItem(LS.ACTIVOS_RECORDAR, String(_activosRecordarEstado)); } catch { }

            const toggle = document.getElementById('toggle-recordar-grupos');
            if (toggle) toggle.classList.toggle('on', _activosRecordarEstado);

            if (!_activosRecordarEstado) {
                try { localStorage.removeItem(LS.ACTIVOS_COLLAPSED); } catch { }
                toast('Ya no se recordarán los grupos colapsados', 'info');
            } else {
                if (_guardarColapsados) _guardarColapsados();
                toast('Se recordarán los grupos colapsados al reiniciar', 'success');
            }
        },

        toggleDropdownActivos(e) {
            if (e) e.stopPropagation();
            const dd = document.getElementById('dropdown-vista-activos');
            if (!dd) return;
            const abriendo = dd.style.display === 'none';
            dd.style.display = abriendo ? 'block' : 'none';
            if (abriendo) {
                dd.querySelectorAll('.canal-disp-item[data-orden]').forEach(el => {
                    el.classList.toggle('activo-vista', el.dataset.orden === _activos.orden);
                });
            }
        },

        setActivosOrden(orden) {
            if (_activos.orden === orden) return;
            _activos.orden = orden;
            try { localStorage.setItem(LS.ACTIVOS_ORDEN, orden); } catch (_) { }
            renderActivos();
        },

        abrirFiltrosBusqueda() {
            const lista = document.getElementById('filtros-busqueda-lista');
            const camposOrdenados = [...BUSQ_CAMPOS].sort((a, b) => a.label.localeCompare(b.label));
            lista.innerHTML = camposOrdenados.map(f => `
                        <label class="filtro-row">
                            <span class="filtro-label">${f.label}</span>
                            <span class="filtro-toggle">
                                <input type="checkbox" id="filtro-cb-${f.id}"
                                    data-filtro-id="${f.id}"
                                    ${_busqActivos.has(f.id) ? 'checked' : ''}>
                                <span class="filtro-toggle-track"></span>
                            </span>
                        </label>`).join('');

            lista.querySelectorAll('input[data-filtro-id]').forEach(cb => {
                cb.addEventListener('change', function () {
                    UI._onFiltroChange(this.dataset.filtroId, this.checked);
                });
            });

            _sincFiltrosUI();
            MM.abrir('modal-filtros-busqueda');
        },

        cerrarFiltrosBusqueda() {
            MM.cerrar('modal-filtros-busqueda');
        },

        _onFiltroChange(id, activo) {
            if (activo) _busqActivos.add(id);
            else _busqActivos.delete(id);
            _guardarBusqActivos();
            _filtrosPrevios = null;
            _sincFiltrosUI();
            renderActivos();
        },

        toggleTodosFiltros() {

            const hayActivos = _busqActivos.size > 0;

            if (hayActivos) {
                _busqActivos.clear();
            } else {
                BUSQ_CAMPOS.forEach(f => _busqActivos.add(f.id));
            }

            _guardarBusqActivos();
            _filtrosPrevios = null;
            _sincFiltrosUI();
            renderActivos();
        },

        _restaurarFiltrosPrevios() {
            if (_filtrosPrevios) {
                _busqActivos.clear();
                _filtrosPrevios.forEach(f => _busqActivos.add(f));
                _filtrosPrevios = null;
                _guardarBusqActivos();

                _sincFiltrosUI();
            }
        },

        cerrarAjustes() {
            MM.cerrar('modal-ajustes');
        },

        abrirReporte() {
            MM.cerrar('modal-ajustes');
            setTimeout(() => {
                MM.abrir('modal-reporte', { onEscape: () => UI.cerrarReporte() });
            }, 150);
        },

        cerrarReporte() {
            MM.cerrar('modal-reporte');
            setTimeout(() => UI.abrirAjustes(), 150);
        },

        generarReporte() {
            const disps = _data.dispositivos.map(d => S.sanitizarDisp(d)).filter(Boolean);
            const grabs = _data.grabadores.map(g => S.sanitizarGrab(g)).filter(Boolean);
            const edifs = S.edificios;
            const TIPOS = S.TIPOS;
            const ESTADOS_LABELS = { '': 'Operativo', averiado: 'Averiado', revisar: 'En revisión', desafectado: 'Desafectado' };

            const asignaciones = _buildAsignaciones();

            const idsEnProd = _calcIdsEnProd();

            function getUbicacion(d) {
                const asig = (asignaciones[d.id] || [])[0];
                if (!asig) return { edificio: '', piso: '' };
                if (asig.tipo === 'canal') return { edificio: asig.slot.edificio || '', piso: asig.slot.piso || '' };
                if (asig.tipo === 'otro_prod') return { edificio: asig.item.edificio || '', piso: asig.item.piso || '' };
                if (asig.tipo === 'grabador') return { edificio: asig.grab.edificio || '', piso: asig.grab.piso || '' };
                return { edificio: '', piso: '' };
            }

            const sel = id => document.getElementById(id)?.checked;
            const esc = s => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

            const fecha = new Date().toLocaleDateString('es-AR', { day: '2-digit', month: 'long', year: 'numeric' });
            const secciones = [];

            if (sel('rpt-activos-totales')) {
                const rows = Object.entries(TIPOS).map(([k, v]) => {
                    const n = disps.filter(d => d.tipo === k).length;
                    return n > 0 ? `<tr><td>${esc(v.emoji)} ${esc(v.label)}</td><td class="num">${n}</td></tr>` : '';
                }).join('');
                secciones.push(`<section><h2>Activos totales por tipo</h2><table><thead><tr><th>Tipo</th><th class="num">Cantidad</th></tr></thead><tbody>${rows || '<tr><td colspan="2" class="vacio">Sin dispositivos</td></tr>'}</tbody><tfoot><tr><td><strong>Total</strong></td><td class="num"><strong>${disps.length}</strong></td></tr></tfoot></table></section>`);
            }

            if (sel('rpt-edificios')) {
                const rows = edifs.map(e => {
                    const n = disps.filter(d => (getUbicacion(d).edificio || '').trim().toLowerCase() === e.toLowerCase()).length;
                    return `<tr><td>${esc(e)}</td><td class="num">${n}</td></tr>`;
                }).join('');
                const sinEdif = disps.filter(d => !getUbicacion(d).edificio?.trim()).length;
                const sinRow = sinEdif > 0 ? `<tr><td class="muted">Sin edificio asignado</td><td class="num muted">${sinEdif}</td></tr>` : '';
                secciones.push(`<section><h2>Edificios con totales</h2><table><thead><tr><th>Edificio</th><th class="num">Dispositivos</th></tr></thead><tbody>${rows || ''}${sinRow || (!rows ? '<tr><td colspan="2" class="vacio">Sin edificios definidos</td></tr>' : '')}</tbody></table></section>`);
            }

            if (sel('rpt-formas')) {
                const camaras = disps.filter(d => d.tipo === 'camara');
                const conteo = {};
                camaras.forEach(c => {
                    const k = c.forma || '__sin__';
                    if (!conteo[k]) conteo[k] = { produccion: 0, disponible: 0, averiado: 0, revisar: 0, desafectado: 0 };
                    if (c.estado === 'averiado') conteo[k].averiado++;
                    else if (c.estado === 'revisar') conteo[k].revisar++;
                    else if (c.estado === 'desafectado') conteo[k].desafectado++;
                    else if (idsEnProd.has(c.id)) conteo[k].produccion++;
                    else conteo[k].disponible++;
                });
                const formasOrden = [...FORMAS.filter(f => conteo[f]), ...(conteo['__sin__'] ? ['__sin__'] : [])];
                const rows = formasOrden.map(f => {
                    const s = conteo[f];
                    const total = s.produccion + s.disponible + s.averiado + s.revisar + s.desafectado;
                    const label = f === '__sin__' ? '<span class="muted">Sin forma</span>' : esc(cap(f.replace(/-/g, ' ')));
                    return `<tr><td>${label}</td><td class="num">${s.produccion || '—'}</td><td class="num">${s.disponible || '—'}</td><td class="num">${s.averiado || '—'}</td><td class="num">${s.revisar || '—'}</td><td class="num">${s.desafectado || '—'}</td><td class="num"><strong>${total}</strong></td></tr>`;
                }).join('');
                secciones.push(`<section><h2>Cámaras por forma</h2><table><thead><tr><th>Forma</th><th class="num">Prod.</th><th class="num">Disp.</th><th class="num">Aver.</th><th class="num">Revis.</th><th class="num">Desaf.</th><th class="num">Total</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="vacio">Sin cámaras registradas</td></tr>'}</tbody><tfoot><tr><td><strong>Total</strong></td><td colspan="5"></td><td class="num"><strong>${camaras.length}</strong></td></tr></tfoot></table></section>`);
            }

            if (sel('rpt-cam-edificio')) {
                const camaras = disps.filter(d => d.tipo === 'camara');
                const mapa = {};
                camaras.forEach(c => {
                    const ub = getUbicacion(c);
                    const e = ub.edificio.trim() || '__sin_edif__';
                    const p = S.normalizarPiso(ub.piso) || '__sin_piso__';
                    if (!mapa[e]) mapa[e] = {};
                    mapa[e][p] = (mapa[e][p] || 0) + 1;
                });
                let html = '';
                const edificioKeys = [...Object.keys(mapa)].sort((a, b) => a === '__sin_edif__' ? 1 : b === '__sin_edif__' ? -1 : a.localeCompare(b));
                // Reusar _getPisoPeso global; __sin_piso__ mapea a 9999 igual que 'SIN ASIGNAR'
                const getPisoPeso = p => _getPisoPeso(!p || p === '__sin_piso__' ? 'SIN ASIGNAR' : p);
                edificioKeys.forEach(e => {
                    const label = e === '__sin_edif__' ? 'Sin edificio' : esc(e);
                    const total = Object.values(mapa[e]).reduce((s, n) => s + n, 0);
                    const pisoRows = Object.entries(mapa[e])
                        .sort(([a], [b]) => getPisoPeso(a) - getPisoPeso(b))
                        .map(([p, n]) => {
                            const pl = p === '__sin_piso__' ? '<span class="muted">Sin piso</span>' : esc(p);
                            return `<tr class="piso-row"><td>&nbsp;&nbsp;&nbsp;${pl}</td><td class="num">${n}</td></tr>`;
                        }).join('');
                    html += `<tr class="edif-row"><td><strong>${label}</strong></td><td class="num"><strong>${total}</strong></td></tr>${pisoRows}`;
                });
                secciones.push(`<section><h2>Cámaras por edificio y piso</h2><table><thead><tr><th>Ubicación</th><th class="num">Cámaras</th></tr></thead><tbody>${html || '<tr><td colspan="2" class="vacio">Sin cámaras con ubicación</td></tr>'}</tbody></table></section>`);
            }

            if (sel('rpt-modelos')) {
                const conteo = {};
                disps.forEach(d => { if (d.modelo) { conteo[d.modelo] = (conteo[d.modelo] || 0) + 1; } });
                const rows = Object.entries(conteo).sort(([, a], [, b]) => b - a).map(([m, n]) => `<tr><td>${esc(m)}</td><td class="num">${n}</td></tr>`).join('');
                secciones.push(`<section><h2>Cantidad por modelo</h2><table><thead><tr><th>Modelo</th><th class="num">Cantidad</th></tr></thead><tbody>${rows || '<tr><td colspan="2" class="vacio">Sin modelos registrados</td></tr>'}</tbody></table></section>`);
            }

            if (sel('rpt-estados')) {
                const conteo = { produccion: 0, disponible: 0, averiado: 0, revisar: 0, desafectado: 0 };
                disps.forEach(d => {
                    if (d.estado === 'averiado') conteo.averiado++;
                    else if (d.estado === 'revisar') conteo.revisar++;
                    else if (d.estado === 'desafectado') conteo.desafectado++;
                    else if (idsEnProd.has(d.id)) conteo.produccion++;
                    else conteo.disponible++;
                });
                const rows = Object.entries(ESTADO_LABEL).map(([k, label]) => `<tr><td>${esc(label)}</td><td class="num">${conteo[k] || 0}</td></tr>`).join('');
                secciones.push(`<section><h2>Estado de dispositivos</h2><table><thead><tr><th>Estado</th><th class="num">Cantidad</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><td><strong>Total</strong></td><td class="num"><strong>${disps.length}</strong></td></tr></tfoot></table></section>`);
            }

            if (sel('rpt-marcas')) {
                const conteo = {};
                disps.forEach(d => { const m = (d.marca || '').trim() || '__sin__'; conteo[m] = (conteo[m] || 0) + 1; });
                const rows = Object.entries(conteo).sort(([, a], [, b]) => b - a).map(([m, n]) => {
                    const label = m === '__sin__' ? '<span class="muted">Sin marca</span>' : esc(m);
                    return `<tr><td>${label}</td><td class="num">${n}</td></tr>`;
                }).join('');
                secciones.push(`<section><h2>Distribución por marca</h2><table><thead><tr><th>Marca</th><th class="num">Cantidad</th></tr></thead><tbody>${rows || '<tr><td colspan="2" class="vacio">Sin marcas registradas</td></tr>'}</tbody></table></section>`);
            }

            if (sel('rpt-grabadores')) {
                const rows = grabs.map(g => {
                    const ocupados = (g.canales_data || []).filter(c => c.dispositivoId).length;
                    const libres = (g.canales_n || 0) - ocupados;
                    const ub = [g.edificio, g.piso].filter(Boolean).join(' · ') || '—';
                    return `<tr><td>${esc(g.descripcion || 'Sin descripción')}</td><td class="center">${esc(g.tipo?.toUpperCase())}</td><td class="num">${g.canales_n || '?'}</td><td class="num">${ocupados}</td><td class="num">${libres}</td><td>${esc(ub)}</td></tr>`;
                }).join('');
                secciones.push(`<section><h2>Lista de grabadores</h2><table><thead><tr><th rowspan="2">Descripción</th><th rowspan="2" class="center">Tipo</th><th colspan="3" class="center th-group">Canales</th><th rowspan="2">Ubicación</th></tr><tr><th class="num th-sub">Total</th><th class="num th-sub">En uso</th><th class="num th-sub">Libres</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="vacio">Sin grabadores registrados</td></tr>'}</tbody></table></section>`);
            }

            if (!secciones.length) { toast('Seleccioná al menos una sección', 'info'); return; }

            const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reporte CCTV — ${fecha}</title>
<style>
  :root { --blue: #4c72ac; --border: #dde3ea; --muted: #6b7280; --bg: #f5f6fa; --card: #fff; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; background: var(--bg); color: #1a1d23; padding: 2rem 1rem 4rem; }
  .reporte-wrap { max-width: 860px; margin: 0 auto; }
  header { margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 2px solid var(--blue); display: flex; justify-content: space-between; align-items: flex-end; }
  header h1 { font-size: 1.4rem; color: var(--blue); }
  header .meta { font-size: 0.78rem; color: var(--muted); text-align: right; line-height: 1.6; }
  section { background: var(--card); border-radius: 12px; padding: 1.25rem 1.5rem; margin-bottom: 1.25rem; box-shadow: 0 1px 4px rgba(0,0,0,.07); }
  h2 { font-size: 0.95rem; font-weight: 700; color: var(--blue); margin-bottom: 0.85rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border); }
  table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  th { text-align: left; font-weight: 600; color: var(--muted); padding: 0.3rem 0.5rem; border-bottom: 1px solid var(--border); font-size: 0.75rem; text-transform: uppercase; letter-spacing: .04em; }
  td { padding: 0.45rem 0.5rem; border-bottom: 1px solid var(--border); }
  tbody tr:last-child td { border-bottom: none; }
  tfoot td { border-top: 1px solid var(--border); padding-top: 0.5rem; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .center { text-align: center; }
  .muted { color: var(--muted); font-style: italic; }
  .vacio { color: var(--muted); text-align: center; padding: 1rem; font-style: italic; }
  .edif-row td { background: #f0f4fb; }
  .piso-row td { font-size: 0.8rem; color: #374151; }
  .th-group { border-bottom: 1px solid var(--border); background: #f0f4fb; font-size: 0.72rem; }
  .th-sub { border-top: none; font-size: 0.72rem; }
  .btn-print { position: fixed; bottom: 1.5rem; right: 1.5rem; background: var(--blue); color: #fff; border: none; border-radius: 999px; padding: .65rem 1.25rem; font-size: .85rem; font-weight: 600; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.2); }
  .btn-print:hover { filter: brightness(1.1); }
  @media print { .btn-print { display: none; } body { background: #fff; } section { box-shadow: none; border: 1px solid var(--border); } }
</style>
</head>
<body>
<div class="reporte-wrap">
  <header>
    <div><h1>📹 Reporte CCTV</h1></div>
    <div class="meta">Generado el ${fecha}<br>${disps.length} dispositivos · ${grabs.length} grabadores · ${edifs.length} edificios</div>
  </header>
  ${secciones.join('\n')}
</div>
<button class="btn-print" onclick="window.print()">🖨️ Imprimir / Guardar PDF</button>
</body>
</html>`;

            const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            window.open(url, '_blank');
            setTimeout(() => URL.revokeObjectURL(url), 60000);
            MM.cerrar('modal-reporte');
            toast('Reporte generado', 'success');
        },

        abrirTiposDispositivo() {
            MM.cerrar('modal-ajustes');
            setTimeout(() => {
                UI._renderTiposCustom();
                MM.abrir('modal-tipos-dispositivo', { onEscape: () => UI.cerrarTiposDispositivo() });
            }, 150);
        },

        cerrarTiposDispositivo() {
            MM.cerrar('modal-tipos-dispositivo');
            setTimeout(() => UI.abrirAjustes(), 150);
        },

        abrirImportarDesdeAjustes() {
            MM.cerrar('modal-ajustes');
            setTimeout(() => {
                UI.abrirImportar();
                setTimeout(() => {
                    const m = document.getElementById('modal-importar');
                    if (m && m.classList.contains('show')) {
                        MM.abrir('modal-importar', { onEscape: () => { MM.cerrar('modal-importar'); setTimeout(() => UI.abrirAjustes(), 150); } });
                    }
                }, 20);
            }, 150);
        },

        async borrarTodosLosDatos() {
            const ok = await confirmarModal('¿Borrar todos los datos? Se eliminarán dispositivos, grabadores, tipos personalizados y edificios. Esta acción no se puede deshacer (antes de cerrar la página).', 'Borrar todo');
            if (!ok) return;
            historial.empujar('Restablecer todos los datos');
            _data = { dispositivos: [], grabadores: [] };
            Object.keys(S.TIPOS).forEach(k => { if (!S.TIPOS_BUILTIN[k]) delete S.TIPOS[k]; });
            S.guardarTipos();
            S.edificios.length = 0;
            S.guardarEdificios();
            guardar();
            render();
            MM.cerrar('modal-ajustes');
            toast('Todos los datos fueron eliminados', 'success');
        },

        _renderTiposCustom() {
            const cont = document.getElementById('lista-tipos-custom');
            if (!cont) return;
            const custom = Object.entries(S.TIPOS).filter(([, v]) => !v.builtin);
            if (!custom.length) {
                cont.innerHTML = `<div class="dash-empty-text dash-empty-text--sm-pad">Sin tipos personalizados</div>`;
                return;
            }
            cont.innerHTML = custom.map(([k, v]) => `
                        <div class="tipo-custom-row">
                            <span class="tipo-custom-label">${esc(v.label)}</span>
                            <button data-action="eliminar-tipo" data-key="${esc(k)}" class="icon-btn btn-delete btn-delete--sm" title="Eliminar tipo">
                                <svg class="icon icon-line icon--sm"><use href="#icon-trash"/></svg>
                            </button>
                        </div>`).join('');
        },

        agregarTipoCustom() {
            const labelEl = document.getElementById('nuevo-tipo-label');
            const raw = labelEl.value.trim();
            if (!raw) { labelEl.classList.add('error'); toast('Ingresá un nombre para el tipo', 'error'); return; }
            const labels = raw.split(',').map(n => S.sanitize(n.trim(), 100)).filter(Boolean);
            if (!labels.length) { labelEl.classList.add('error'); return; }

            historial.empujar('Agregar tipo de dispositivo');
            const agregados = [], duplicados = [];
            for (const label of labels) {
                const key = label.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || S.genId().slice(0, 8);
                if (S.TIPOS[key]) {
                    duplicados.push(label);
                } else {
                    S.TIPOS[key] = { label, emoji: '📦', badge: 'badge-otro', dot: 'var(--c-gold)', builtin: false };
                    agregados.push(label);
                }
            }
            if (agregados.length) S.guardarTipos();
            labelEl.value = '';
            labelEl.classList.remove('error');
            UI._renderTiposCustom();
            if (agregados.length && !duplicados.length) {
                toast(agregados.length === 1 ? `Tipo "${agregados[0]}" agregado` : `${agregados.length} tipos agregados`, 'success');
            } else if (agregados.length && duplicados.length) {
                toast(`${agregados.length} agregado${agregados.length > 1 ? 's' : ''}, ${duplicados.length} duplicado${duplicados.length > 1 ? 's' : ''} omitido${duplicados.length > 1 ? 's' : ''}`, 'info');
            } else {
                toast(duplicados.length === 1 ? `Ya existe "${duplicados[0]}"` : 'Todos ya existen', 'error');
            }
        },

        async eliminarTipoCustom(key) {
            if (S.TIPOS_BUILTIN[key]) return;
            const enUso = _data.dispositivos.some(d => d.tipo === key);
            if (enUso) { toast('No se puede eliminar: hay dispositivos con este tipo', 'error'); return; }
            const ok = await confirmarModal(`¿Eliminar el tipo "${S.TIPOS[key]?.label}"?`);
            if (!ok) return;
            historial.empujar(`Eliminar tipo "${S.TIPOS[key]?.label}"`);
            delete S.TIPOS[key];
            S.guardarTipos();
            UI._renderTiposCustom();
            toast('Tipo eliminado', 'success');
        },

        abrirEdificios(origen = 'ajustes') {
            _edicion.edificiosOrigen = origen;

            if (origen === 'canal') {
                _edicion.edificiosSnapForm = {
                    dispositivoId: document.getElementById('sel-canal-dispositivo').value || '',
                    dispInput: document.getElementById('canal-disp-input').value || '',
                    descripcion: document.getElementById('canal-descripcion').value || '',
                    ip: document.getElementById('canal-ip').value || '',
                    puerto: document.getElementById('canal-puerto').value || '',
                    edificio: document.getElementById('canal-edificio').value || '',
                    piso: document.getElementById('canal-piso').value || '',
                    rack: document.getElementById('canal-rack').value || '',
                    comentarios: document.getElementById('canal-comentarios').value || '',
                };
                MM.cerrar('modal-canal');
            } else if (origen === 'nuevo-grab') {
                _edicion.edificiosSnapForm = {
                    nombre: document.getElementById('nuevo-grab-nombre').value || '',
                    dispositivoId: document.getElementById('nuevo-grab-dispositivo-id').value || '',
                    ip: document.getElementById('nuevo-grab-ip').value || '',
                    puerto: document.getElementById('nuevo-grab-puerto').value || '',
                    edificio: document.getElementById('nuevo-grab-edificio').value || '',
                    piso: document.getElementById('nuevo-grab-piso').value || '',
                    rack: document.getElementById('nuevo-grab-rack').value || ''
                };
                MM.cerrar('modal-nuevo-grab');
            } else if (origen === 'editar-grab') {
                _edicion.edificiosSnapForm = {

                };
                MM.cerrar('modal-editar-grab');
            } else if (origen === 'nuevo-otro-prod' || origen === 'editar-otro-prod') {
                const prefijo = origen;
                _edicion.edificiosSnapForm = {
                    dispositivoId: document.getElementById(`sel-${prefijo}-dispositivo`).value || '',
                    dispInput: document.getElementById(`${prefijo}-disp-input`).value || '',
                    descripcion: document.getElementById(`${prefijo}-descripcion`).value || '',
                    ip: document.getElementById(`${prefijo}-ip`).value || '',
                    puerto: document.getElementById(`${prefijo}-puerto`).value || '',
                    edificio: document.getElementById(`${prefijo}-edificio`).value || '',
                    piso: document.getElementById(`${prefijo}-piso`).value || '',
                    rack: document.getElementById(`${prefijo}-rack`).value || '',
                    comentarios: document.getElementById(`${prefijo}-comentarios`).value || ''
                };
                MM.cerrar(`modal-${origen}`);
            } else {
                MM.cerrar('modal-ajustes');
            }

            setTimeout(() => {
                UI._renderEdificios();
                document.getElementById('nuevo-edificio-nombre').value = '';
                const btnVolver = document.querySelector('#modal-edificios .btn-cancel');
                if (btnVolver) {
                    if (origen === 'canal') btnVolver.innerHTML = `<svg class="icon icon-line"><use href="#icon-undo"/></svg> Volver al canal`;
                    else if (origen === 'nuevo-grab' || origen === 'editar-grab') btnVolver.innerHTML = `<svg class="icon icon-line"><use href="#icon-undo"/></svg> Volver al grabador`;
                    else btnVolver.innerHTML = `<svg class="icon icon-line"><use href="#icon-undo"/></svg> Volver`;
                }
                MM.abrir('modal-edificios', { onEscape: () => UI.cerrarEdificios() });
                setTimeout(() => document.getElementById('nuevo-edificio-nombre').focus(), 50);
            }, 150);
        },

        cerrarEdificios() {
            const origen = _edicion.edificiosOrigen;
            const snap = _edicion.edificiosSnapForm;
            MM.cerrar('modal-edificios');

            if (origen === 'canal' && snap) {
                setTimeout(() => {
                    UI.abrirAsignarCanal(_edicion.canalGrabId, _edicion.canalN, _edicion.canalDesdeDispId);
                    setTimeout(() => {
                        document.getElementById('sel-canal-dispositivo').value = snap.dispositivoId;
                        document.getElementById('canal-disp-input').value = snap.dispInput;
                        document.getElementById('canal-descripcion').value = snap.descripcion;
                        document.getElementById('canal-ip').value = snap.ip;
                        document.getElementById('canal-puerto').value = snap.puerto;
                        document.getElementById('canal-piso').value = snap.piso;
                        document.getElementById('canal-rack').value = snap.rack;
                        document.getElementById('canal-comentarios').value = snap.comentarios;
                        _poblarSelectEdificio('canal-edificio', snap.edificio);
                        const btnVerActivo = document.getElementById('btn-ver-activo-canal');
                        if (btnVerActivo) btnVerActivo.style.display = snap.dispositivoId ? '' : 'none';
                        _edicion.edificiosSnapForm = null;
                    }, 220);
                }, 150);
            } else if (origen === 'nuevo-grab' && snap) {
                setTimeout(() => {
                    UI.abrirNuevoGrabador();
                    setTimeout(() => {
                        document.getElementById('nuevo-grab-nombre').value = snap.nombre;
                        document.getElementById('nuevo-grab-dispositivo-id').value = snap.dispositivoId;
                        document.getElementById('nuevo-grab-ip').value = snap.ip;
                        document.getElementById('nuevo-grab-puerto').value = snap.puerto;
                        document.getElementById('nuevo-grab-piso').value = snap.piso;
                        document.getElementById('nuevo-grab-rack').value = snap.rack;
                        _poblarSelectEdificio('nuevo-grab-edificio', snap.edificio);
                        _edicion.edificiosSnapForm = null;
                    }, 220);
                }, 150);
            } else if (origen === 'editar-grab' && snap) {
            } else if ((origen === 'nuevo-otro-prod' || origen === 'editar-otro-prod') && snap) {
                setTimeout(() => {
                    if (origen === 'editar-otro-prod' && _edicion.otroProdId) {
                        UI.abrirEditarOtroProd(_edicion.otroProdId);
                    } else {
                        UI.abrirNuevoOtroProd();
                    }

                    setTimeout(() => {
                        const prefijo = origen;
                        document.getElementById(`sel-${prefijo}-dispositivo`).value = snap.dispositivoId;
                        document.getElementById(`${prefijo}-disp-input`).value = snap.dispInput;
                        document.getElementById(`${prefijo}-descripcion`).value = snap.descripcion;
                        document.getElementById(`${prefijo}-ip`).value = snap.ip;
                        document.getElementById(`${prefijo}-puerto`).value = snap.puerto;
                        document.getElementById(`${prefijo}-piso`).value = snap.piso;
                        document.getElementById(`${prefijo}-rack`).value = snap.rack;
                        document.getElementById(`${prefijo}-comentarios`).value = snap.comentarios;
                        _poblarSelectEdificio(`${prefijo}-edificio`, snap.edificio);
                        
                        if (prefijo === 'editar-otro-prod') {
                            const btnVerActivo = document.getElementById('btn-ver-activo-otro-prod');
                            if (btnVerActivo) btnVerActivo.style.display = snap.dispositivoId ? '' : 'none';
                        }
                        _edicion.edificiosSnapForm = null;
                    }, 220);
                }, 150);
            } else {
                _edicion.edificiosSnapForm = null;
                setTimeout(() => UI.abrirAjustes(), 150);
            }
        },

        _renderEdificios() {
            const cont = document.getElementById('lista-edificios');
            if (!cont) return;
            const lista = S.edificios;
            if (!lista.length) {
                cont.innerHTML = `<div class="dash-empty-text dash-empty-text--sm-pad">Sin edificios declarados</div>`;
                return;
            }
            cont.innerHTML = lista.map((nombre, idx) => `
                        <div class="tipo-custom-row">                            
                            <span class="tipo-custom-label">${esc(nombre)}</span>
                            <button data-action="eliminar-edificio" data-idx="${idx}" class="icon-btn btn-delete btn-delete--sm" title="Eliminar edificio">
                                <svg class="icon icon-line "><use href="#icon-trash"/></svg>
                            </button>
                        </div>`).join('');
        },

        agregarEdificio() {
            const el = document.getElementById('nuevo-edificio-nombre');
            const raw = el.value.trim();
            if (!raw) { el.classList.add('error'); toast('Ingresá un nombre para el edificio', 'error'); return; }
            const nombres = raw.split(',').map(n => S.sanitize(n.trim(), 100)).filter(Boolean);
            if (!nombres.length) { el.classList.add('error'); return; }

            historial.empujar('Agregar edificio');
            const agregados = [], duplicados = [];
            for (const nombre of nombres) {
                if (S.edificios.some(e => e.toLowerCase() === nombre.toLowerCase())) {
                    duplicados.push(nombre);
                } else {
                    S.edificios.push(nombre);
                    agregados.push(nombre);
                }
            }
            if (agregados.length) S.guardarEdificios();
            el.value = '';
            el.classList.remove('error');
            UI._renderEdificios();
            if (agregados.length && !duplicados.length) {
                toast(agregados.length === 1 ? `Edificio "${agregados[0]}" agregado` : `${agregados.length} edificios agregados`, 'success');
            } else if (agregados.length && duplicados.length) {
                toast(`${agregados.length} agregado${agregados.length > 1 ? 's' : ''}, ${duplicados.length} duplicado${duplicados.length > 1 ? 's' : ''} omitido${duplicados.length > 1 ? 's' : ''}`, 'info');
            } else {
                toast(duplicados.length === 1 ? `Ya existe "${duplicados[0]}"` : 'Todos ya existen', 'error');
            }
        },

        async eliminarEdificio(idx) {
            const nombre = S.edificios[idx];
            if (!nombre) return;
            const ok = await confirmarModal(`¿Eliminar el edificio "${nombre}"?`);
            if (!ok) return;
            historial.empujar(`Eliminar edificio "${nombre}"`);
            S.edificios.splice(idx, 1);
            S.guardarEdificios();
            UI._renderEdificios();
            toast('Edificio eliminado', 'success');
        },

        cambiarTab(tab, mantenerBusqueda = false) {

            if (_tabActual === tab) {
                let limpioAlgo = false;

                const inputBusq = document.getElementById('input-busqueda');
                if (inputBusq && inputBusq.value) {
                    UI.limpiarBusqueda();
                    inputBusq.blur();
                    limpioAlgo = true;
                }

                if (tab === 'dashboard' && _dash.tipoAbierto) {
                    _dash.tipoAbierto = null;
                    renderDashboard();
                    limpioAlgo = true;
                }

                return;
            }

            if (_dash.tipoAbierto) {
                _dash.tipoAbierto = null;
                setTimeout(() => renderDashboard(), 200);
            }

            const inputBusq = document.getElementById('input-busqueda');
            const tieneBusqueda = inputBusq && inputBusq.value.trim() !== '';
            const tieneSnapshot = _estadoColapsadoPrevio || _estadoPisosPrevio;

            if (!mantenerBusqueda && (tieneBusqueda || tieneSnapshot)) {
                if (inputBusq) inputBusq.value = '';
                const btnX = document.getElementById('btn-limpiar-busqueda');
                if (btnX) btnX.style.display = 'none';

                _restaurarColapsos();

                UI._restaurarFiltrosPrevios();

                setTimeout(() => renderActivos(), 200);
            }

            if (!mantenerBusqueda && inputBusq) inputBusq.blur();

            TABS.forEach(t => {
                const tabBtn = document.getElementById('tab-' + t);
                if (tabBtn) tabBtn.classList.toggle('activa', t === tab);
            });

            localStorage.setItem(LS.TAB, JSON.stringify({ tab, ts: Date.now() }));

            const panelSaliente = document.getElementById('panel-' + _tabActual);
            const panelEntrante = document.getElementById('panel-' + tab);
            _tabActual = tab;

            if (panelSaliente && panelSaliente !== panelEntrante) {
                panelSaliente.classList.add('tab-saliendo');
                setTimeout(() => {
                    panelSaliente.classList.remove('tab-saliendo');
                    panelSaliente.style.display = 'none';
                    panelEntrante.style.display = '';
                    panelEntrante.getBoundingClientRect();
                    panelEntrante.classList.add('tab-entrando');
                    panelEntrante.addEventListener('animationend', () => {
                        panelEntrante.classList.remove('tab-entrando');
                    }, { once: true });
                }, 180);
            } else {
                if (panelEntrante) panelEntrante.style.display = '';
            }
        },

        irAActivosConFiltro(tipo, estado, forma) {
            const tipoLabel = S.TIPOS[tipo]?.label?.toLowerCase() || tipo;
            const estadoQ = estado || '';
            const formaQ = forma || '';
            const query = [tipoLabel, estadoQ, formaQ].filter(Boolean).join(' ');

            _forzarFiltros('tipo', 'estado', 'forma');

            if (_dash.tipoAbierto) {
                _dash.tipoAbierto = null;
                _dash.estadoAbierto = null;
                setTimeout(() => renderDashboard(), 200);
            }
            TABS.forEach(t => {
                document.getElementById('tab-' + t).classList.toggle('activa', t === 'activos');
            });
            localStorage.setItem(LS.TAB, JSON.stringify({ tab: 'activos', ts: Date.now() }));
            const panelSaliente = document.getElementById('panel-' + _tabActual);
            const panelEntrante = document.getElementById('panel-activos');
            _tabActual = 'activos';

            const input = document.getElementById('input-busqueda');
            const btnX = document.getElementById('btn-limpiar-busqueda');
            if (input) { input.value = query; if (btnX) btnX.style.display = query ? '' : 'none'; }

            _expandirTodosLosGrupos();

            if (panelSaliente && panelSaliente !== panelEntrante) {
                panelSaliente.classList.add('tab-saliendo');
                setTimeout(() => {
                    panelSaliente.classList.remove('tab-saliendo');
                    panelSaliente.style.display = 'none';
                    panelEntrante.style.display = '';
                    panelEntrante.getBoundingClientRect();
                    panelEntrante.classList.add('tab-entrando');
                    panelEntrante.addEventListener('animationend', () => {
                        panelEntrante.classList.remove('tab-entrando');
                    }, { once: true });
                    renderActivos();
                }, 180);
            } else {
                panelEntrante.style.display = '';
                renderActivos();
            }
            setTimeout(() => input?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 250);
        },

        filtrarActivos() {
            const input = document.getElementById('input-busqueda');
            const btnX = document.getElementById('btn-limpiar-busqueda');
            const query = input.value;

            if (btnX) btnX.style.display = query ? '' : 'none';

            if (query && _tabActual !== 'activos') {
                UI.cambiarTab('activos', true);
            }

            if (_busqTimer) clearTimeout(_busqTimer);

            _busqTimer = setTimeout(() => {
                if (query.trim()) {
                    _expandirTodosLosGrupos();
                } else {
                    _restaurarColapsos();
                    UI._restaurarFiltrosPrevios();
                }

                renderActivos();
            }, 300);
        },

        limpiarBusqueda() {

            if (_busqTimer) clearTimeout(_busqTimer);

            const input = document.getElementById('input-busqueda');
            input.value = '';
            document.getElementById('btn-limpiar-busqueda').style.display = 'none';
            input.focus();

            _restaurarColapsos();
            UI._restaurarFiltrosPrevios();
            renderActivos();
        },

        toggleGrabColapse(id) {
            if (_grabExpanded.has(id)) {
                _grabExpanded.delete(id);
            } else {
                _grabExpanded.add(id);
            }
            localStorage.setItem(KEY_EXPANDED, JSON.stringify({ ids: [..._grabExpanded], ts: Date.now() }));
            const card = document.querySelector(`.nvr-card[data-grab-id="${CSS.escape(id)}"]`);
            const grid = card?.querySelector('.nvr-canales-grid');
            if (!card || !grid) return;
            const expandiendo = _grabExpanded.has(id);
            if (expandiendo) {
                card.classList.remove('collapsed');
                grid.classList.remove('collapsed');
                grid.style.maxHeight = grid.scrollHeight + 'px';
                grid.addEventListener('transitionend', (e) => {
                    if (e.propertyName !== 'max-height') return;
                    grid.style.maxHeight = '';
                }, { once: true });
            } else {
                grid.style.maxHeight = grid.scrollHeight + 'px';
                grid.getBoundingClientRect();
                card.classList.add('collapsed');
                grid.classList.add('collapsed');
                grid.style.maxHeight = '';
            }
        },

        onDispTipoChange(prefijo) {
            const tipo = document.getElementById(`${prefijo}-tipo`).value;
            document.getElementById(`${prefijo}-forma-group`).style.display = tipo === 'camara' ? '' : 'none';
            document.getElementById(`${prefijo}-canales-group`).style.display = ['nvr', 'dvr'].includes(tipo) ? '' : 'none';
            if (tipo !== 'camara') document.getElementById(`${prefijo}-forma`).value = '';
        },

        abrirNuevoDispositivo() {
            _edicion.dispId = null;
            _limpiarFormDisp('nuevo-disp');
            _poblarSelectTipo('nuevo-disp', null);
            MM.abrir('modal-nuevo-disp');
        },

        cerrarModalNuevoDispositivo() {
            MM.cerrar('modal-nuevo-disp');
        },

        guardarNuevoDispositivo() {
            const prefijo = 'nuevo-disp';
            const tipo = document.getElementById(`${prefijo}-tipo`).value;
            const macRaw = document.getElementById(`${prefijo}-mac`).value.trim();
            const serial = document.getElementById(`${prefijo}-serial`).value.trim();
            const macs = macRaw ? macRaw.split(',').map(t => t.trim()).filter(Boolean) : [];

            if (!tipo) { document.getElementById(`${prefijo}-tipo`).classList.add('error'); toast('Seleccioná un tipo', 'error'); return; }
            if (!validarCampoMAC(`${prefijo}-mac`)) return;
            if (!macs.length && !serial) {
                document.getElementById(`${prefijo}-mac`).classList.add('error');
                document.getElementById(`${prefijo}-serial`).classList.add('error');
                toast('Ingresá al menos MAC o Serial', 'error');
                return;
            }

            const otrosDisps = _data.dispositivos;
            for (const m of macs) {
                const mNorm = m.toUpperCase();
                const dup = otrosDisps.find(x => x.mac && x.mac.toUpperCase() === mNorm);
                if (dup) {
                    document.getElementById(`${prefijo}-mac`).classList.add('error');
                    const label = [dup.marca, dup.modelo].filter(Boolean).join(' ') || dup.serial || dup.id;
                    toast(`MAC duplicada: ${m} — ya existe en "${label}"`, 'error');
                    return;
                }
            }

            if (serial && !esSerialPendiente(serial)) {
                const serialNorm = serial.toUpperCase();
                const dupSerial = otrosDisps.find(x => x.serial && x.serial.toUpperCase() === serialNorm && !esSerialPendiente(x.serial));
                if (dupSerial) {
                    document.getElementById(`${prefijo}-serial`).classList.add('error');
                    const label = [dupSerial.marca, dupSerial.modelo].filter(Boolean).join(' ') || dupSerial.mac || dupSerial.id;
                    toast(`Serial duplicado: ${serial} — ya existe en "${label}"`, 'error');
                    return;
                }
            }

            historial.empujar(macs.length > 1 ? `Agregar ${macs.length} dispositivos` : 'Agregar dispositivo');

            const base = {
                tipo,
                marca: document.getElementById(`${prefijo}-marca`).value.trim(),
                modelo: document.getElementById(`${prefijo}-modelo`).value.trim(),
                serial,
                forma: document.getElementById(`${prefijo}-forma`).value,
                canales: document.getElementById(`${prefijo}-canales`).value,
                patrimonio: document.getElementById(`${prefijo}-patrimonio`).value.trim(),
                firmware: document.getElementById(`${prefijo}-firmware`).value.trim(),
            };

            if (macs.length > 1) {
                macs.forEach(mac => _data.dispositivos.push(S.sanitizarDisp({ ...base, mac })));
                toast(`${macs.length} dispositivos agregados`, 'success');
            } else {
                _data.dispositivos.push(S.sanitizarDisp({ ...base, mac: macs[0] || '' }));
                toast('Dispositivo agregado', 'success');
            }

            guardar(); render(); MM.cerrar('modal-nuevo-disp');
        },

        abrirEditarDispositivo(id) {
            const d = _data.dispositivos.find(x => x.id === id); if (!d) return;
            _edicion.dispId = id;
            const prefijo = 'editar-disp';
            _poblarSelectTipo(prefijo, d.tipo);
            document.getElementById(`${prefijo}-marca`).value = d.marca;
            document.getElementById(`${prefijo}-modelo`).value = d.modelo;
            document.getElementById(`${prefijo}-serial`).value = d.serial || '';
            document.getElementById(`${prefijo}-mac`).value = d.mac || '';
            document.getElementById(`${prefijo}-patrimonio`).value = d.patrimonio || '';
            document.getElementById(`${prefijo}-firmware`).value = d.firmware || '';
            const esCamara = d.tipo === 'camara';
            document.getElementById(`${prefijo}-forma-group`).style.display = esCamara ? '' : 'none';
            document.getElementById(`${prefijo}-forma`).value = d.forma || '';
            const esGrab = ['nvr', 'dvr'].includes(d.tipo);
            document.getElementById(`${prefijo}-canales-group`).style.display = esGrab ? '' : 'none';
            document.getElementById(`${prefijo}-canales`).value = d.canales || 16;

            const grabAsociado = esGrab ? _data.grabadores.find(g => g.dispositivoId === id) : null;
            const canalesOcupados = grabAsociado
                ? grabAsociado.canales_data.filter(c => c.dispositivoId).length
                : 0;
            const enProduccionComoGrab = !!grabAsociado;
            const enProduccionComoCanal = _data.grabadores.some(g => g.canales_data.some(c => c.dispositivoId === id));
            const enProduccion = enProduccionComoGrab || enProduccionComoCanal;

            const selTipo = document.getElementById(`${prefijo}-tipo`);
            selTipo.disabled = enProduccion;

            const inputCanales = document.getElementById(`${prefijo}-canales`);
            inputCanales.disabled = canalesOcupados > 0;
            if (canalesOcupados > 0) {
                inputCanales.title = `No se puede modificar: ${canalesOcupados} canal${canalesOcupados === 1 ? '' : 'es'} ocupado${canalesOcupados === 1 ? '' : 's'}`;
            } else {
                inputCanales.title = '';
            }

            let avisoStrong = '';
            if (enProduccionComoGrab && canalesOcupados > 0) {
                avisoStrong = `⚠️ Este grabador está en producción con ${canalesOcupados} canal${canalesOcupados === 1 ? '' : 'es'} ocupado${canalesOcupados === 1 ? '' : 's'}. No se puede cambiar el tipo, canales ni eliminar mientras tenga cámaras asignadas.`;
            } else if (enProduccionComoGrab) {
                avisoStrong = `ℹ️ Este grabador está en producción. No se puede eliminar`;
            } else if (enProduccionComoCanal) {
                avisoStrong = `ℹ️ Este dispositivo está asignado a un grabador en producción.`;
            }
            const formBody = document.querySelector('#modal-editar-disp .modal-scroll-body');
            const existente = document.getElementById('aviso-prod-disp');
            if (existente) existente.remove();
            if (avisoStrong && formBody) {
                const aviso = document.createElement('div');
                aviso.id = 'aviso-prod-disp';
                aviso.className = 'aviso-prod';
                aviso.textContent = avisoStrong;
                formBody.insertBefore(aviso, formBody.firstChild);
            }

            const btnEliminar = document.querySelector('#modal-editar-disp .btn-delete');
            if (btnEliminar) {
                btnEliminar.disabled = enProduccion;
                btnEliminar.title = enProduccion ? 'No se puede eliminar: el dispositivo está en producción' : '';
            }

            const btnAsig = document.getElementById('btn-editar-asignacion');
            if (esCamara) {
                btnAsig.style.display = enProduccionComoCanal ? '' : 'none';
                btnAsig.title = 'Ver asignación';
                btnAsig.onclick = () => UI.editarAsignacionCamara();
            } else if (esGrab && enProduccionComoGrab) {
                btnAsig.style.display = '';
                btnAsig.title = 'Ver grabador';
                btnAsig.onclick = () => UI.verGrabadorDesdeDispositivo();
            } else {
                btnAsig.style.display = 'none';
            }
            _edicion.snapshotDisp = {
                tipo: d.tipo,
                estado: d.estado || '',
                marca: d.marca,
                modelo: d.modelo,
                serial: d.serial || '',
                mac: d.mac || '',
                patrimonio: d.patrimonio || '',
                firmware: d.firmware || '',
                forma: d.forma || '',
                canales: String(d.canales || 16),
            };

            _actualizarBotonesEstado(d.estado || '');

            ['averiado', 'revisar', 'desafectado'].forEach(e => {
                const btn = document.getElementById(`btn-estado-${e}`);
                if (btn) {
                    btn.disabled = enProduccionComoGrab;
                    btn.title = enProduccionComoGrab ? 'No se puede cambiar el estado: el grabador está en producción' : '';
                }
            });

            ModalLock.reset('modal-editar-disp');
            MM.abrir('modal-editar-disp', { onEscape: () => UI.cerrarModalEditarDispositivo() });
            const btnCerrarDisp = document.querySelector('#modal-editar-disp .btn-cancel');
            if (btnCerrarDisp) btnCerrarDisp.innerHTML = _edicion.volverDesdeCanal
                ? '<svg class="icon icon-line"><use href="#icon-undo"/></svg>Volver'
                : '<svg class="icon icon-line"><use href="#icon-cancelar"/></svg>Cancelar';
        },

        cerrarModalEditarDispositivo() {
            MM.cerrar('modal-editar-disp');
            _edicion.estado = '';
            const volver = _edicion.volverDesdeCanal;
            const grabId = _edicion.canalGrabId;
            const canalN = _edicion.canalN;
            _edicion.dispId = null;
            _edicion.volverDesdeCanal = false;
            if (volver && grabId === 'OTRO_PROD') {
                setTimeout(() => canalN ? UI.abrirEditarOtroProd(canalN) : UI.abrirNuevoOtroProd(), 180);
            } else if (volver && grabId != null && canalN != null) {
                setTimeout(() => UI.abrirAsignarCanal(grabId, canalN), 180);
            }
        },

        toggleEstadoDisp(estado) {
            const nuevo = _edicion.estado === estado ? '' : estado;
            _actualizarBotonesEstado(nuevo);
        },

        async guardarEdicionDispositivo() {
            const prefijo = 'editar-disp';
            const tipo = document.getElementById(`${prefijo}-tipo`).value;
            const macRaw = document.getElementById(`${prefijo}-mac`).value.trim().toUpperCase();
            const serial = document.getElementById(`${prefijo}-serial`).value.trim();
            const macs = macRaw ? macRaw.split(',').map(t => t.trim()).filter(Boolean) : [];

            if (!tipo) { document.getElementById(`${prefijo}-tipo`).classList.add('error'); toast('Seleccioná un tipo', 'error'); return; }
            if (!validarCampoMAC(`${prefijo}-mac`)) return;
            if (!macs.length && !serial) {
                document.getElementById(`${prefijo}-mac`).classList.add('error');
                document.getElementById(`${prefijo}-serial`).classList.add('error');
                toast('Ingresá al menos MAC o Serial', 'error');
                return;
            }

            const dispActual = _data.dispositivos.find(x => x.id === _edicion.dispId);
            const grabAsociado = dispActual ? _data.grabadores.find(g => g.dispositivoId === _edicion.dispId) : null;
            if (grabAsociado) {
                const canalesOcupados = grabAsociado.canales_data.filter(c => c.dispositivoId).length;
                if (tipo !== dispActual.tipo) {
                    document.getElementById(`${prefijo}-tipo`).classList.add('error');
                    toast('No se puede cambiar el tipo: el grabador está en producción', 'error');
                    return;
                }
                if (canalesOcupados > 0) {
                    const nuevosCanales = parseInt(document.getElementById(`${prefijo}-canales`).value);
                    if (nuevosCanales < canalesOcupados) {
                        document.getElementById(`${prefijo}-canales`).classList.add('error');
                        toast(`No se puede reducir a ${nuevosCanales} canales: hay ${canalesOcupados} ocupados`, 'error');
                        return;
                    }
                }
            }
            const enCanal = _data.grabadores.some(g => g.canales_data.some(c => c.dispositivoId === _edicion.dispId));
            if (enCanal && dispActual && tipo !== dispActual.tipo) {
                document.getElementById(`${prefijo}-tipo`).classList.add('error');
                toast('No se puede cambiar el tipo: el dispositivo está asignado a un canal en producción', 'error');
                return;
            }

            const otrosDisps = _data.dispositivos.filter(x => x.id !== _edicion.dispId);
            for (const m of macs) {
                const mNorm = m.toUpperCase();
                const dup = otrosDisps.find(x => x.mac && x.mac.toUpperCase() === mNorm);
                if (dup) {
                    document.getElementById(`${prefijo}-mac`).classList.add('error');
                    const label = [dup.marca, dup.modelo].filter(Boolean).join(' ') || dup.serial || dup.id;
                    toast(`MAC duplicada: ${m} — ya existe en "${label}"`, 'error');
                    return;
                }
            }

            if (serial && !esSerialPendiente(serial)) {
                const serialNorm = serial.toUpperCase();
                const dupSerial = otrosDisps.find(x => x.serial && x.serial.toUpperCase() === serialNorm && !esSerialPendiente(x.serial));
                if (dupSerial) {
                    document.getElementById(`${prefijo}-serial`).classList.add('error');
                    const label = [dupSerial.marca, dupSerial.modelo].filter(Boolean).join(' ') || dupSerial.mac || dupSerial.id;
                    toast(`Serial duplicado: ${serial} — ya existe en "${label}"`, 'error');
                    return;
                }
            }

            const base = {
                tipo,
                estado: _edicion.estado,
                marca: document.getElementById(`${prefijo}-marca`).value.trim(),
                modelo: document.getElementById(`${prefijo}-modelo`).value.trim(),
                serial,
                forma: document.getElementById(`${prefijo}-forma`).value,
                canales: document.getElementById(`${prefijo}-canales`).value,
                patrimonio: document.getElementById(`${prefijo}-patrimonio`).value.trim(),
                firmware: document.getElementById(`${prefijo}-firmware`).value.trim(),
            };

            const obj = S.sanitizarDisp({ ...base, id: _edicion.dispId, mac: macs[0] || '' });
            const nuevoSnap = {
                tipo: obj.tipo,
                estado: obj.estado || '',
                marca: obj.marca,
                modelo: obj.modelo,
                serial: obj.serial || '',
                mac: obj.mac || '',
                patrimonio: obj.patrimonio || '',
                firmware: obj.firmware || '',
                forma: obj.forma || '',
                canales: String(obj.canales || 16),
            };
            const huboCambios = JSON.stringify(nuevoSnap) !== JSON.stringify(_edicion.snapshotDisp);
            if (!huboCambios) { toast('Sin cambios', 'info'); MM.cerrar('modal-editar-disp'); _edicion.dispId = null; _edicion.snapshotDisp = null; return; }

            const estadosConDesasignacion = ['averiado', 'revisar', 'desafectado'];
            const esCamara = dispActual && !['nvr', 'dvr'].includes(dispActual.tipo);
            const estadoCambioAInactivo = estadosConDesasignacion.includes(_edicion.estado) &&
                !estadosConDesasignacion.includes(_edicion.snapshotDisp?.estado || '');
            if (esCamara && estadoCambioAInactivo) {
                let grabConCanal = null, slotConCanal = null;
                for (const g of _data.grabadores) {
                    const slot = g.canales_data.find(c => c.dispositivoId === _edicion.dispId);
                    if (slot) { grabConCanal = g; slotConCanal = slot; break; }
                }
                if (grabConCanal && slotConCanal) {
                    const LABELS = { averiado: 'Averiado', revisar: 'A revisar', desafectado: 'Desafectado' };
                    const msg = `Marcar como "${LABELS[_edicion.estado]}" quitará este dispositivo del Canal ${slotConCanal.canal} del ${grabConCanal.descripcion}\n ¿Confirmar?`;
                    const ok = await confirmarModal(msg, 'Guardar');
                    if (!ok) return;

                    historial.empujar('Actualizar estado dispositivo y liberar canal');
                    slotConCanal.dispositivoId = '';
                } else {
                    historial.empujar('Editar dispositivo');
                }
            } else {
                historial.empujar('Editar dispositivo');
            }

            const idx = _data.dispositivos.findIndex(x => x.id === _edicion.dispId);
            if (idx !== -1) _data.dispositivos[idx] = obj;
            _sincronizarGrabadores(_edicion.dispId);
            toast('Dispositivo actualizado', 'success');

            guardar(); render(); MM.cerrar('modal-editar-disp'); _edicion.dispId = null; _edicion.snapshotDisp = null;
        },

        editarAsignacionCamara() {
            if (!_edicion.dispId) return;
            let grabId = null, nCanal = null;
            for (const g of _data.grabadores) {
                const slot = g.canales_data.find(c => c.dispositivoId === _edicion.dispId);
                if (slot) { grabId = g.id; nCanal = slot.canal; break; }
            }
            if (!grabId) return;
            const dispId = _edicion.dispId;
            MM.cerrar('modal-editar-disp');
            setTimeout(() => UI.abrirAsignarCanal(grabId, nCanal, dispId), 180);
        },

        verGrabadorDesdeDispositivo() {
            if (!_edicion.dispId) return;
            const grab = _data.grabadores.find(g => g.dispositivoId === _edicion.dispId);
            if (!grab) return;
            MM.cerrar('modal-editar-disp');
            setTimeout(() => UI.abrirEditarGrabador(grab.id), 180);
        },

        async eliminarDispositivo() {
            if (!_edicion.dispId) return;
            const d = _data.dispositivos.find(x => x.id === _edicion.dispId);
            const grabAsoc = _data.grabadores.find(g => g.dispositivoId === _edicion.dispId);
            if (grabAsoc) {
                const ocupados = grabAsoc.canales_data.filter(c => c.dispositivoId).length;
                if (ocupados > 0) {
                    toast(`No se puede eliminar: el grabador tiene ${ocupados} canal${ocupados === 1 ? '' : 'es'} ocupado${ocupados === 1 ? '' : 's'}`, 'error');
                    return;
                }
            }
            const enCanal = _data.grabadores.some(g => g.canales_data.some(c => c.dispositivoId === _edicion.dispId));
            if (enCanal) {
                toast('No se puede eliminar: el dispositivo está asignado a un canal en producción', 'error');
                return;
            }
            const ok = await confirmarModal(`¿Eliminar "${[d?.marca, d?.modelo].filter(Boolean).join(' ') || d?.mac || d?.serial || 'este dispositivo'}"?`);
            if (!ok) return;

            historial.empujar('Eliminar dispositivo');
            if (grabAsoc) {
                _data.grabadores = _data.grabadores.filter(g => g.dispositivoId !== _edicion.dispId);
            }
            _data.dispositivos = _data.dispositivos.filter(x => x.id !== _edicion.dispId);
            guardar(); render(); MM.cerrar('modal-editar-disp'); _edicion.dispId = null;
            toast('Dispositivo eliminado', 'success');
        },

        abrirNuevoGrabador() {
            _edicion.grabId = null;
            _limpiarFormGrab('nuevo-grab');
            _poblarSelectorGrabador('nuevo-grab', null);
            _poblarSelectEdificio('nuevo-grab-edificio', '');
            MM.abrir('modal-nuevo-grab');
        },

        cerrarModalNuevoGrabador() {
            MM.cerrar('modal-nuevo-grab');
        },

        guardarNuevoGrabador() {
            const prefijo = 'nuevo-grab';
            const descripcion = document.getElementById(`${prefijo}-nombre`).value.trim();
            if (!descripcion) { document.getElementById(`${prefijo}-nombre`).classList.add('error'); toast('La descripción es obligatoria', 'error'); return; }
            const dispId = document.getElementById(`${prefijo}-dispositivo-id`).value;
            if (!dispId) { document.getElementById(`${prefijo}-dispositivo-id`).classList.add('error'); toast('Seleccioná un dispositivo', 'error'); return; }
            if (!validarCampoIP(`${prefijo}-ip`)) return;

            const disp = _data.dispositivos.find(x => x.id === dispId);
            if (!disp) { toast('Dispositivo no encontrado', 'error'); return; }

            historial.empujar('Agregar grabador');

            const datos = {
                id: S.genId(),
                descripcion,
                tipo: disp.tipo,
                marca: disp.marca,
                modelo: disp.modelo,
                ip: document.getElementById(`${prefijo}-ip`).value.trim(),
                puerto: document.getElementById(`${prefijo}-puerto`).value.trim(),
                edificio: document.getElementById(`${prefijo}-edificio`).value.trim(),
                piso: S.normalizarPiso(document.getElementById(`${prefijo}-piso`).value),
                rack: document.getElementById(`${prefijo}-rack`).value.trim(),
                comentarios: document.getElementById(`${prefijo}-comentarios`).value.trim(),
                mac: disp.mac || '',
                canales: disp.canales || 16,
                dispositivoId: disp.id,
            };

            _data.grabadores.push(S.sanitizarGrab(datos));
            toast('Grabador agregado', 'success');
            guardar(); render(); MM.cerrar('modal-nuevo-grab');
        },

        abrirEditarGrabador(id) {
            const g = _data.grabadores.find(x => x.id === id); if (!g) return;
            _edicion.grabId = id;
            const prefijo = 'editar-grab';
            document.getElementById(`${prefijo}-nombre`).value = g.descripcion;
            document.getElementById(`${prefijo}-ip`).value = g.ip || '';
            document.getElementById(`${prefijo}-puerto`).value = g.puerto || '';
            _poblarSelectEdificio(`${prefijo}-edificio`, g.edificio || '');
            document.getElementById(`${prefijo}-piso`).value = g.piso || '';
            document.getElementById(`${prefijo}-rack`).value = g.rack || '';
            document.getElementById(`${prefijo}-comentarios`).value = g.comentarios || '';
            const _maxCanalOcupado = g.canales_data
                .filter(c => c.dispositivoId)
                .reduce((max, c) => Math.max(max, c.canal), 0);
            _poblarSelectorGrabador(prefijo, g.dispositivoId || null, _maxCanalOcupado);

            _edicion.snapshotGrab = {
                descripcion: g.descripcion,
                ip: g.ip || '',
                puerto: g.puerto || '',
                edificio: g.edificio || '',
                piso: g.piso || '',
                rack: g.rack || '',
                comentarios: g.comentarios || '',
                dispositivoId: g.dispositivoId || '',
            };

            ModalLock.reset('modal-editar-grab');
            MM.abrir('modal-editar-grab');
            const btnVerActivo = document.getElementById('btn-ver-activo-grab');
            if (btnVerActivo) btnVerActivo.style.display = g.dispositivoId ? '' : 'none';
        },

        cerrarModalEditarGrabador() {
            MM.cerrar('modal-editar-grab');
            _edicion.grabId = null;
        },

        onGrabDispositivoChange() {
            const dispId = document.getElementById('editar-grab-dispositivo-id').value;
            const btn = document.getElementById('btn-ver-activo-grab');
            if (btn) btn.style.display = dispId ? '' : 'none';
        },

        verActivoDesdeGrabador() {
            const dispId = document.getElementById('editar-grab-dispositivo-id').value;
            if (!dispId) return;
            MM.cerrar('modal-editar-grab');
            setTimeout(() => UI.abrirEditarDispositivo(dispId), 180);
        },

        guardarEdicionGrabador() {
            const prefijo = 'editar-grab';
            const descripcion = document.getElementById(`${prefijo}-nombre`).value.trim();
            if (!descripcion) { document.getElementById(`${prefijo}-nombre`).classList.add('error'); toast('La descripción es obligatoria', 'error'); return; }
            const dispId = document.getElementById(`${prefijo}-dispositivo-id`).value;
            if (!dispId) { document.getElementById(`${prefijo}-dispositivo-id`).classList.add('error'); toast('Seleccioná un dispositivo', 'error'); return; }
            if (!validarCampoIP(`${prefijo}-ip`)) return;

            const disp = _data.dispositivos.find(x => x.id === dispId);
            if (!disp) { toast('Dispositivo no encontrado', 'error'); return; }

            const grabActual = _data.grabadores.find(x => x.id === _edicion.grabId);
            if (grabActual) {
                const maxCanalOcupado = grabActual.canales_data
                    .filter(c => c.dispositivoId)
                    .reduce((max, c) => Math.max(max, c.canal), 0);
                if (maxCanalOcupado > 0 && (disp.canales || 0) < maxCanalOcupado) {
                    document.getElementById(`${prefijo}-dispositivo-id`).classList.add('error');
                    toast(`El dispositivo tiene ${disp.canales} canales pero el canal ${maxCanalOcupado} está ocupado. Elegí uno con al menos ${maxCanalOcupado} canales.`, 'error');
                    return;
                }
            }

            const datos = {
                id: _edicion.grabId,
                descripcion,
                tipo: disp.tipo,
                marca: disp.marca,
                modelo: disp.modelo,
                ip: document.getElementById(`${prefijo}-ip`).value.trim(),
                puerto: document.getElementById(`${prefijo}-puerto`).value.trim(),
                edificio: document.getElementById(`${prefijo}-edificio`).value.trim(),
                piso: S.normalizarPiso(document.getElementById(`${prefijo}-piso`).value),
                rack: document.getElementById(`${prefijo}-rack`).value.trim(),
                comentarios: document.getElementById(`${prefijo}-comentarios`).value.trim(),
                mac: disp.mac || '',
                canales: disp.canales || 16,
                dispositivoId: disp.id,
            };

            const idx = _data.grabadores.findIndex(x => x.id === _edicion.grabId);

            const nuevoSnapGrab = {
                descripcion: datos.descripcion,
                ip: datos.ip || '',
                puerto: datos.puerto || '',
                edificio: datos.edificio || '',
                piso: datos.piso || '',
                rack: datos.rack || '',
                comentarios: datos.comentarios || '',
                dispositivoId: datos.dispositivoId || '',
            };

            const huboCambiosGrab = JSON.stringify(nuevoSnapGrab) !== JSON.stringify(_edicion.snapshotGrab);
            if (!huboCambiosGrab) { toast('Sin cambios', 'info'); MM.cerrar('modal-editar-grab'); _edicion.grabId = null; _edicion.snapshotGrab = null; return; }

            historial.empujar('Editar grabador');

            if (idx !== -1) {
                datos.canales_data = _data.grabadores[idx].canales_data;
                _data.grabadores[idx] = S.sanitizarGrab(datos);
            }
            toast('Grabador actualizado', 'success');
            guardar(); render(); MM.cerrar('modal-editar-grab'); _edicion.grabId = null; _edicion.snapshotGrab = null;
        },

        async eliminarGrabador() {
            if (!_edicion.grabId) return;
            const g = _data.grabadores.find(x => x.id === _edicion.grabId);
            const ocupados = g ? g.canales_data.filter(c => c.dispositivoId).length : 0;
            const avisoExtra = ocupados > 0
                ? `\n¡Atención! Tiene ${ocupados} canal${ocupados === 1 ? '' : 'es'} ocupado${ocupados === 1 ? '' : 's'}. Las cámaras quedarán libres.`
                : '';

            const ok = await confirmarModal(`¿Eliminar el grabador "${g?.descripcion}"?${avisoExtra}`);
            if (!ok) return;

            historial.empujar('Eliminar grabador');

            _data.grabadores = _data.grabadores.filter(x => x.id !== _edicion.grabId);
            guardar(); render(); MM.cerrar('modal-editar-grab'); _edicion.grabId = null;
            toast('Grabador eliminado', 'success');
        },

        abrirAsignarCanal(grabId, nCanal, desdeDispId = null) {
            _edicion.canalGrabId = grabId;
            _edicion.canalN = nCanal;
            _edicion.canalDesdeDispId = desdeDispId || null;
            const g = _data.grabadores.find(x => x.id === grabId); if (!g) return;
            const slot = g.canales_data.find(c => c.canal === nCanal);

            document.getElementById('modal-canal-titulo').textContent = `Canal ${nCanal} — ${g.descripcion}`;

            const btnCancel = document.getElementById('btn-canal-cancelar');
            if (btnCancel) {
                if (desdeDispId) {
                    btnCancel.innerHTML = `<svg class="icon"><use href="#icon-undo"></use></svg><span>Volver</span>`;
                } else {
                    btnCancel.innerHTML = `<svg class="icon"><use href="#icon-cancelar"></use></svg><span>Cancelar</span>`;
                }
            }

            _edicion.canalDispOcupados = new Set(
                g.canales_data
                    .filter(c => c.canal !== nCanal && c.dispositivoId)
                    .map(c => c.dispositivoId)
            );

            const hiddenSel = document.getElementById('sel-canal-dispositivo');
            const input = document.getElementById('canal-disp-input');
            hiddenSel.value = slot?.dispositivoId || '';
            if (slot?.dispositivoId) {
                const d = _data.dispositivos.find(x => x.id === slot.dispositivoId);
                input.value = d ? (d.mac || d.serial || d.id) : '';
            } else {
                input.value = '';
            }
            document.getElementById('canal-disp-dropdown').style.display = 'none';
            _edicion.canalDispHighlight = -1;

            ModalLock.reset('modal-canal');
            MM.abrir('modal-canal', { onEscape: () => UI.cerrarModalCanal() });

            _edicion.snapshotCanal = {
                dispositivoId: slot?.dispositivoId || '',
                descripcion: slot?.descripcion || '',
                ip: slot?.ip || '',
                puerto: slot?.puerto || '',
                edificio: slot?.edificio || '',
                piso: slot?.piso || '',
                rack: slot?.rack || '',
                comentarios: slot?.comentarios || '',
            };

            document.getElementById('canal-descripcion').value = slot?.descripcion || '';
            document.getElementById('canal-ip').value = slot?.ip || '';
            document.getElementById('canal-puerto').value = slot?.puerto || '';
            _poblarSelectEdificio('canal-edificio', slot?.edificio || '');
            document.getElementById('canal-piso').value = slot?.piso || '';
            document.getElementById('canal-rack').value = slot?.rack || '';
            document.getElementById('canal-comentarios').value = slot?.comentarios || '';
            const btnVerActivo = document.getElementById('btn-ver-activo-canal');
            btnVerActivo.style.display = slot?.dispositivoId ? '' : 'none';
        },

        _canalDispFiltrar() {
            document.getElementById('canal-disp-input').classList.remove('error');
            const query = document.getElementById('canal-disp-input').value.trim().toLowerCase();
            const dd = document.getElementById('canal-disp-dropdown');
            const hidden = document.getElementById('sel-canal-dispositivo');

            if (!query) hidden.value = '';

            const candidatos = _data.dispositivos
                .filter(d => !['nvr', 'dvr'].includes(d.tipo))
                .sort((a, b) => (a.mac || a.serial || '').localeCompare(b.mac || b.serial || ''));

            const filtrados = query
                ? candidatos.filter(d => {
                    const haystack = [d.mac, d.serial, d.marca, d.modelo, d.patrimonio]
                        .filter(Boolean).join(' ').toLowerCase();
                    return haystack.includes(query);
                })
                : candidatos;

            if (!filtrados.length && query) {
                dd.innerHTML = `<div class="canal-disp-item canal-disp-item-vaciobtn">Sin resultados</div>`;
                dd.style.display = '';
                _edicion.canalDispHighlight = -1;
                return;
            }

            const items = [];
            items.push(`<div class="canal-disp-item canal-disp-item-vaciobtn" data-id="" data-idx="0">— Vacío —</div>`);

            const ESTADO_LABELS_DISP = { averiado: 'averiado', revisar: 'a revisar', desafectado: 'desafectado' };
            filtrados.forEach((d, i) => {
                const ocupado = _edicion.canalDispOcupados.has(d.id);
                const estadoInactivo = ESTADO_LABELS_DISP[d.estado] || '';
                const deshabilitado = ocupado || !!estadoInactivo;
                const mac = esc(d.mac || d.serial || d.id);
                const formaLabel = d.forma ? d.forma.replace(/-/g, ' ') : '';
                const sub = [formaLabel, d.modelo].filter(Boolean).join(' · ');
                const tipo = S.TIPOS[d.tipo];
                const etiqueta = ocupado
                    ? ' <span class="estado-tag">(ocupado)</span>'
                    : estadoInactivo
                        ? ` <span class="estado-tag">(${estadoInactivo})</span>`
                        : '';
                const titleAttr = ocupado
                    ? 'title="Ya asignado a otro canal"'
                    : estadoInactivo
                        ? `title="No disponible: ${estadoInactivo}"`
                        : '';
                items.push(`<div class="canal-disp-item${deshabilitado ? ' ocupado' : ''}" data-id="${esc(d.id)}" data-mac="${esc(d.mac || d.serial || '')}" data-idx="${i + 1}" ${titleAttr}>
                            <div class="canal-disp-item-mac">${tipo?.emoji || ''} ${mac}${etiqueta}</div>
                            ${sub ? `<div class="canal-disp-item-sub">${esc(sub)}</div>` : ''}
                        </div>`);
            });

            dd.innerHTML = items.join('');
            dd.style.display = '';
            _edicion.canalDispHighlight = -1;

            dd.querySelectorAll('.canal-disp-item:not(.ocupado)').forEach(el => {
                el.addEventListener('mousedown', e => {
                    e.preventDefault();
                    UI._canalDispSeleccionar(el.dataset.id, el.dataset.mac);
                });
            });
        },

        _canalDispSeleccionar(id, mac) {
            document.getElementById('sel-canal-dispositivo').value = id || '';
            document.getElementById('canal-disp-input').value = id ? (mac || id) : '';
            document.getElementById('canal-disp-dropdown').style.display = 'none';
            _edicion.canalDispHighlight = -1;
            const btn = document.getElementById('btn-ver-activo-canal');
            if (btn) btn.style.display = id ? '' : 'none';
        },

        _canalDispKeydown(e) {
            const dd = document.getElementById('canal-disp-dropdown');
            if (dd.style.display === 'none') return;
            const items = [...dd.querySelectorAll('.canal-disp-item:not(.ocupado)')];
            if (!items.length) return;

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                _edicion.canalDispHighlight = Math.min(_edicion.canalDispHighlight + 1, items.length - 1);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                _edicion.canalDispHighlight = Math.max(_edicion.canalDispHighlight - 1, 0);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (_edicion.canalDispHighlight >= 0) {
                    const el = items[_edicion.canalDispHighlight];
                    UI._canalDispSeleccionar(el.dataset.id, el.dataset.mac);
                }
                return;
            } else if (e.key === 'Escape') {
                dd.style.display = 'none';
                _edicion.canalDispHighlight = -1;
                return;
            } else { return; }

            items.forEach((el, i) => el.classList.toggle('highlighted', i === _edicion.canalDispHighlight));
            if (_edicion.canalDispHighlight >= 0) items[_edicion.canalDispHighlight].scrollIntoView({ block: 'nearest' });
        },

        _pisoFiltrar(el) {
            const pos = el.selectionStart;
            const anterior = el.value;
            const limpio = anterior.toUpperCase().replace(/[^0-9\-PBES]/g, '');
            if (limpio !== anterior) {
                el.value = limpio;
                const nuevaPos = Math.max(0, pos - (anterior.length - limpio.length));
                el.setSelectionRange(nuevaPos, nuevaPos);
            }
        },

        cerrarModalCanal() {
            MM.cerrar('modal-canal');
            const dispId = _edicion.canalDesdeDispId;
            _edicion.canalGrabId = null; _edicion.canalN = null; _edicion.canalDesdeDispId = null;
            if (dispId) setTimeout(() => UI.abrirEditarDispositivo(dispId), 180);
        },

        verActivoDesdeCanal() {
            const dispId = document.getElementById('sel-canal-dispositivo').value;
            if (!dispId) return;
            _edicion.volverDesdeCanal = true;
            MM.cerrar('modal-canal');
            setTimeout(() => UI.abrirEditarDispositivo(dispId), 180);
        },

        limpiarAsignacionCanal() {
            UI._canalDispSeleccionar('', '');
            document.getElementById('canal-descripcion').value = '';
            document.getElementById('canal-ip').value = '';
            document.getElementById('canal-puerto').value = '';
            _poblarSelectEdificio('canal-edificio', '');
            document.getElementById('canal-piso').value = '';
            document.getElementById('canal-rack').value = '';
            document.getElementById('canal-comentarios').value = '';
            document.getElementById('btn-ver-activo-canal').style.display = 'none';
        },

        guardarAsignacionCanal() {
            const g = _data.grabadores.find(x => x.id === _edicion.canalGrabId); if (!g) return;
            const slot = g.canales_data.find(c => c.canal === _edicion.canalN); if (!slot) return;

            const dispInput = document.getElementById('canal-disp-input');
            const dispId = document.getElementById('sel-canal-dispositivo').value;
            const textoInput = dispInput.value.trim();
            if (textoInput && !dispId) {
                dispInput.classList.add('error');
                toast('Seleccioná un dispositivo de la lista', 'error');
                return;
            }
            if (dispId) {
                const d = _data.dispositivos.find(x => x.id === dispId);
                const expectedText = d ? (d.mac || d.serial || d.id) : '';
                if (!d || textoInput !== expectedText) {
                    document.getElementById('sel-canal-dispositivo').value = '';
                    dispInput.classList.add('error');
                    toast('Seleccioná un dispositivo de la lista', 'error');
                    return;
                }
            }
            dispInput.classList.remove('error');
            if (!validarCampoIP('canal-ip')) return;

            const inputIp = document.getElementById('canal-ip');
            const inputDesc = document.getElementById('canal-descripcion');
            const nuevaIp = inputIp.value.trim();
            const nuevaDesc = inputDesc.value.trim().toLowerCase();

            inputIp.classList.remove('error');
            inputDesc.classList.remove('error');

            for (const c of g.canales_data) {

                if (c.canal === _edicion.canalN) continue;

                if (nuevaIp && c.ip === nuevaIp) {
                    inputIp.classList.add('error');
                    toast(`IP duplicada: ya está en uso en el canal ${c.canal} de este grabador`, 'error');
                    return;
                }

                if (nuevaDesc && c.descripcion && c.descripcion.toLowerCase() === nuevaDesc) {
                    inputDesc.classList.add('error');
                    toast(`Descripción duplicada: ya está en uso en el canal ${c.canal} de este grabador`, 'error');
                    return;
                }
            }

            const nuevoSnapCanal = {
                dispositivoId: document.getElementById('sel-canal-dispositivo').value || '',
                descripcion: document.getElementById('canal-descripcion').value.trim(),
                ip: document.getElementById('canal-ip').value.trim(),
                puerto: document.getElementById('canal-puerto').value.trim(),
                edificio: document.getElementById('canal-edificio').value.trim(),
                piso: S.normalizarPiso(document.getElementById('canal-piso').value),
                rack: document.getElementById('canal-rack').value.trim(),
                comentarios: document.getElementById('canal-comentarios').value.trim(),
            };
            const huboCambiosCanal = JSON.stringify(nuevoSnapCanal) !== JSON.stringify(_edicion.snapshotCanal);
            if (!huboCambiosCanal) { toast('Sin cambios', 'info'); MM.cerrar('modal-canal'); _edicion.canalGrabId = null; _edicion.canalN = null; _edicion.snapshotCanal = null; return; }

            const fueAsignado = !_edicion.snapshotCanal.dispositivoId && nuevoSnapCanal.dispositivoId;
            const fueDesasignado = _edicion.snapshotCanal.dispositivoId && !nuevoSnapCanal.dispositivoId;
            const msg = fueAsignado ? 'Dispositivo asignado' : fueDesasignado ? 'Canal liberado' : 'Canal actualizado';

            historial.empujar(msg);

            Object.assign(slot, nuevoSnapCanal, {
                dispositivoId: nuevoSnapCanal.dispositivoId || null,
            });
            guardar(); render(); MM.cerrar('modal-canal');

            toast(msg, 'success');
            _edicion.canalGrabId = null; _edicion.canalN = null; _edicion.snapshotCanal = null;
        },

        _limpiarFormOtroProd(prefijo) {
            document.getElementById(`${prefijo}-descripcion`).value = '';
            document.getElementById(`${prefijo}-ip`).value = '';
            document.getElementById(`${prefijo}-puerto`).value = '';
            _poblarSelectEdificio(`${prefijo}-edificio`, '');
            document.getElementById(`${prefijo}-piso`).value = '';
            document.getElementById(`${prefijo}-rack`).value = '';
            document.getElementById(`${prefijo}-comentarios`).value = '';
            document.getElementById(`sel-${prefijo}-dispositivo`).value = '';
            document.getElementById(`${prefijo}-disp-input`).value = '';
            document.getElementById(`${prefijo}-disp-input`).classList.remove('error');
            document.getElementById(`${prefijo}-disp-dropdown`).style.display = 'none';
        },

        abrirNuevoOtroProd() {
            _edicion.otroProdId = null;
            _edicion.snapshotOtroProd = null;
            this._limpiarFormOtroProd('nuevo-otro-prod');

            const grabs = _data.grabadores;
            const idsOcupados = [
                ...grabs.flatMap(g => g.canales_data.filter(c => c.dispositivoId).map(c => c.dispositivoId)),
                ...grabs.filter(g => g.dispositivoId).map(g => g.dispositivoId),
                ...(_data.otros_prod || []).filter(o => o.dispositivoId).map(o => o.dispositivoId)
            ];
            _edicion.canalDispOcupados = new Set(idsOcupados);

            MM.abrir('modal-nuevo-otro-prod');
        },

        cerrarNuevoOtroProd() {
            MM.cerrar('modal-nuevo-otro-prod');
        },

        abrirEditarOtroProd(id) {
            const o = (_data.otros_prod || []).find(x => x.id === id); if (!o) return;
            _edicion.otroProdId = id;
            const prefijo = 'editar-otro-prod';

            document.getElementById(`${prefijo}-descripcion`).value = o.descripcion || '';
            document.getElementById(`${prefijo}-ip`).value = o.ip || '';
            document.getElementById(`${prefijo}-puerto`).value = o.puerto || '';
            _poblarSelectEdificio(`${prefijo}-edificio`, o.edificio || '');
            document.getElementById(`${prefijo}-piso`).value = o.piso || '';
            document.getElementById(`${prefijo}-rack`).value = o.rack || '';
            document.getElementById(`${prefijo}-comentarios`).value = o.comentarios || '';

            const hiddenSel = document.getElementById(`sel-${prefijo}-dispositivo`);
            const input = document.getElementById(`${prefijo}-disp-input`);
            input.classList.remove('error');

            hiddenSel.value = o.dispositivoId || '';
            if (o.dispositivoId) {
                const d = _data.dispositivos.find(x => x.id === o.dispositivoId);
                input.value = d ? (d.mac || d.serial || d.id) : '';
            } else {
                input.value = '';
            }
            document.getElementById(`${prefijo}-disp-dropdown`).style.display = 'none';
            document.getElementById('btn-ver-activo-otro-prod').style.display = o.dispositivoId ? '' : 'none';

            const grabs = _data.grabadores;
            const idsOcupados = [
                ...grabs.flatMap(g => g.canales_data.filter(c => c.dispositivoId).map(c => c.dispositivoId)),
                ...grabs.filter(g => g.dispositivoId).map(g => g.dispositivoId),
                ...(_data.otros_prod || []).filter(op => op.dispositivoId && op.id !== id).map(op => op.dispositivoId)
            ];
            _edicion.canalDispOcupados = new Set(idsOcupados);

            ModalLock.reset('modal-editar-otro-prod');
            MM.abrir('modal-editar-otro-prod');

            _edicion.snapshotOtroProd = {
                dispositivoId: o.dispositivoId || '',
                descripcion: o.descripcion || '',
                ip: o.ip || '',
                puerto: o.puerto || '',
                edificio: o.edificio || '',
                piso: o.piso || '',
                rack: o.rack || '',
                comentarios: o.comentarios || '',
            };
        },

        cerrarEditarOtroProd() {
            MM.cerrar('modal-editar-otro-prod');
            _edicion.otroProdId = null;
            _edicion.snapshotOtroProd = null;
        },

        guardarOtroProd(prefijo) {
            const dispId = document.getElementById(`sel-${prefijo}-dispositivo`).value;
            const dispInput = document.getElementById(`${prefijo}-disp-input`);

            if (!dispId) {
                dispInput.classList.add('error');
                toast('Seleccioná un dispositivo de la lista', 'error');
                return;
            }
            dispInput.classList.remove('error');
            if (!validarCampoIP(`${prefijo}-ip`)) return;

            const datos = {
                id: _edicion.otroProdId || S.genId(),
                dispositivoId: dispId,
                descripcion: document.getElementById(`${prefijo}-descripcion`).value.trim(),
                ip: document.getElementById(`${prefijo}-ip`).value.trim(),
                puerto: document.getElementById(`${prefijo}-puerto`).value.trim(),
                edificio: document.getElementById(`${prefijo}-edificio`).value.trim(),
                piso: S.normalizarPiso(document.getElementById(`${prefijo}-piso`).value),
                rack: document.getElementById(`${prefijo}-rack`).value.trim(),
                comentarios: document.getElementById(`${prefijo}-comentarios`).value.trim(),
            };

            historial.empujar(_edicion.otroProdId ? 'Editar dispositivo en producción' : 'Agregar dispositivo a producción');

            if (!_data.otros_prod) _data.otros_prod = [];

            if (_edicion.otroProdId) {
                const nuevoSnapOtro = {
                    dispositivoId: datos.dispositivoId || '', descripcion: datos.descripcion || '', ip: datos.ip || '', puerto: datos.puerto || '', edificio: datos.edificio || '', piso: datos.piso || '', rack: datos.rack || '', comentarios: datos.comentarios || '',
                };
                if (JSON.stringify(nuevoSnapOtro) === JSON.stringify(_edicion.snapshotOtroProd)) {
                    toast('Sin cambios', 'info'); MM.cerrar('modal-editar-otro-prod'); _edicion.otroProdId = null; _edicion.snapshotOtroProd = null; return;
                }
                const idx = _data.otros_prod.findIndex(x => x.id === _edicion.otroProdId);
                if (idx !== -1) _data.otros_prod[idx] = S.sanitizarOtroProd(datos);
                toast('Actualizado', 'success');
                MM.cerrar('modal-editar-otro-prod');
            } else {
                _data.otros_prod.push(S.sanitizarOtroProd(datos));
                toast('Agregado a producción', 'success');
                MM.cerrar('modal-nuevo-otro-prod');
            }

            guardar(); render();
        },

        async eliminarOtroProd() {
            if (!_edicion.otroProdId) return;
            const ok = await confirmarModal('¿Quitar este dispositivo de producción? No se eliminará del inventario, solo se desasignará.', 'Quitar');
            if (!ok) return;

            historial.empujar('Quitar dispositivo de producción');
            _data.otros_prod = _data.otros_prod.filter(x => x.id !== _edicion.otroProdId);

            guardar(); render(); MM.cerrar('modal-editar-otro-prod');
            toast('Quitado de producción', 'success');
        },

        _otroProdDispFiltrar(prefijo) {
            const input = document.getElementById(`${prefijo}-disp-input`);
            const hidden = document.getElementById(`sel-${prefijo}-dispositivo`);
            const dd = document.getElementById(`${prefijo}-disp-dropdown`);
            input.classList.remove('error');

            const query = input.value.trim().toLowerCase();
            if (!query) hidden.value = '';

            const candidatos = _data.dispositivos.sort((a, b) => (a.mac || a.serial || '').localeCompare(b.mac || b.serial || ''));
            const filtrados = query ? candidatos.filter(d => {
                return [d.mac, d.serial, d.marca, d.modelo, d.patrimonio].filter(Boolean).join(' ').toLowerCase().includes(query);
            }) : candidatos;

            if (!filtrados.length && query) {
                dd.innerHTML = `<div class="canal-disp-item canal-disp-item-vaciobtn">Sin resultados</div>`;
                dd.style.display = ''; return;
            }

            const ESTADO_LABELS_DISP = { averiado: 'averiado', revisar: 'a revisar', desafectado: 'desafectado' };
            const items = filtrados.map(d => {
                const ocupado = _edicion.canalDispOcupados.has(d.id);
                const estadoInactivo = ESTADO_LABELS_DISP[d.estado] || '';
                const deshabilitado = ocupado || !!estadoInactivo;
                const etiqueta = ocupado ? ' <span class="estado-tag">(en uso)</span>' : estadoInactivo ? ` <span class="estado-tag">(${estadoInactivo})</span>` : '';
                const sub = [d.forma ? d.forma.replace(/-/g, ' ') : '', d.modelo].filter(Boolean).join(' · ');

                return `<div class="canal-disp-item${deshabilitado ? ' ocupado' : ''}" data-id="${esc(d.id)}" data-mac="${esc(d.mac || d.serial || '')}">
                            <div class="canal-disp-item-mac">${S.TIPOS[d.tipo]?.emoji || ''} ${esc(d.mac || d.serial || d.id)}${etiqueta}</div>
                            ${sub ? `<div class="canal-disp-item-sub">${esc(sub)}</div>` : ''}
                        </div>`;
            });

            dd.innerHTML = items.join('');
            dd.style.display = '';

            dd.querySelectorAll('.canal-disp-item:not(.ocupado)').forEach(el => {
                el.addEventListener('mousedown', e => {
                    e.preventDefault();
                    hidden.value = el.dataset.id;
                    input.value = el.dataset.mac || el.dataset.id;
                    dd.style.display = 'none';
                    if(prefijo === 'editar-otro-prod') document.getElementById('btn-ver-activo-otro-prod').style.display = '';
                });
            });
        },

        _otroProdDispKeydown(e, prefijo) {
            const dd = document.getElementById(`${prefijo}-disp-dropdown`);
            if (dd.style.display === 'none') return;
            const items = [...dd.querySelectorAll('.canal-disp-item:not(.ocupado)')];
            if (!items.length) return;

            if (e.key === 'ArrowDown') {
                e.preventDefault(); _edicion.canalDispHighlight = Math.min(_edicion.canalDispHighlight + 1, items.length - 1);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault(); _edicion.canalDispHighlight = Math.max(_edicion.canalDispHighlight - 1, 0);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (_edicion.canalDispHighlight >= 0) {
                    const el = items[_edicion.canalDispHighlight];
                    document.getElementById(`sel-${prefijo}-dispositivo`).value = el.dataset.id;
                    document.getElementById(`${prefijo}-disp-input`).value = el.dataset.mac || el.dataset.id;
                    dd.style.display = 'none';
                    if(prefijo === 'editar-otro-prod') document.getElementById('btn-ver-activo-otro-prod').style.display = '';
                }
                return;
            } else if (e.key === 'Escape') {
                dd.style.display = 'none'; _edicion.canalDispHighlight = -1; return;
            } else { return; }

            items.forEach((el, i) => el.classList.toggle('highlighted', i === _edicion.canalDispHighlight));
            if (_edicion.canalDispHighlight >= 0) items[_edicion.canalDispHighlight].scrollIntoView({ block: 'nearest' });
        },

        verActivoDesdeOtroProd() {
            const dispId = document.getElementById('sel-editar-otro-prod-dispositivo').value;
            if (!dispId) return;
            _edicion.volverDesdeCanal = true;
            _edicion.canalGrabId = 'OTRO_PROD';
            _edicion.canalN = _edicion.otroProdId;
            MM.cerrar('modal-editar-otro-prod');
            setTimeout(() => UI.abrirEditarDispositivo(dispId), 180);
        },

        abrirImportar() {
            document.getElementById('file-import').value = '';
            document.getElementById('importar-dropzone-label').textContent = 'Seleccioná o arrastrá un archivo .json';
            document.getElementById('importar-dropzone').style.borderColor = '';
            document.getElementById('btn-combinar').disabled = true;
            document.getElementById('btn-reemplazar').disabled = true;
            _importarParsed = null;

            MM.abrir('modal-importar', {
                cb: () => {

                    setTimeout(() => {
                        document.getElementById('file-import').click();
                    }, 400);
                }
            });
        },

        cerrarImportar() { MM.cerrar('modal-importar'); },

        onImportarFileChange(e) {
            const file = e.target.files[0];
            if (!file) return;
            const label = document.getElementById('importar-dropzone-label');
            const zone = document.getElementById('importar-dropzone');
            const btnComb = document.getElementById('btn-combinar');
            const btnReem = document.getElementById('btn-reemplazar');

            if (file.size > S.MAX_JSON) {
                _importarParsed = null;
                label.innerHTML = `<span class="import-fail">✗ Archivo demasiado grande</span><span class="import-sub">Máximo permitido: 4 MB.</span>`;
                zone.style.borderColor = 'var(--c-red)';
                btnComb.disabled = true; btnReem.disabled = true;
                return;
            }

            const reader = new FileReader();
            reader.onload = async ev => {
                try {
                    const contenido = ev.target.result;
                    const data = S.safeParse(contenido);
                    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Estructura inválida');

                    const newDisps = Array.isArray(data.dispositivos) ? data.dispositivos.map(d => S.sanitizarDisp(d, data.tiposCustom || {})).filter(Boolean) : [];
                    const newGrabs = Array.isArray(data.grabadores) ? data.grabadores.map(g => S.sanitizarGrab(g)).filter(Boolean) : [];

                    let esValida = true;
                    if (data.hash) {
                        esValida = await S.verificarFirma(data);
                    }

                    _importarParsed = { ...data, _disps: newDisps, _grabs: newGrabs, _valida: esValida };

                    const textoAlerta = !esValida ? `<span class="import-warn">⚠️ Archivo alterado externamente</span>` : '';
                    label.innerHTML = `<span class="import-ok">✓ ${esc(file.name)}</span><span class="import-sub">${newDisps.length} dispositivos · ${newGrabs.length} grabadores</span>${textoAlerta}`;
                    zone.style.borderColor = !esValida ? 'var(--c-orange)' : 'var(--c-green)';

                    btnComb.disabled = false; btnReem.disabled = false;
                } catch (err) {
                    _importarParsed = null;
                    label.innerHTML = `<span class="import-fail">✗ Archivo inválido</span><span class="import-sub">No tiene el formato correcto o está dañado.</span>`;
                    zone.style.borderColor = 'var(--c-red)';
                    btnComb.disabled = true; btnReem.disabled = true;
                }
            };
            reader.readAsText(file);
        },

        async importarDatos(modo) {
            if (!_importarParsed) { toast('Seleccioná un archivo válido', 'error'); return; }
            const data = _importarParsed;

            if (!data._valida) {
                const ok = await confirmarModal('El hash de integridad no coincide. El archivo puede haber sido modificado. ¿Importar de todas formas?', 'Importar');
                if (!ok) return;
            }

            historial.empujar(modo === 'replace' ? 'Reemplazar datos (Importar)' : 'Combinar datos (Importar)');

            const newDisps = data._disps;
            const newGrabs = data._grabs;
            const newOtros = (data.otros_prod || []).map(S.sanitizarOtroProd).filter(Boolean);

            if (data.tiposCustom && typeof data.tiposCustom === 'object' && !Array.isArray(data.tiposCustom)) {
                Object.entries(data.tiposCustom).forEach(([k, v]) => {
                    if (S.TIPOS_BUILTIN[k]) return;
                    if (typeof v?.label !== 'string' || !v.label) return;
                    if (modo === 'replace' || !S.TIPOS[k]) {
                        S.TIPOS[k] = { label: v.label, emoji: v.emoji || '📦', badge: 'badge-otro', dot: 'var(--c-gold)', builtin: false };
                    }
                });
                S.guardarTipos();
            }

            if (Array.isArray(data.edificios)) {
                const nuevos = data.edificios
                    .filter(e => typeof e === 'string' && e.trim().length > 0)
                    .map(e => S.sanitize(e.trim(), 60));
                if (modo === 'replace') {
                    S.edificios.length = 0;
                    nuevos.forEach(e => S.edificios.push(e));
                } else {
                    const existentes = new Set(S.edificios.map(e => e.toLowerCase()));
                    nuevos.forEach(e => {
                        if (!existentes.has(e.toLowerCase())) {
                            S.edificios.push(e);
                            existentes.add(e.toLowerCase());
                        }
                    });
                }
                S.guardarEdificios();
            }

            if (modo === 'replace') {
                _data.dispositivos = newDisps;
                _data.grabadores = newGrabs;
                _data.otros_prod = newOtros;
                toast('Datos reemplazados correctamente', 'success');
            } else {
                // Reusar _combinarDatosRemotos pasando los datos ya sanitizados como si fuera un remoto
                const pseudoRemoto = {
                    dispositivos: newDisps,
                    grabadores: newGrabs,
                    otros_prod: newOtros,
                    tiposCustom: {},   // ya aplicados arriba
                    edificios: [],     // ya aplicados arriba
                };
                const resMerge = GistSync._combinarEntidades(pseudoRemoto);

                const msgs = [];
                if (resMerge.cDispsAdd) msgs.push(`+${resMerge.cDispsAdd} disp`);
                if (resMerge.cDispsUpd) msgs.push(`~${resMerge.cDispsUpd} disp`);
                if (resMerge.cGrabsAdd) msgs.push(`+${resMerge.cGrabsAdd} grab`);
                if (resMerge.cGrabsUpd) msgs.push(`~${resMerge.cGrabsUpd} grab`);
                if (resMerge.cOtrosAdd) msgs.push(`+${resMerge.cOtrosAdd} otros`);
                if (resMerge.cOtrosUpd) msgs.push(`~${resMerge.cOtrosUpd} otros`);

                toast(msgs.length ? `Datos combinados (${msgs.join(', ')})` : 'Sin datos nuevos para combinar', msgs.length ? 'success' : 'info');
            }

            guardar(); render(); MM.cerrar('modal-importar');
        },

        async exportarJSON() {
            try {
                const payload = await GistSync._generarPayload();

                const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = Object.assign(document.createElement('a'), { href: url, download: `CCTV_${S.fechaISO().slice(0, 10)}.json` });
                a.click();
                URL.revokeObjectURL(url);
                toast('Datos exportados', 'success');
            } catch (err) {
                console.error(err);
                toast('Error al exportar', 'error');
            }
        },
    };


    // ════════════════════════════════════════════════════════════════════════════
    // § DOM HELPERS — populadores de selects, limpieza de formularios
    // ════════════════════════════════════════════════════════════════════════════
    function _sincronizarGrabadores(dispId) {
        const disp = _data.dispositivos.find(d => d.id === dispId);
        if (!disp) return;
        _data.grabadores.forEach((g, i) => {
            if (g.dispositivoId !== dispId) return;
            const datos = {
                ...g,
                tipo: disp.tipo,
                marca: disp.marca,
                modelo: disp.modelo,
                mac: disp.mac || '',
                canales: disp.canales || g.canales_n,
                canales_data: g.canales_data,
            };
            _data.grabadores[i] = S.sanitizarGrab(datos);
        });
    }

    function _poblarSelectTipo(prefijo, seleccionado) {
        const sel = document.getElementById(`${prefijo}-tipo`);
        sel.innerHTML = '<option value="">Seleccionar…</option>';
        Object.entries(S.TIPOS).forEach(([k, v]) => {
            const opt = document.createElement('option');
            opt.value = k;
            opt.textContent = `${v.emoji} ${v.label}`;
            if (k === seleccionado) opt.selected = true;
            sel.appendChild(opt);
        });
    }

    function _poblarSelectEdificio(selectId, seleccionado) {
        const sel = document.getElementById(selectId);
        if (!sel) return;

        const inputPisoId = selectId.replace('-edificio', '-piso');
        const inputPiso = document.getElementById(inputPisoId);

        function _validarEstadoPiso() {
            if (!inputPiso) return;

            // Si el modal está bloqueado (edificio select disabled), no alterar el estado del piso
            if (sel.disabled) return;

            const sinEdificio = !sel.value || sel.value === '__agregar__';
            inputPiso.disabled = sinEdificio;

            if (sinEdificio) {
                inputPiso.value = '';

                if (!inputPiso.hasAttribute('data-ph')) {
                    inputPiso.setAttribute('data-ph', inputPiso.placeholder);
                }
                inputPiso.placeholder = 'Requiere edificio';
            } else {

                if (inputPiso.hasAttribute('data-ph')) {
                    inputPiso.placeholder = inputPiso.getAttribute('data-ph');
                }
            }
        }

        sel.onchange = null;
        sel.innerHTML = '<option value="">— Sin edificio —</option>';
        S.edificios.forEach(nombre => {
            const opt = document.createElement('option');
            opt.value = nombre;
            opt.textContent = nombre;
            if (nombre === seleccionado) opt.selected = true;
            sel.appendChild(opt);
        });
        if (seleccionado && !S.edificios.includes(seleccionado)) {
            const opt = document.createElement('option');
            opt.value = seleccionado;
            opt.textContent = seleccionado + ' (personalizado)';
            opt.selected = true;
            sel.appendChild(opt);
        }
        const optAgregar = document.createElement('option');
        optAgregar.value = '__agregar__';
        optAgregar.textContent = '＋ Agregar edificio…';
        sel.appendChild(optAgregar);

        requestAnimationFrame(() => {
            _validarEstadoPiso();
        });

        sel.onchange = function () {
            if (sel.value === '__agregar__') {
                sel.value = seleccionado || '';
                let origen = 'canal';
                if (selectId.startsWith('nuevo-grab')) origen = 'nuevo-grab';
                else if (selectId.startsWith('editar-grab')) origen = 'editar-grab';
                else if (selectId.startsWith('nuevo-otro-prod')) origen = 'nuevo-otro-prod';
                    else if (selectId.startsWith('editar-otro-prod')) origen = 'editar-otro-prod';
                UI.abrirEdificios(origen);
            } else {
                seleccionado = sel.value;
            }

            _validarEstadoPiso();
        };
    }

    function _poblarSelectorGrabador(prefijo, seleccionadoId, minCanales = 0) {
        const sel = document.getElementById(`${prefijo}-dispositivo-id`);
        const enUso = new Set(
            _data.grabadores
                .filter(g => g.dispositivoId && g.id !== _edicion.grabId)
                .map(g => g.dispositivoId)
        );
        sel.innerHTML = '<option value="">Seleccionar…</option>';
        _data.dispositivos
            .filter(d => ['nvr', 'dvr'].includes(d.tipo))
            .sort((a, b) => (a.mac || a.serial || '').localeCompare(b.mac || b.serial || ''))
            .forEach(d => {
                const opt = document.createElement('option');
                opt.value = d.id;
                const canalesDisp = d.canales || 0;
                const canalesStr = canalesDisp ? ` · ${canalesDisp} ch` : '';
                const label = d.mac || d.serial || d.id;
                const marcaModelo = d.modelo || '';
                opt.textContent = `${d.tipo === 'nvr' ? '📟' : '📼'} ${label}${marcaModelo ? ' · ' + marcaModelo : ''}${canalesStr}`;
                if (enUso.has(d.id)) {
                    opt.disabled = true; opt.textContent += ' (en uso)';
                } else if (minCanales > 0 && canalesDisp < minCanales) {
                    opt.disabled = true; opt.textContent += ` (insuficiente, mín. ${minCanales} ch)`;
                }
                if (d.id === seleccionadoId) opt.selected = true;
                sel.appendChild(opt);
            });
        if (sel.options.length === 1) {
            const opt = document.createElement('option');
            opt.disabled = true;
            opt.textContent = 'No hay NVR/DVR en activos';
            sel.appendChild(opt);
        }
    }

    function _limpiarFormDisp(prefijo) {
        [`${prefijo}-marca`, `${prefijo}-modelo`, `${prefijo}-serial`, `${prefijo}-mac`, `${prefijo}-patrimonio`].forEach(id => {
            const el = document.getElementById(id); if (el) { el.value = ''; el.classList.remove('error'); }
        });
        const tipoEl = document.getElementById(`${prefijo}-tipo`);
        tipoEl.value = ''; tipoEl.classList.remove('error');
        document.getElementById(`${prefijo}-forma`).value = '';
        document.getElementById(`${prefijo}-forma-group`).style.display = 'none';
        document.getElementById(`${prefijo}-canales`).value = '16';
        document.getElementById(`${prefijo}-canales-group`).style.display = 'none';
    }

    function _limpiarFormGrab(prefijo) {
        [`${prefijo}-nombre`, `${prefijo}-ip`, `${prefijo}-puerto`, `${prefijo}-piso`, `${prefijo}-rack`].forEach(id => {
            const el = document.getElementById(id); if (el) { el.value = ''; el.classList.remove('error'); }
        });
        document.getElementById(`${prefijo}-dispositivo-id`).value = '';
    }

    document.addEventListener('input', e => { if (e.target.tagName === 'INPUT') e.target.classList.remove('error'); });

    document.addEventListener('mousedown', e => {

        const cbCanal = document.getElementById('canal-disp-combobox');
        if (cbCanal && !cbCanal.contains(e.target)) {
            document.getElementById('canal-disp-dropdown').style.display = 'none';
            _edicion.canalDispHighlight = -1;
        }

        const cbNuevoOtro = document.querySelector('#modal-nuevo-otro-prod .combobox-wrap');
        if (cbNuevoOtro && !cbNuevoOtro.contains(e.target)) {
            const ddNuevoOtro = document.getElementById('nuevo-otro-prod-disp-dropdown');
            if (ddNuevoOtro) ddNuevoOtro.style.display = 'none';
            _edicion.canalDispHighlight = -1;
        }

        const cbEditarOtro = document.querySelector('#modal-editar-otro-prod .combobox-wrap');
        if (cbEditarOtro && !cbEditarOtro.contains(e.target)) {
            const ddEditarOtro = document.getElementById('editar-otro-prod-disp-dropdown');
            if (ddEditarOtro) ddEditarOtro.style.display = 'none';
            _edicion.canalDispHighlight = -1;
        }

        const wrapActivos = document.getElementById('btn-vista-activos-wrap');
        const ddActivos = document.getElementById('dropdown-vista-activos');
        if (wrapActivos && ddActivos && !wrapActivos.contains(e.target)) {
            ddActivos.style.display = 'none';
        }
    });

    document.getElementById('card-resumen-general').addEventListener('mousedown', e => {
        if (!_dash.tipoAbierto) return;
        if (!e.target.closest('#dash-disp-tree')) {
            _dash.tipoAbierto = null;
            renderDashboard();
        }
    });

    const dz = document.getElementById('importar-dropzone');
    if (dz) {
        dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('importar-dropzone-drag'); });
        dz.addEventListener('dragleave', () => dz.classList.remove('importar-dropzone-drag'));
        dz.addEventListener('drop', e => {
            e.preventDefault();
            dz.classList.remove('importar-dropzone-drag');
            const file = e.dataTransfer.files[0];
            if (file) {
                const dt = new DataTransfer(); dt.items.add(file);
                document.getElementById('file-import').files = dt.files;
                UI.onImportarFileChange({ target: { files: [file] } });
            }
        });
    }

    document.addEventListener('keydown', e => {
        const tag = document.activeElement?.tagName;
        const enInput = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
        const modalAbierto = document.body.classList.contains('modal-open');

        if (e.key === 'Enter' && modalAbierto && tag !== 'TEXTAREA' && tag !== 'BUTTON') {
            const modal = document.querySelector('.modal.show');
            if (modal) {
                const accion = {
                    'modal-nuevo-disp': () => UI.guardarNuevoDispositivo(),
                    'modal-editar-disp': () => UI.guardarEdicionDispositivo(),
                    'modal-nuevo-grab': () => UI.guardarNuevoGrabador(),
                    'modal-editar-grab': () => UI.guardarEdicionGrabador(),
                    'modal-canal': () => UI.guardarAsignacionCanal(),
                    'modal-nuevo-otro-prod': () => UI.guardarOtroProd('nuevo-otro-prod'),
                    'modal-editar-otro-prod': () => UI.guardarOtroProd('editar-otro-prod'),
                    'modal-tipos-dispositivo': () => UI.agregarTipoCustom(),
                    'modal-edificios': () => UI.agregarEdificio(),
                    'modal-confirmar': () => document.getElementById('modal-confirmar-ok')?.click(),
                }[modal.id];
                if (accion) { e.preventDefault(); accion(); }
            }
            return;
        }

        if (!modalAbierto && e.altKey) {
            const tabs = TABS;
            const idxActual = tabs.indexOf(_tabActual);

            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                if (idxActual > 0) UI.cambiarTab(tabs[idxActual - 1]);
                return;
            }
            if (e.key === 'ArrowRight') {
                e.preventDefault();
                if (idxActual < tabs.length - 1) UI.cambiarTab(tabs[idxActual + 1]);
                return;
            }
        }

        if (modalAbierto) return;
        if (enInput) return;

        const inputBusq = document.getElementById('input-busqueda');
        if (inputBusq && (document.activeElement === inputBusq || inputBusq._recienTocado)) return;
        if (e.key === '+' || e.key === '=') { UI.abrirNuevoDispositivo(); return; }

        const esCaracterValido = e.key.length === 1 && /^[a-zA-Z0-9:]$/.test(e.key);

        if ((esCaracterValido || e.key === 'Backspace') && !e.ctrlKey && !e.metaKey && !e.altKey) {
            if (_tabActual !== 'activos') UI.cambiarTab('activos', true);
            inputBusq.focus();
        }
    });

    (() => {
        const inp = document.getElementById('input-busqueda');
        if (!inp) return;
        const marcar = () => {
            inp._recienTocado = true;
            clearTimeout(inp._recienTocadoTimer);
            inp._recienTocadoTimer = setTimeout(() => { inp._recienTocado = false; }, 1000);
        };
        inp.addEventListener('touchstart', marcar, { passive: true });
        inp.addEventListener('focus', marcar);
    })();

    document.addEventListener('paste', e => {
        const tag = document.activeElement?.tagName;
        const enInput = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
        const modalAbierto = document.body.classList.contains('modal-open');
        if (enInput || modalAbierto) return;

        const texto = e.clipboardData?.getData('text') || '';
        if (!texto) return;

        e.preventDefault();

        const input = document.getElementById('input-busqueda');
        if (!input) return;
        input.value = texto;
        const btnX = document.getElementById('btn-limpiar-busqueda');
        if (btnX) btnX.style.display = '';

        if (_tabActual !== 'activos') UI.cambiarTab('activos', true);

        setTimeout(() => {
            input.focus();
            UI.filtrarActivos();
        }, 220);
    });

    (() => {
        let _pressTimer;
        let _longPressFired = false;

        function handlePressStart(e) {

            if (e.target.closest('button')) return;

            const headerActivos = e.target.closest('.grupo-activos-header');
            const headerNVR = e.target.closest('.nvr-card-header');
            const headerPiso = e.target.closest('.grupo-piso-header');

            if (headerActivos || headerNVR || headerPiso) {
                _longPressFired = false;

                _pressTimer = setTimeout(() => {
                    _longPressFired = true;

                    if (navigator.vibrate) navigator.vibrate(50);

                    if (headerActivos) {
                        const grupos = document.querySelectorAll('.grupo-activos-card');
                        if (!grupos.length) return;

                        const groupId = headerActivos.dataset.toggleGrupo;
                        const estabaCerrado = _activos.collapsed.has(groupId);
                        const abrirTodos = estabaCerrado;

                        grupos.forEach(g => {
                            if (abrirTodos) _activos.collapsed.delete(g.dataset.grupo);
                            else _activos.collapsed.add(g.dataset.grupo);
                        });

                        if (_guardarColapsados) _guardarColapsados();
                        toast(abrirTodos ? 'Todos los grupos expandidos' : 'Todos los grupos colapsados', 'info');
                        renderActivos();
                    }

                    else if (headerPiso) {

                        const pisos = document.querySelectorAll('.sub-grupo-piso');
                        if (!pisos.length) return;

                        const floorKey = headerPiso.dataset.togglePiso;
                        const estabaCerrado = _activos.pisosCollapsed.has(floorKey);
                        const abrirTodos = estabaCerrado;

                        pisos.forEach(p => {
                            if (abrirTodos) _activos.pisosCollapsed.delete(p.dataset.floorKey);
                            else _activos.pisosCollapsed.add(p.dataset.floorKey);
                        });

                        if (_guardarColapsados) _guardarColapsados();
                        toast(abrirTodos ? 'Todos los pisos expandidos' : 'Todos los pisos colapsados', 'info');
                        renderActivos();
                    }

                    else if (headerNVR) {
                        const grabs = document.querySelectorAll('.nvr-card');
                        if (!grabs.length) return;

                        const card = headerNVR.closest('.nvr-card');
                        const grabId = card.dataset.grabId;
                        const estabaAbierto = _grabExpanded.has(grabId);
                        const abrirTodos = !estabaAbierto;

                        grabs.forEach(g => {
                            if (abrirTodos) _grabExpanded.add(g.dataset.grabId);
                            else _grabExpanded.delete(g.dataset.grabId);
                        });

                        localStorage.setItem(KEY_EXPANDED, JSON.stringify({ ids: [..._grabExpanded], ts: Date.now() }));
                        toast(abrirTodos ? 'Todos los grabadores expandidos' : 'Todos los grabadores colapsados', 'info');
                        renderProduccion();
                    }
                }, 500);
            }
        }

        function handlePressEnd() {
            if (_pressTimer) {
                clearTimeout(_pressTimer);
                _pressTimer = null;
            }
            if (_longPressFired) {
                setTimeout(() => {
                    _longPressFired = false;
                }, 100);
            }
        }

        document.addEventListener('mousedown', handlePressStart);
        document.addEventListener('touchstart', handlePressStart, { passive: true });

        document.addEventListener('mouseup', handlePressEnd);
        document.addEventListener('mouseleave', handlePressEnd);
        document.addEventListener('touchend', handlePressEnd);
        document.addEventListener('touchcancel', handlePressEnd);

        document.addEventListener('click', e => {
            if (_longPressFired) {
                e.preventDefault();
                e.stopPropagation();
                _longPressFired = false;
            }
        }, true);
    })();

    (() => {
        const btn = document.getElementById('btn-scroll-top');
        const tituloEl = document.getElementById('header-tab-titulo');
        const LABELS = { dashboard: 'Dashboard', activos: 'Activos', produccion: 'Producción' };

        function actualizarBoton() {
            const enPanel = _tabActual === 'activos' || _tabActual === 'produccion';
            const scrollSuficiente = window.scrollY > window.innerHeight * 0.85;
            if (btn) {
                if (enPanel && scrollSuficiente) {
                    btn.style.display = '';
                    requestAnimationFrame(() => {
                        btn.style.opacity = '1';
                        btn.style.transform = 'translateY(0)';
                    });
                } else {
                    btn.style.opacity = '0';
                    btn.style.transform = 'translateY(8px)';
                    setTimeout(() => {
                        if (btn.style.opacity === '0') btn.style.display = 'none';
                    }, 260);
                }
            }
            if (tituloEl) {
                const tabsEl = document.querySelector('.tabs');
                const tabsOcultas = tabsEl ? tabsEl.getBoundingClientRect().bottom < 0 : window.scrollY > 80;
                tituloEl.textContent = LABELS[_tabActual] || '';
                tituloEl.classList.toggle('visible', tabsOcultas);
            }
        }
        window.addEventListener('scroll', actualizarBoton, { passive: true });
        const _cambiarTabOrig = UI.cambiarTab.bind(UI);
        UI.cambiarTab = function (...args) {
            _cambiarTabOrig(...args);
            actualizarBoton();
        };
    })();


    // ── Eventos estáticos del HTML + delegación en contenedores dinámicos ──

    // ════════════════════════════════════════════════════════════════════════════
    // § EVENTOS — binding de eventos estáticos del DOM
    // ════════════════════════════════════════════════════════════════════════════
    function _bindStaticEvents() {
        const on = (id, evt, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(evt, fn); };

        // Header
        on('btn-undo', 'click', () => historial.undo());
        on('btn-redo', 'click', () => historial.redo());
        document.querySelector('.header-buttons .icon-btn[title="Ajustes"]')
            ?.addEventListener('click', () => UI.abrirAjustes());

        // Tabs
        on('tab-dashboard', 'click', () => UI.cambiarTab('dashboard'));
        on('tab-activos', 'click', () => UI.cambiarTab('activos'));
        on('tab-produccion', 'click', () => UI.cambiarTab('produccion'));

        // Búsqueda
        on('input-busqueda', 'input', () => UI.filtrarActivos());
        on('input-busqueda', 'paste', (e) => {
            if (_tabActual !== 'activos') {
                e.preventDefault();
                const t = (e.clipboardData || window.clipboardData).getData('text');
                UI.cambiarTab('activos', true);
                setTimeout(() => {
                    const inp = document.getElementById('input-busqueda');
                    inp.value = t;
                    document.getElementById('btn-limpiar-busqueda').style.display = '';
                    inp.focus();
                    UI.filtrarActivos();
                }, 220);
            } else {
                setTimeout(() => UI.filtrarActivos(), 0);
            }
        });
        on('btn-limpiar-busqueda', 'click', () => UI.limpiarBusqueda());
        on('btn-filtros-busqueda', 'click', () => UI.abrirFiltrosBusqueda());

        // Mini-tabs cámaras dashboard
        document.querySelectorAll('.mini-tab-btn[data-target]').forEach(btn => {
            btn.addEventListener('click', () => _setCamarasVista(btn.dataset.target));
        });

        // Dropdown activos
        document.querySelector('#btn-vista-activos-wrap > .icon-btn')
            ?.addEventListener('click', (e) => UI.toggleDropdownActivos(e));
        document.querySelectorAll('#dropdown-vista-activos .canal-disp-item').forEach(item => {
            const orden = item.dataset.orden;
            if (orden) item.addEventListener('click', () => { UI.setActivosOrden(orden); UI.toggleDropdownActivos(); });
        });

        // Botones agregar activo / grabador / otro prod
        document.querySelector('#panel-activos .btn-edit.btn-inline')
            ?.addEventListener('click', () => UI.abrirNuevoDispositivo());
        document.querySelector('#panel-produccion .card:first-child .btn-edit.btn-inline')
            ?.addEventListener('click', () => UI.abrirNuevoGrabador());
        document.querySelector('#panel-produccion .card:last-child .btn-edit.btn-inline')
            ?.addEventListener('click', () => UI.abrirNuevoOtroProd());

        // Ajustes
        document.querySelectorAll('#modal-ajustes .btn-ajustes').forEach(btn => {
            const icon = btn.querySelector('use')?.getAttribute('href');
            if (icon === '#icon-grid') btn.addEventListener('click', () => UI.abrirTiposDispositivo());
            if (icon === '#icon-building') btn.addEventListener('click', () => UI.abrirEdificios());
            if (icon === '#icon-report') btn.addEventListener('click', () => UI.abrirReporte());
            if (icon === '#icon-gist') btn.addEventListener('click', () => UI.abrirGist());
            if (icon === '#icon-upload') btn.addEventListener('click', () => UI.abrirImportarDesdeAjustes());
            if (icon === '#icon-download') btn.addEventListener('click', () => UI.exportarJSON());
            if (icon === '#icon-trash') btn.addEventListener('click', () => UI.borrarTodosLosDatos());
        });
        on('label-recordar-grupos', 'click', () => UI.toggleRecordarGrupos());
        on('btn-ajustes-gist-subir', 'click', () => GistSync.subir());
        on('btn-ajustes-gist-bajar', 'click', () => GistSync.bajar());
        document.querySelector('#modal-ajustes .btn-cancel')
            ?.addEventListener('click', () => UI.cerrarAjustes());
        on('btn-alternar-tema', 'click', () => UI.alternarTema());

        // Modal reporte
        document.querySelector('#modal-reporte .btn-cancel')
            ?.addEventListener('click', () => UI.cerrarReporte());
        on('btn-generar-reporte', 'click', () => UI.generarReporte());

        // Modal tipos dispositivo
        on('nuevo-tipo-label', 'keydown', (e) => { if (e.key === 'Enter') UI.agregarTipoCustom(); });
        document.querySelector('#modal-tipos-dispositivo .icon-btn.btn-edit')
            ?.addEventListener('click', () => UI.agregarTipoCustom());
        document.querySelector('#modal-tipos-dispositivo .btn-cancel')
            ?.addEventListener('click', () => UI.cerrarTiposDispositivo());

        // Modal edificios
        on('nuevo-edificio-nombre', 'keydown', (e) => { if (e.key === 'Enter') UI.agregarEdificio(); });
        document.querySelector('#modal-edificios .icon-btn.btn-edit')
            ?.addEventListener('click', () => UI.agregarEdificio());
        document.querySelector('#modal-edificios .btn-cancel')
            ?.addEventListener('click', () => UI.cerrarEdificios());

        // Modal Gist
        on('gist-token-eye', 'click', () => GistSync.toggleToken());
        on('btn-gist-subir', 'click', () => GistSync.subir());
        on('btn-gist-bajar', 'click', () => GistSync.bajar());
        on('gist-autosync-toggle', 'click', () => GistSync.toggleAuto());
        document.querySelector('#modal-gist .btn-edit')
            ?.addEventListener('click', () => GistSync.guardarConfig());
        document.querySelector('#modal-gist .modal-sticky-footer .btn-cancel')
            ?.addEventListener('click', () => UI.cerrarGist());

        // Modal gist novedades
        document.querySelector('#modal-gist-novedades .btn-cancel')
            ?.addEventListener('click', () => MM.cerrar('modal-gist-novedades'));

        // Scroll top
        on('btn-scroll-top', 'click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

        // Modal nuevo otro-prod
        on('nuevo-otro-prod-disp-input', 'input', () => UI._otroProdDispFiltrar('nuevo-otro-prod'));
        on('nuevo-otro-prod-disp-input', 'focus', () => UI._otroProdDispFiltrar('nuevo-otro-prod'));
        on('nuevo-otro-prod-disp-input', 'keydown', (e) => UI._otroProdDispKeydown(e, 'nuevo-otro-prod'));
        on('nuevo-otro-prod-piso', 'input', () => UI._pisoFiltrar(document.getElementById('nuevo-otro-prod-piso')));
        document.querySelector('#modal-nuevo-otro-prod .btn-edit')
            ?.addEventListener('click', () => UI.guardarOtroProd('nuevo-otro-prod'));
        document.querySelector('#modal-nuevo-otro-prod .btn-cancel')
            ?.addEventListener('click', () => UI.cerrarNuevoOtroProd());

        // Modal editar otro-prod
        on('editar-otro-prod-disp-input', 'input', () => UI._otroProdDispFiltrar('editar-otro-prod'));
        on('editar-otro-prod-disp-input', 'focus', () => UI._otroProdDispFiltrar('editar-otro-prod'));
        on('editar-otro-prod-disp-input', 'keydown', (e) => UI._otroProdDispKeydown(e, 'editar-otro-prod'));
        on('btn-ver-activo-otro-prod', 'click', () => UI.verActivoDesdeOtroProd());
        on('editar-otro-prod-piso', 'input', () => UI._pisoFiltrar(document.getElementById('editar-otro-prod-piso')));
        document.querySelector('#modal-editar-otro-prod .btn-edit')
            ?.addEventListener('click', () => UI.guardarOtroProd('editar-otro-prod'));
        document.querySelector('#modal-editar-otro-prod .btn-delete')
            ?.addEventListener('click', () => UI.eliminarOtroProd());
        document.querySelector('#modal-editar-otro-prod .btn-cancel')
            ?.addEventListener('click', () => UI.cerrarEditarOtroProd());

        // Modal nuevo dispositivo
        on('nuevo-disp-tipo', 'change', () => UI.onDispTipoChange('nuevo-disp'));
        document.querySelector('#modal-nuevo-disp .btn-edit')
            ?.addEventListener('click', () => UI.guardarNuevoDispositivo());
        document.querySelector('#modal-nuevo-disp .btn-cancel')
            ?.addEventListener('click', () => UI.cerrarModalNuevoDispositivo());

        // Modal editar dispositivo
        on('editar-disp-tipo', 'change', () => UI.onDispTipoChange('editar-disp'));
        on('btn-estado-averiado', 'click', () => UI.toggleEstadoDisp('averiado'));
        on('btn-estado-revisar', 'click', () => UI.toggleEstadoDisp('revisar'));
        on('btn-estado-desafectado', 'click', () => UI.toggleEstadoDisp('desafectado'));
        document.querySelector('#modal-editar-disp .btn-edit')
            ?.addEventListener('click', () => UI.guardarEdicionDispositivo());
        document.querySelector('#modal-editar-disp .btn-delete')
            ?.addEventListener('click', () => UI.eliminarDispositivo());
        document.querySelector('#modal-editar-disp .btn-cancel')
            ?.addEventListener('click', () => UI.cerrarModalEditarDispositivo());

        // Modal nuevo grabador
        on('nuevo-grab-piso', 'input', () => UI._pisoFiltrar(document.getElementById('nuevo-grab-piso')));
        document.querySelector('#modal-nuevo-grab .btn-edit')
            ?.addEventListener('click', () => UI.guardarNuevoGrabador());
        document.querySelector('#modal-nuevo-grab .btn-cancel')
            ?.addEventListener('click', () => UI.cerrarModalNuevoGrabador());

        // Modal editar grabador
        on('editar-grab-dispositivo-id', 'change', () => UI.onGrabDispositivoChange());
        on('btn-ver-activo-grab', 'click', () => UI.verActivoDesdeGrabador());
        on('editar-grab-piso', 'input', () => UI._pisoFiltrar(document.getElementById('editar-grab-piso')));
        document.querySelector('#modal-editar-grab .btn-edit')
            ?.addEventListener('click', () => UI.guardarEdicionGrabador());
        document.querySelector('#modal-editar-grab .btn-delete')
            ?.addEventListener('click', () => UI.eliminarGrabador());
        document.querySelector('#modal-editar-grab .btn-cancel')
            ?.addEventListener('click', () => UI.cerrarModalEditarGrabador());

        // Modal canal
        on('canal-disp-input', 'input', () => UI._canalDispFiltrar());
        on('canal-disp-input', 'focus', () => UI._canalDispFiltrar());
        on('canal-disp-input', 'keydown', (e) => UI._canalDispKeydown(e));
        on('btn-ver-activo-canal', 'click', () => UI.verActivoDesdeCanal());
        on('canal-piso', 'input', () => UI._pisoFiltrar(document.getElementById('canal-piso')));
        document.querySelector('#modal-canal .btn-edit')
            ?.addEventListener('click', () => UI.guardarAsignacionCanal());
        document.querySelector('#modal-canal .btn-delete')
            ?.addEventListener('click', () => UI.limpiarAsignacionCanal());
        on('btn-canal-cancelar', 'click', () => UI.cerrarModalCanal());

        // Modal importar
        on('importar-dropzone', 'click', () => document.getElementById('file-import').click());
        on('file-import', 'change', (e) => UI.onImportarFileChange(e));
        on('btn-reemplazar', 'click', () => UI.importarDatos('replace'));
        on('btn-combinar', 'click', () => UI.importarDatos('merge'));
        document.querySelector('#modal-importar .btn-cancel')
            ?.addEventListener('click', () => { UI.cerrarImportar(); setTimeout(() => UI.abrirAjustes(), 150); });

        // Modal filtros búsqueda
        on('btn-toggle-all-filtros', 'click', () => UI.toggleTodosFiltros());
        document.querySelector('#modal-filtros-busqueda .btn-cancel')
            ?.addEventListener('click', () => UI.cerrarFiltrosBusqueda());

        // Delegación: data-copy (IPs y modelos generados dinámicamente)
        document.addEventListener('click', (e) => {
            const el = e.target.closest('[data-copy]');
            if (el) { e.stopPropagation(); UI.copiarAlPortapapeles(el.dataset.copy, e); }
        });

        // Delegación: data-action (botones en listas dinámicas)
        document.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            e.stopPropagation();
            const action = btn.dataset.action;
            if (action === 'eliminar-tipo') UI.eliminarTipoCustom(btn.dataset.key);
            if (action === 'eliminar-edificio') UI.eliminarEdificio(Number(btn.dataset.idx));
            if (action === 'toggle-tipo') _toggleTipoDetalle(btn.dataset.tipo);
            if (action === 'toggle-estado') _toggleEstadoDetalle(btn.dataset.estado);
            if (action === 'ir-activos') UI.irAActivosConFiltro(btn.dataset.tipo, btn.dataset.estado, btn.dataset.forma);
            if (action === 'toggle-estado-o-ir') {
                if (btn.dataset.esCamara === 'true') _toggleEstadoDetalle(btn.dataset.estado);
                else UI.irAActivosConFiltro(btn.dataset.tipo, btn.dataset.estado);
            }
            if (action === 'toggle-edificio') {
                const rowEl = e.target.closest('.dash-edif-row');
                if (rowEl) _toggleEdificio(rowEl);
            }
        });
    }

    // ════════════════════════════════════════════════════════════════════════════
    // § MODAL LOCK — bloqueo de edición en modales de editar
    // ════════════════════════════════════════════════════════════════════════════
    const ModalLock = (() => {
        // Campos y botones bloqueables por modal
        const LOCK_CFG = {
            'modal-editar-disp': {
                inputs: ['editar-disp-tipo', 'editar-disp-forma', 'editar-disp-canales', 'editar-disp-marca',
                    'editar-disp-modelo', 'editar-disp-mac', 'editar-disp-serial', 'editar-disp-patrimonio', 'editar-disp-firmware'],
                btns: [
                    () => document.querySelector('#modal-editar-disp .btn-edit'),
                    () => document.querySelector('#modal-editar-disp .btn-delete'),
                    () => document.getElementById('btn-estado-averiado'),
                    () => document.getElementById('btn-estado-revisar'),
                    () => document.getElementById('btn-estado-desafectado'),
                ],
                lockBtn: 'btn-lock-editar-disp',
            },
            'modal-editar-grab': {
                inputs: ['editar-grab-nombre', 'editar-grab-dispositivo-id', 'editar-grab-rack',
                    'editar-grab-puerto', 'editar-grab-edificio', 'editar-grab-piso', 'editar-grab-ip', 'editar-grab-comentarios'],
                btns: [
                    () => document.querySelector('#modal-editar-grab .btn-edit'),
                    () => document.querySelector('#modal-editar-grab .btn-delete'),
                ],
                lockBtn: 'btn-lock-editar-grab',
            },
            'modal-canal': {
                inputs: ['canal-disp-input', 'canal-descripcion', 'canal-ip', 'canal-puerto',
                    'canal-edificio', 'canal-piso', 'canal-rack', 'canal-comentarios'],
                btns: [
                    () => document.querySelector('#modal-canal .btn-edit'),
                    () => document.querySelector('#modal-canal .btn-delete'),
                ],
                lockBtn: 'btn-lock-canal',
            },            
            'modal-editar-otro-prod': {
                inputs: ['editar-otro-prod-descripcion', 'editar-otro-prod-disp-input', 'editar-otro-prod-ip', 'editar-otro-prod-puerto',
                    'editar-otro-prod-edificio', 'editar-otro-prod-piso', 'editar-otro-prod-rack', 'editar-otro-prod-comentarios'],
                btns: [
                    () => document.querySelector('#modal-editar-otro-prod .btn-edit'),
                    () => document.querySelector('#modal-editar-otro-prod .btn-delete'),
                ],
                lockBtn: 'btn-lock-editar-otro-prod',
            },
        };

        const _locked = {
            'modal-editar-disp': true,
            'modal-editar-grab': true,
            'modal-canal': true,
            'modal-editar-otro-prod': true, // Actualizado
        };

        function _aplicar(modalId) {
            const cfg = LOCK_CFG[modalId];
            if (!cfg) return;
            const bloqueado = _locked[modalId];

            cfg.inputs.forEach(id => {
                const el = document.getElementById(id);
                if (el) el.disabled = bloqueado;
            });
            cfg.btns.forEach(getFn => {
                const el = getFn();
                if (el) el.disabled = bloqueado;
            });

            const btnLock = document.getElementById(cfg.lockBtn);
            if (btnLock) {
                btnLock.title = bloqueado ? 'Desbloquear edición' : 'Bloquear edición';
                btnLock.classList.toggle('btn-lock--open', !bloqueado);
                // rota el arco del candado via CSS cuando está abierto
                const shackle = btnLock.querySelector('.icon-lock-shackle');
                if (shackle) shackle.style.transform = bloqueado ? '' : 'translateY(-3px)';
            }
        }

        function toggle(modalId) {
            if (!(_locked[modalId] !== undefined)) return;
            _locked[modalId] = !_locked[modalId];
            _aplicar(modalId);
        }

        // Resetea a bloqueado y aplica — llamar al abrir cada modal
        function reset(modalId) {
            if (_locked[modalId] !== undefined) {
                _locked[modalId] = true;
                _aplicar(modalId);
            }
        }

        function bindBtn(modalId) {
            const cfg = LOCK_CFG[modalId];
            if (!cfg) return;
            const btn = document.getElementById(cfg.lockBtn);
            if (btn) btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(modalId); });
        }

        function init() {
            Object.keys(LOCK_CFG).forEach(modalId => {
                bindBtn(modalId);
            });
        }

        return { reset, init };
    })();

    // ════════════════════════════════════════════════════════════════════════════
    // § INIT — arranque de la aplicación
    // ════════════════════════════════════════════════════════════════════════════
    TABS.forEach(t => {
        const btn = document.getElementById('tab-' + t);
        const panel = document.getElementById('panel-' + t);
        if (btn) btn.classList.toggle('activa', t === _tabActual);
        if (panel) panel.style.display = t === _tabActual ? '' : 'none';
    });

    requestAnimationFrame(() => {
        document.body.removeAttribute('data-tab-inicial');
    });

    _bindStaticEvents();
    cargar();
    render();

    ModalLock.init();
    GistSync.init();
    GistSync.verificarAlAbrir();

    (() => {
        let deferredPrompt;
        const btnInstallApp = document.getElementById('btn-install-app');

        window.addEventListener('beforeinstallprompt', (e) => {

            e.preventDefault();

            deferredPrompt = e;

            if (btnInstallApp) btnInstallApp.style.display = 'flex';
        });

        if (btnInstallApp) {
            btnInstallApp.addEventListener('click', async () => {
                if (!deferredPrompt) return;

                deferredPrompt.prompt();

                const { outcome } = await deferredPrompt.userChoice;
                console.log(`Elección de instalación del usuario: ${outcome}`);

                deferredPrompt = null;

                btnInstallApp.style.display = 'none';
            });
        }

        window.addEventListener('appinstalled', () => {
            if (btnInstallApp) btnInstallApp.style.display = 'none';
            deferredPrompt = null;
            toast('Aplicación instalada con éxito', 'success');
        });
    })();

})();

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
            .then(reg => console.log('SW registrado', reg.scope))
            .catch(err => console.warn('Error al registrar SW', err));
    });
}
