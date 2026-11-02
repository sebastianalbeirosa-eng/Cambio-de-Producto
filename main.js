/**
 * ==============================================================================
 * PRODUCT-SYNC | Plataforma de Control Predictivo de Transición Industrial
 * Ecosistema DMBE Systems
 *
 * Diseño: Schneider EcoStruxure Neon + Temporizador SCADA Circular (Gauge)
 *
 * Lógica de Planta (Gobernada por Ciclo de Horno y Rendimiento de Calidad):
 * - El horno es el proceso continuo ininterrumpido que rige el cambio de producto.
 * - Variables determinantes:
 *   1. Metros faltantes de 1ra calidad y Factor de Calidad (%) de clasificación.
 *   2. Stock intermedio en boxes (Pisos x m² según formato).
 *   3. Cambio de punzones: define si se vacía el secadero (+280 m²) o si el corte
 *      se hace en la salida del secadero (secadero NO entra = 0 m²).
 *   4. Consumo horario del horno (m²/h) según ciclo térmico (con ajuste real de planta).
 * ==============================================================================
 */

'use strict';

/* ==============================================================================
 * 1. CONFIGURACIÓN CENTRALIZADA Y DICCIONARIO DE FORMATOS CERÁMICOS
 * ============================================================================== */

const INDUSTRIAL_CONFIG = Object.freeze({
    SYSTEM_INFO: Object.freeze({
        NAME: 'PRODUCT-SYNC',
        VERSION: '3.0.0-PROD',
        LINE_ID: 'LINEA-HORNO-TRANSICION-01'
    }),

    FORMATS: Object.freeze({
        '45x45': Object.freeze({
            id: '45x45',
            name: 'Piso 45x45 cm',
            m2PorPlaca: 0.2025,
            m2PorPisoBox: 6.075,        // 30 placas (5 filas x 6) x 0.2025 = 6.075 m²
            capacidadSecadero: 280,     // Vaciamiento de secadero a 17 min
            consumoBaseHorno: 850,      // m²/h nominal a ciclo 26 min
            cicloBaseHorno: 26,         // minutos base
            minCicloHorno: 23,
            maxCicloHorno: 40,
            defaultMetrosFaltantes: 6800,
            defaultCalidadPrimera: 90,  // 90% por defecto
            defaultPisosBoxes: 0,
            description: 'Piso gres 45x45 cm'
        }),
        '33x45': Object.freeze({
            id: '33x45',
            name: 'Revestimiento 33x45 cm',
            m2PorPlaca: 0.1485,
            m2PorPisoBox: 5.346,        // 36 placas por piso
            capacidadSecadero: 260,
            consumoBaseHorno: 820,
            cicloBaseHorno: 26,
            minCicloHorno: 23,
            maxCicloHorno: 40,
            defaultMetrosFaltantes: 6000,
            defaultCalidadPrimera: 90,
            defaultPisosBoxes: 0,
            description: 'Revestimiento 33x45 cm'
        }),
        '33x33': Object.freeze({
            id: '33x33',
            name: 'Piso 33x33 cm',
            m2PorPlaca: 0.1089,
            m2PorPisoBox: 4.8,
            capacidadSecadero: 240,
            consumoBaseHorno: 780,
            cicloBaseHorno: 26,
            minCicloHorno: 23,
            maxCicloHorno: 40,
            defaultMetrosFaltantes: 5500,
            defaultCalidadPrimera: 90,
            defaultPisosBoxes: 0,
            description: 'Piso tradicional 33x33 cm'
        })
    }),

    VALIDATION_LIMITS: Object.freeze({
        METROS_FALTANTES: { min: 0, max: 200000 },
        CALIDAD_PRIMERA: { min: 50, max: 100 },
        PISOS_BOXES: { min: 0, max: 150 },
        CICLO_HORNO: { min: 20, max: 50 },
        CONSUMO_HORNO: { min: 500, max: 1300 }
    }),

    ALARM_THRESHOLDS: Object.freeze({
        WARNING_MINUTES: 45,     // Advertencia preventiva (Ámbar)
        CRITICAL_MINUTES: 15     // Corte Inminente (Rojo)
    }),

    // Constantes del Gauge SCADA (Medialuna semicircular 180° espaciosa con r=135)
    GAUGE: Object.freeze({
        CIRCUMFERENCE: 848.23,      // 2 * PI * 135
        ARC_LENGTH: 424.12,         // 180° semicircular superior
        GAP_LENGTH: 424.12          // 180° inferior abierto
    })
});

/* ==============================================================================
 * 2. CIBERSEGURIDAD Y VALIDACIÓN DEFENSIVA DE ENTRADAS
 * ============================================================================== */

class IndustrialSecurityValidator {
    static sanitizeString(inputStr) {
        if (typeof inputStr !== 'string') return '';
        return inputStr.replace(/[&<>"'/]/g, '').trim().slice(0, 16);
    }

    static validateNumber(val, min, max, fallback, isInteger = false) {
        let num = isInteger ? parseInt(val, 10) : parseFloat(val);
        if (isNaN(num) || !isFinite(num)) {
            return fallback;
        }
        if (num < min) return min;
        if (num > max) return max;
        return num;
    }

    static isValidTimeFormat(timeStr) {
        if (!timeStr || typeof timeStr !== 'string') return false;
        return /^([01]\d|2[0-3]):([0-5]\d)$/.test(timeStr.trim());
    }

    static validateAndSanitizeInputs(rawInputs, formatConfig) {
        const limits = INDUSTRIAL_CONFIG.VALIDATION_LIMITS;

        let sanitizedHora = rawInputs.horaMedicion ? String(rawInputs.horaMedicion).trim() : '';
        if (!this.isValidTimeFormat(sanitizedHora)) {
            const now = new Date();
            sanitizedHora = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        }

        const metrosFaltantes = this.validateNumber(
            rawInputs.metrosFaltantes,
            limits.METROS_FALTANTES.min,
            limits.METROS_FALTANTES.max,
            formatConfig.defaultMetrosFaltantes,
            false
        );

        const calidadPrimera = this.validateNumber(
            rawInputs.calidadPrimera,
            limits.CALIDAD_PRIMERA.min,
            limits.CALIDAD_PRIMERA.max,
            formatConfig.defaultCalidadPrimera,
            false
        );

        const pisosBoxes = this.validateNumber(
            rawInputs.pisosBoxes,
            limits.PISOS_BOXES.min,
            limits.PISOS_BOXES.max,
            formatConfig.defaultPisosBoxes,
            true
        );

        const cambioPunzones = Boolean(rawInputs.cambioPunzones);

        const minCiclo = formatConfig.minCicloHorno || limits.CICLO_HORNO.min;
        const maxCiclo = formatConfig.maxCicloHorno || limits.CICLO_HORNO.max;
        const cicloHorno = this.validateNumber(
            rawInputs.cicloHorno,
            minCiclo,
            maxCiclo,
            formatConfig.cicloBaseHorno,
            true
        );

        // Consumo Horno Manual (permite ajuste fino a 840, 845, 850 m²/h)
        const consumoHorno = this.validateNumber(
            rawInputs.consumoHorno,
            limits.CONSUMO_HORNO.min,
            limits.CONSUMO_HORNO.max,
            formatConfig.consumoBaseHorno,
            true
        );

        return {
            horaMedicion: sanitizedHora,
            metrosFaltantes,
            calidadPrimera,
            pisosBoxes,
            cambioPunzones,
            cicloHorno,
            consumoHorno
        };
    }
}

/* ==============================================================================
 * 3. MOTOR DE CÁLCULO GOBERNADO POR EL HORNO (CON CARGA EN TRÁNSITO)
 * ============================================================================== */

class ProductionCalculationEngine {
    /**
     * Calcula la hora exacta de corte de línea gobernada por el consumo del horno.
     *
     * Reglas Matemáticas Reales de Planta Cerámica:
     * 1. Compensación de Calidad:
     *    Metros Brutos Necesarios = Metros Faltantes 1ra / (Calidad% / 100).
     * 2. Carga Activa Dentro del Horno:
     *    Un horno a rodillos continuo está SIEMPRE LLENO.
     *    Metros en Horno = Consumo Real (m²/h) * (Ciclo Horno (min) / 60).
     *    (Ej: 850 m²/h * 26/60 = 368.3 m² que YA se están cociendo).
     * 3. Stock en Boxes (m²) = Pisos en Boxes * m² por piso.
     * 4. Secadero:
     *    - Con cambio de punzones: se vacía secadero (+280 m² en tránsito).
     *    - Sin cambio de punzones: corte a la salida del secadero (0 m²).
     * 5. Total Material en Tránsito hacia Empaquetado = Horno + Boxes + Secadero.
     * 6. Condición de RE-PASADO:
     *    Si Total en Tránsito >= Metros Brutos Necesarios, el corte debe ser INMEDIATO
     *    porque el horno ya contiene más material del que falta para terminar el pedido.
     *    Excedente = Total en Tránsito - Metros Brutos Necesarios.
     * 7. Metros Netos a Hornear = max(0, Metros Brutos - Total en Tránsito).
     * 8. Hora de Corte = Hora de Medición + (Metros Netos / Consumo m²/min).
     */
    static computeProductionCutoff(inputs, formatConfig) {
        // 1. Compensación por porcentaje de 1ra calidad
        const factorCalidad = Math.max(0.5, Math.min(1.0, inputs.calidadPrimera / 100));
        const metrosBrutosHorno = Math.round((inputs.metrosFaltantes / factorCalidad) * 10) / 10;
        const metrosMerma = Math.round((metrosBrutosHorno - inputs.metrosFaltantes) * 10) / 10;

        // 2. Dinámica de Consumo de Horno
        const consumoHornoM2Hora = inputs.consumoHorno;
        const consumoHornoM2Minuto = consumoHornoM2Hora / 60;

        // 3. Carga activa dentro del horno continuo (siempre lleno en quema)
        // Se calcula con precisión dinámica: Consumo horario (m²/h) * (Ciclo en minutos / 60)
        const m2EnHorno = Math.round((consumoHornoM2Hora * (inputs.cicloHorno / 60)) * 10) / 10;

        // 4. Stock en Boxes (m² según formato)
        const stockBoxesM2 = Math.round((inputs.pisosBoxes * formatConfig.m2PorPisoBox) * 100) / 100;

        // 5. Secadero (si hay cambio de punzones)
        const m2Secadero = inputs.cambioPunzones ? formatConfig.capacidadSecadero : 0;

        // 6. Total de Material ya Fabricado en Proceso (Horno + Boxes + Secadero)
        const totalMaterialEnProceso = Math.round((m2EnHorno + stockBoxesM2 + m2Secadero) * 10) / 10;

        // 7. Metros netos reales que aún deben procesarse hacia el horno
        const metrosNetosAHornear = Math.max(0, Math.round((metrosBrutosHorno - totalMaterialEnProceso) * 10) / 10);

        // 8. Detección de RE-PASADO o Corte Inmediato
        let minutosParaCompletar = 0;
        let esCorteInmediato = false;
        let esRePasado = false;
        let excedenteM2 = 0;

        if (totalMaterialEnProceso >= metrosBrutosHorno) {
            minutosParaCompletar = 0;
            esCorteInmediato = true;
            excedenteM2 = Math.round((totalMaterialEnProceso - metrosBrutosHorno) * 10) / 10;
            esRePasado = excedenteM2 > 0;
        } else {
            minutosParaCompletar = metrosNetosAHornear / consumoHornoM2Minuto;
        }

        // 9. Proyección exacta de Fecha y Hora de Corte
        const [horasMed, minMed] = inputs.horaMedicion.split(':').map(Number);
        const fechaMedicion = new Date();
        fechaMedicion.setHours(horasMed, minMed, 0, 0);

        const fechaCorte = new Date(fechaMedicion.getTime() + Math.round(minutosParaCompletar * 60 * 1000));
        const horaCorteStr = `${String(fechaCorte.getHours()).padStart(2, '0')}:${String(fechaCorte.getMinutes()).padStart(2, '0')}`;

        // 10. Tiempo total del lote en el horno
        const minutosTotalesLoteHorno = Math.round((metrosBrutosHorno / consumoHornoM2Minuto) * 10) / 10;
        const horasTotalesLoteHorno = (minutosTotalesLoteHorno / 60).toFixed(2);

        // 11. Escala proporcional al lote total para el tacómetro de medialuna
        let porcentajeRestanteLote = 0;
        if (!esCorteInmediato && minutosTotalesLoteHorno > 0) {
            porcentajeRestanteLote = Math.min(100, Math.max(0, (minutosParaCompletar / minutosTotalesLoteHorno) * 100));
        }

        // 12. Estado de alarma determinado de forma inmediata
        let estadoAlarma = 'NOMINAL';
        if (esCorteInmediato || minutosParaCompletar <= 0) {
            estadoAlarma = 'CORTE_YA';
        } else if (minutosParaCompletar <= INDUSTRIAL_CONFIG.ALARM_THRESHOLDS.CRITICAL_MINUTES) {
            estadoAlarma = 'CORTE_INMINENTE';
        } else if (minutosParaCompletar <= INDUSTRIAL_CONFIG.ALARM_THRESHOLDS.WARNING_MINUTES) {
            estadoAlarma = 'PRECAUCION';
        }

        return {
            timestampCalculo: new Date().toISOString(),
            formatId: formatConfig.id,
            formatName: formatConfig.name,
            calidadPrimera: inputs.calidadPrimera,
            metrosFaltantes1ra: inputs.metrosFaltantes,
            metrosBrutosHorno,
            metrosMerma,
            m2EnHorno,
            stockBoxesM2,
            m2Secadero,
            stockTotalEnTransito: totalMaterialEnProceso,
            totalMaterialEnProceso,
            metrosNetosAHornear,
            consumoHornoM2Hora,
            consumoHornoM2Minuto,
            minutosParaCompletar,
            horasRestantes: (minutosParaCompletar / 60).toFixed(2),
            minutosTotalesLoteHorno,
            horasTotalesLoteHorno,
            porcentajeRestanteLote: Math.round(porcentajeRestanteLote * 10) / 10,
            estadoAlarma,
            esCorteInmediato,
            esRePasado,
            excedenteM2,
            fechaMedicion,
            fechaCorte,
            horaCorteStr,
            inputsUsados: { ...inputs }
        };
    }
}

/* ==============================================================================
 * 4. TEMPORIZADOR DE ALTA PRECISIÓN (SIN DERIVA DE EVENT LOOP)
 * ============================================================================== */

class HighPrecisionTimer {
    constructor(onTick, onStateChange) {
        this.onTick = onTick;
        this.onStateChange = onStateChange;
        this.startTime = null;
        this.initialSeconds = 0;
        this.timerId = null;
        this.currentState = 'NOMINAL';
    }

    startWithMinutes(minutes, isImmediateCut = false) {
        this.stop();
        if (isImmediateCut || minutes <= 0) {
            this.initialSeconds = 0;
            this.currentState = 'CORTE_YA';
            if (this.onTick) {
                this.onTick({
                    totalSecondsRemaining: 0,
                    isExpired: true,
                    hours: 0,
                    minutes: 0,
                    seconds: 0,
                    state: 'CORTE_YA'
                });
            }
            return;
        }

        this.initialSeconds = Math.max(0, Math.round(minutes * 60));
        this.startTime = Date.now();
        this._tick();
        this.timerId = setInterval(() => this._tick(), 1000);
    }

    stop() {
        if (this.timerId) {
            clearInterval(this.timerId);
            this.timerId = null;
        }
    }

    _tick() {
        if (!this.startTime) return;

        const elapsedSec = Math.floor((Date.now() - this.startTime) / 1000);
        const remainingSec = Math.max(0, this.initialSeconds - elapsedSec);
        const isExpired = remainingSec <= 0;

        const hours = Math.floor(remainingSec / 3600);
        const minutes = Math.floor((remainingSec % 3600) / 60);
        const seconds = remainingSec % 60;

        const minutesLeft = remainingSec / 60;
        let newState = 'NOMINAL';
        if (isExpired) {
            newState = 'CORTE_YA';
        } else if (minutesLeft <= INDUSTRIAL_CONFIG.ALARM_THRESHOLDS.CRITICAL_MINUTES) {
            newState = 'CORTE_INMINENTE';
        } else if (minutesLeft <= INDUSTRIAL_CONFIG.ALARM_THRESHOLDS.WARNING_MINUTES) {
            newState = 'PRECAUCION';
        }

        if (newState !== this.currentState) {
            const prevState = this.currentState;
            this.currentState = newState;
            if (this.onStateChange) {
                this.onStateChange(newState, prevState);
            }
        }

        if (this.onTick) {
            this.onTick({
                totalSecondsRemaining: remainingSec,
                isExpired,
                hours,
                minutes,
                seconds,
                state: this.currentState
            });
        }
    }
}

/* ==============================================================================
 * 5. CONTROLADOR DE INTERFAZ DE USUARIO (UI CONTROLLER)
 *    Diseño: Schneider EcoStruxure + Gauge SCADA Circular
 * ============================================================================== */

class SincroCambioApp {
    constructor() {
        this.activeFormatId = '45x45';
        this.currentCalculation = null;
        this.timer = null;
        this.dom = {};
    }

    init() {
        this._bindDomElements();
        this._setupFormatSelectors();
        this._setupOvenCycleOptions();
        this._setupClock();
        this._setupEventListeners();
        this._setupTimerService();
        this._setDefaultTime();

        this.recalculate();
    }

    _bindDomElements() {
        this.dom.relojGlobal = document.getElementById('reloj-global');
        this.dom.formatBadge = document.getElementById('formatBadge');
        this.dom.formatTabs = document.querySelectorAll('.format-tab-btn');

        // Entradas
        this.dom.horaMedicion = document.getElementById('horaMedicion');
        this.dom.btnSetHoraActual = document.getElementById('btnSetHoraActual');
        this.dom.metrosFaltantes = document.getElementById('metrosFaltantes');
        this.dom.calidadPrimera = document.getElementById('calidadPrimera');
        this.dom.pisosBoxes = document.getElementById('pisosBoxes');
        this.dom.cambioPunzones = document.getElementById('cambioPunzones');
        this.dom.cicloHorno = document.getElementById('cicloHorno');
        this.dom.consumoHorno = document.getElementById('consumoHorno');

        // Indicadores
        this.dom.displayM2Boxes = document.getElementById('displayM2Boxes');
        this.dom.labelM2PorPiso = document.getElementById('labelM2PorPiso');
        this.dom.alertaSecadero = document.getElementById('alertaSecadero');
        this.dom.alertaRePasado = document.getElementById('alertaRePasado');
        this.dom.msgRePasado = document.getElementById('msgRePasado');
        this.dom.badgeExcedente = document.getElementById('badgeExcedente');
        this.dom.displayConsumoHornoMin = document.getElementById('displayConsumoHornoMin');

        // Panel Monitor Principal
        this.dom.panelMonitor = document.getElementById('panelMonitor');
        this.dom.lblTituloCorte = document.getElementById('lblTituloCorte');
        this.dom.statusBadgeText = document.getElementById('statusBadgeText');
        this.dom.statusDot = document.getElementById('statusDot');
        this.dom.horaCorteDisplay = document.getElementById('horaCorteDisplay');
        this.dom.tiempoRestante = document.getElementById('tiempoRestante');
        this.dom.barraProgreso = document.getElementById('barraProgreso');
        this.dom.progresoPct = document.getElementById('progresoPct');
        this.dom.tlInicio = document.getElementById('tl-inicio');
        this.dom.tlFin = document.getElementById('tl-fin');
        this.dom.lblTlFin = document.getElementById('lblTlFin');
        this.dom.subtleExcedente = document.getElementById('subtleExcedente');

        // Gauge SCADA SVG
        this.dom.gaugeProgressArc = document.getElementById('gaugeProgressArc');
        this.dom.gaugeGradStop1 = document.getElementById('gaugeGradStop1');
        this.dom.gaugeGradStop2 = document.getElementById('gaugeGradStop2');

        // KPIs
        this.dom.kpiMetrosBrutos = document.getElementById('kpiMetrosBrutos');
        this.dom.kpiStockDescontado = document.getElementById('kpiStockDescontado');
        this.dom.kpiMetrosNetos = document.getElementById('kpiMetrosNetos');
        this.dom.kpiHornoHora = document.getElementById('kpiHornoHora');

        // Kiosco / Modo Visual
        this.dom.btnLightMode = document.getElementById('btnLightMode');
    }

    _setupFormatSelectors() {
        this.dom.formatTabs.forEach(btn => {
            btn.addEventListener('click', (e) => {
                const targetFormat = e.currentTarget.dataset.format;
                if (targetFormat && INDUSTRIAL_CONFIG.FORMATS[targetFormat]) {
                    this.switchFormat(targetFormat);
                }
            });
        });
    }

    switchFormat(formatId) {
        if (this.activeFormatId === formatId) return;
        this.activeFormatId = formatId;
        const config = INDUSTRIAL_CONFIG.FORMATS[formatId];

        // Actualizar tabs activas (EcoStruxure gradient style)
        this.dom.formatTabs.forEach(btn => {
            const isActive = btn.dataset.format === formatId;
            btn.classList.toggle('active-format', isActive);
            btn.classList.toggle('text-gray-400', !isActive);
        });

        // Actualizar label de m² por piso en boxes
        if (this.dom.labelM2PorPiso) {
            this.dom.labelM2PorPiso.textContent = `Pisos en Boxes (${config.m2PorPisoBox} m²/p)`;
        }

        this.dom.metrosFaltantes.value = config.defaultMetrosFaltantes;
        this.dom.calidadPrimera.value = config.defaultCalidadPrimera;
        this.dom.pisosBoxes.value = config.defaultPisosBoxes;
        this.dom.consumoHorno.value = config.consumoBaseHorno;

        this._setupOvenCycleOptions();
        this.recalculate();
    }

    _setupOvenCycleOptions() {
        const config = INDUSTRIAL_CONFIG.FORMATS[this.activeFormatId];
        const select = this.dom.cicloHorno;
        select.innerHTML = '';

        for (let i = config.minCicloHorno; i <= config.maxCicloHorno; i++) {
            const option = document.createElement('option');
            option.value = String(i);
            option.textContent = `${i} minutos ${i === config.cicloBaseHorno ? '(Base)' : ''}`;
            if (i === config.cicloBaseHorno) {
                option.selected = true;
            }
            select.appendChild(option);
        }
    }

    _setupClock() {
        const updateClock = () => {
            const now = new Date();
            this.dom.relojGlobal.textContent = now.toLocaleTimeString('es-AR', {
                hour12: false,
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
        };
        updateClock();
        setInterval(updateClock, 1000);
    }

    _setDefaultTime() {
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        this.dom.horaMedicion.value = `${hh}:${mm}`;
    }

    _setupEventListeners() {
        const triggerRecalculate = () => this.recalculate();

        const inputElements = [
            this.dom.horaMedicion,
            this.dom.metrosFaltantes,
            this.dom.calidadPrimera,
            this.dom.pisosBoxes,
            this.dom.consumoHorno
        ];

        inputElements.forEach(elem => {
            if (elem) {
                elem.addEventListener('input', triggerRecalculate);
                elem.addEventListener('change', triggerRecalculate);
            }
        });

        if (this.dom.cicloHorno) {
            this.dom.cicloHorno.addEventListener('change', () => {
                this.recalculate();
            });
        }

        if (this.dom.cambioPunzones) {
            this.dom.cambioPunzones.addEventListener('change', triggerRecalculate);
        }

        if (this.dom.btnSetHoraActual) {
            this.dom.btnSetHoraActual.addEventListener('click', () => {
                this._setDefaultTime();
                this.recalculate();
            });
        }

        // Stepper Buttons (+ / -)
        document.querySelectorAll('[data-step-target]').forEach(button => {
            button.addEventListener('click', () => {
                const targetId = button.dataset.stepTarget;
                const step = parseFloat(button.dataset.stepValue) || 1;
                const targetInput = document.getElementById(targetId);

                if (targetInput) {
                    const currentVal = parseFloat(targetInput.value) || 0;
                    const decimals = step % 1 !== 0 ? 1 : 0;
                    const nextVal = (currentVal + step).toFixed(decimals);
                    targetInput.value = nextVal;
                    this.recalculate();
                }
            });
        });

        if (this.dom.btnLightMode) {
            this.dom.btnLightMode.addEventListener('click', () => this.toggleLightMode());
        }

        // Restaurar preferencias guardadas
        const savedTheme = localStorage.getItem('product-sync-theme');
        if (savedTheme === 'light') {
            document.body.classList.add('light-mode');
            this._updateLightModeIcon(true);
        }
    }

    _setupTimerService() {
        this.timer = new HighPrecisionTimer(
            (tickData) => this._onTimerTick(tickData),
            (newState) => this._onStateChange(newState)
        );
    }

    recalculate() {
        const formatConfig = INDUSTRIAL_CONFIG.FORMATS[this.activeFormatId];

        const rawInputs = {
            horaMedicion: this.dom.horaMedicion.value,
            metrosFaltantes: this.dom.metrosFaltantes.value,
            calidadPrimera: this.dom.calidadPrimera.value,
            pisosBoxes: this.dom.pisosBoxes.value,
            cambioPunzones: this.dom.cambioPunzones.checked,
            cicloHorno: this.dom.cicloHorno.value,
            consumoHorno: this.dom.consumoHorno.value
        };

        const inputs = IndustrialSecurityValidator.validateAndSanitizeInputs(rawInputs, formatConfig);
        const result = ProductionCalculationEngine.computeProductionCutoff(inputs, formatConfig);
        this.currentCalculation = result;

        this._renderCalculationOutputs(result);
        this.timer.startWithMinutes(result.minutosParaCompletar, result.esCorteInmediato);
    }

    _renderCalculationOutputs(result) {
        // Badge superior
        if (this.dom.formatBadge) {
            this.dom.formatBadge.textContent = `${result.formatName} | Horno a ${result.consumoHornoM2Hora} m²/h | Calidad 1ra: ${result.calidadPrimera}%`;
        }

        // Stock en Boxes
        if (this.dom.displayM2Boxes) {
            this.dom.displayM2Boxes.textContent = `${result.stockBoxesM2} m²`;
        }

        // Consumo por minuto
        if (this.dom.displayConsumoHornoMin) {
            this.dom.displayConsumoHornoMin.textContent = `(${result.consumoHornoM2Minuto.toFixed(2)} m²/min)`;
        }

        // Los carteles textuales de "Re-pasado" se mantienen ocultos
        if (this.dom.badgeExcedente) {
            this.dom.badgeExcedente.classList.add('hidden');
        }
        if (this.dom.alertaRePasado) {
            this.dom.alertaRePasado.classList.add('hidden');
        }

        // Estado del secadero y título dinámico: se actualiza SIEMPRE,
        // también cuando el cálculo da re-pasado, para que no quede texto viejo.
        if (result.m2Secadero > 0) {
            if (this.dom.alertaSecadero) {
                this.dom.alertaSecadero.textContent = `Con cambio de punzones: se vacía secadero (+${result.m2Secadero} m² entran al cálculo)`;
                this.dom.alertaSecadero.className = 'text-xs text-amber-400 font-semibold block transition-all mt-1';
            }
            if (this.dom.lblTituloCorte) {
                this.dom.lblTituloCorte.textContent = 'HORA EXACTA DE CORTE POR CAMBIO DE PUNZONES (VACIADO DE SECADERO)';
            }
            if (this.dom.lblTlFin) {
                this.dom.lblTlFin.textContent = 'Corte Secadero:';
            }
        } else {
            if (this.dom.alertaSecadero) {
                this.dom.alertaSecadero.textContent = 'Sin cambio de punzones: corte a salida de secadero (Secadero NO entra en el cálculo: 0 m²)';
                this.dom.alertaSecadero.className = 'text-xs text-emerald-400 font-medium block transition-all mt-1';
            }
            if (this.dom.lblTituloCorte) {
                this.dom.lblTituloCorte.textContent = 'HORA DE CORTE A SALIDA DE SECADERO (CAMBIO DE PRODUCTO)';
            }
            if (this.dom.lblTlFin) {
                this.dom.lblTlFin.textContent = 'Corte Salida:';
            }
        }

        // KPIs
        if (this.dom.kpiMetrosBrutos) {
            this.dom.kpiMetrosBrutos.textContent = `${result.metrosBrutosHorno} m²`;
        }
        if (this.dom.kpiStockDescontado) {
            this.dom.kpiStockDescontado.textContent = `${result.stockTotalEnTransito} m²`;
        }
        if (this.dom.kpiMetrosNetos) {
            this.dom.kpiMetrosNetos.textContent = `${result.metrosNetosAHornear} m²`;
        }
        if (this.dom.subtleExcedente) {
            if (result.esRePasado) {
                this.dom.subtleExcedente.textContent = `+${result.excedenteM2} m² excedente`;
                this.dom.subtleExcedente.classList.remove('hidden');
            } else {
                this.dom.subtleExcedente.classList.add('hidden');
            }
        }
        if (this.dom.kpiHornoHora) {
            this.dom.kpiHornoHora.textContent = `${result.consumoHornoM2Hora} m²/h`;
        }

        // Timeline
        this.dom.tlInicio.textContent = result.inputsUsados.horaMedicion;
        this.dom.tlFin.textContent = result.horaCorteStr;


        // Display Central
        if (result.esCorteInmediato) {
            this.dom.horaCorteDisplay.textContent = 'CORTE YA';
            this.dom.horaCorteDisplay.className = 'text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-black text-red-500 tracking-tighter drop-shadow-md animate-pulse';
            this.dom.tiempoRestante.textContent = '00h 00m 00s';
            this.dom.barraProgreso.style.width = '0%';
            if (this.dom.progresoPct) this.dom.progresoPct.textContent = '0%';
        } else {
            this.dom.horaCorteDisplay.textContent = `${result.horaCorteStr} Hs`;
            this.dom.horaCorteDisplay.className = 'text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-black text-white tracking-tight drop-shadow-lg font-mono tabular-nums eco-glow-text';
            const totalSec = Math.round(result.minutosParaCompletar * 60);
            const hh = String(Math.floor(totalSec / 3600)).padStart(2, '0');
            const mm = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
            const ss = String(totalSec % 60).padStart(2, '0');
            this.dom.tiempoRestante.textContent = `${hh}h ${mm}m ${ss}s`;
            this.dom.barraProgreso.style.width = `${result.porcentajeRestanteLote.toFixed(1)}%`;
            if (this.dom.progresoPct) this.dom.progresoPct.textContent = `${result.porcentajeRestanteLote.toFixed(0)}%`;
        }

        // Aplicar estado visual y tacómetro de inmediato
        this._updateGauge(result.porcentajeRestanteLote, result.estadoAlarma);
        this._applyStateVisuals(result.estadoAlarma);
    }

    /* ══════════════════════════════════════════════════════════════
     * GAUGE SCADA: Actualización del arco SVG
     * ══════════════════════════════════════════════════════════════ */

    _updateGauge(percentage, state) {
        const gauge = INDUSTRIAL_CONFIG.GAUGE;
        const arc = this.dom.gaugeProgressArc;
        if (!arc) return;

        // Calcular longitud del arco basada en porcentaje restante proporcional al lote
        const clampedPct = Math.max(0, Math.min(100, percentage));
        const dashLength = (clampedPct / 100) * gauge.ARC_LENGTH;
        const gapLength = gauge.CIRCUMFERENCE - dashLength;

        arc.setAttribute('stroke-dasharray', `${dashLength.toFixed(1)} ${gapLength.toFixed(1)}`);

        // Actualizar colores del gradiente según estado
        const stop1 = this.dom.gaugeGradStop1;
        const stop2 = this.dom.gaugeGradStop2;
        if (!stop1 || !stop2) return;

        switch (state) {
            case 'CORTE_YA':
            case 'CORTE_INMINENTE':
                stop1.setAttribute('stop-color', '#ef4444');
                stop2.setAttribute('stop-color', '#dc2626');
                arc.style.filter = 'drop-shadow(0 0 12px rgba(239, 68, 68, 0.6))';
                break;
            case 'PRECAUCION':
                stop1.setAttribute('stop-color', '#f59e0b');
                stop2.setAttribute('stop-color', '#d97706');
                arc.style.filter = 'drop-shadow(0 0 10px rgba(245, 158, 11, 0.5))';
                break;
            case 'NOMINAL':
            default:
                stop1.setAttribute('stop-color', '#10b981');
                stop2.setAttribute('stop-color', '#06b6d4');
                arc.style.filter = 'drop-shadow(0 0 8px rgba(16, 185, 129, 0.4))';
                break;
        }
    }

    _onTimerTick(tick) {
        if (!this.currentCalculation) return;

        if (this.currentCalculation.esCorteInmediato || tick.isExpired) {
            this.dom.tiempoRestante.textContent = '00h 00m 00s';
            this.dom.barraProgreso.style.width = '0%';
            if (this.dom.progresoPct) this.dom.progresoPct.textContent = '0%';
            this._updateGauge(0, 'CORTE_YA');
            this._applyStateVisuals('CORTE_YA');
            return;
        }

        const hh = String(tick.hours).padStart(2, '0');
        const mm = String(tick.minutes).padStart(2, '0');
        const ss = String(tick.seconds).padStart(2, '0');
        this.dom.tiempoRestante.textContent = `${hh}h ${mm}m ${ss}s`;

        // Tacómetro y barra proporcionales al tiempo total estimado del lote
        const totalLoteMinutos = this.currentCalculation.minutosTotalesLoteHorno || 1;
        const minutosRestantes = tick.totalSecondsRemaining / 60;
        const pct = Math.min(100, Math.max(0, (minutosRestantes / totalLoteMinutos) * 100));

        this.dom.barraProgreso.style.width = `${pct.toFixed(1)}%`;
        if (this.dom.progresoPct) {
            this.dom.progresoPct.textContent = `${pct.toFixed(0)}%`;
        }

        // Actualizar Gauge SCADA
        this._updateGauge(pct, tick.state);
        this._applyStateVisuals(tick.state);
    }

    _onStateChange(newState) {
        this._applyStateVisuals(newState);
    }

    _applyStateVisuals(state) {
        const panel = this.dom.panelMonitor;
        const badge = this.dom.statusBadgeText;
        const dot = this.dom.statusDot;
        if (!panel) return;

        // Limpiar clases de estado anteriores
        panel.classList.remove(
            'animate-eco-critical', 'animate-eco-warning',
            'state-corte-ya', 'state-corte-inminente', 'state-precaucion',
            'border-red-500', 'border-amber-400'
        );

        switch (state) {
            case 'CORTE_YA':
                panel.classList.add('animate-eco-critical', 'state-corte-ya');
                panel.style.borderColor = '#dc2626';
                if (badge) {
                    badge.textContent = 'CORTE YA - REALIZAR TRANSICIÓN';
                    badge.className = 'font-bold text-red-500 text-[10px] sm:text-xs tracking-wider uppercase';
                }
                if (dot) dot.className = 'w-2.5 h-2.5 sm:w-3 sm:h-3 bg-red-600 rounded-full animate-ping';
                this.dom.tiempoRestante.className = 'text-2xl sm:text-3xl md:text-4xl font-black font-mono tabular-nums text-red-500';
                this.dom.barraProgreso.className = 'h-full rounded-full transition-all duration-500 bg-red-600';
                this.dom.barraProgreso.style.boxShadow = '0 0 8px rgba(239,68,68,0.4)';
                break;

            case 'CORTE_INMINENTE':
                panel.classList.add('animate-eco-critical', 'state-corte-inminente');
                panel.style.borderColor = '#dc2626';
                if (badge) {
                    badge.textContent = 'CORTE INMINENTE (< 15 MIN)';
                    badge.className = 'font-bold text-red-400 text-[10px] sm:text-xs tracking-wider uppercase';
                }
                if (dot) dot.className = 'w-2.5 h-2.5 sm:w-3 sm:h-3 bg-red-500 rounded-full animate-pulse';
                this.dom.tiempoRestante.className = 'text-2xl sm:text-3xl md:text-4xl font-black font-mono tabular-nums text-red-400';
                this.dom.barraProgreso.className = 'h-full rounded-full transition-all duration-500 bg-red-500';
                this.dom.barraProgreso.style.boxShadow = '0 0 8px rgba(239,68,68,0.3)';
                break;

            case 'PRECAUCION':
                panel.classList.add('animate-eco-warning', 'state-precaucion');
                panel.style.borderColor = '#d97706';
                if (badge) {
                    badge.textContent = 'PRECAUCIÓN - PREPARAR TRANSICIÓN';
                    badge.className = 'font-bold text-amber-400 text-[10px] sm:text-xs tracking-wider uppercase';
                }
                if (dot) dot.className = 'w-2.5 h-2.5 sm:w-3 sm:h-3 bg-amber-500 rounded-full';
                this.dom.tiempoRestante.className = 'text-2xl sm:text-3xl md:text-4xl font-black font-mono tabular-nums text-amber-400';
                this.dom.barraProgreso.className = 'h-full rounded-full transition-all duration-500 bg-amber-500';
                this.dom.barraProgreso.style.boxShadow = '0 0 8px rgba(245,158,11,0.3)';
                break;

            case 'NOMINAL':
            default:
                panel.style.borderColor = '';
                if (badge) {
                    badge.textContent = 'HORNO EN QUEMA ACTIVA';
                    badge.className = 'font-bold text-emerald-400 text-[10px] sm:text-xs tracking-wider uppercase';
                }
                if (dot) dot.className = 'w-2.5 h-2.5 sm:w-3 sm:h-3 bg-emerald-500 rounded-full';
                this.dom.tiempoRestante.className = 'text-2xl sm:text-3xl md:text-4xl font-black font-mono tabular-nums text-emerald-400';
                this.dom.barraProgreso.className = 'h-full rounded-full transition-all duration-500 eco-progress-bar';
                this.dom.barraProgreso.style.boxShadow = '';
                break;
        }
    }

    toggleLightMode() {
        const isLight = document.body.classList.toggle('light-mode');
        localStorage.setItem('product-sync-theme', isLight ? 'light' : 'dark');
        this._updateLightModeIcon(isLight);
    }

    _updateLightModeIcon(isLight) {
        if (!this.dom.btnLightMode) return;
        const svg = this.dom.btnLightMode.querySelector('svg');
        if (!svg) return;
        if (isLight) {
            svg.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"></path>';
        } else {
            svg.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0"></path>';
        }
    }

}

document.addEventListener('DOMContentLoaded', () => {
    const app = new SincroCambioApp();
    app.init();
});