import { WorldViewGlobe as StaticGlobe } from '/assets/world-view.js?v=world-view-20260928';

// ENCOM bundles Three r66. Own the actual canvas/context rather than calling
// newer renderer methods (dispose/forceContextLoss) that r66 does not have.
let assets;
function loadAssets() {
    if (assets) return assets;
    const script = window.ENCOM?.Globe ? Promise.resolve() : new Promise((resolve, reject) => {
        const element = document.createElement('script');
        const timer = setTimeout(() => finish(new Error('Globe script timed out')), 15000);
        const finish = error => {
            clearTimeout(timer); element.onload = element.onerror = null;
            if (error) { element.remove(); reject(error); } else resolve();
        };
        element.src = '/assets/vendor/encom-globe.js?v=world-view-animated-20260928';
        element.onload = () => finish();
        element.onerror = () => finish(new Error('Globe script unavailable'));
        document.head.appendChild(element);
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const grid = fetch('/assets/vendor/grid.json?v=12', { signal: controller.signal, credentials: 'same-origin' })
        .then(response => { if (!response.ok) throw new Error('Globe map unavailable'); return response.json(); })
        .finally(() => clearTimeout(timer));
    assets = Promise.all([script, grid]).then(([, data]) => {
        if (!Array.isArray(data.tiles) || !window.ENCOM?.Globe) throw new Error('Invalid globe assets');
        return data.tiles;
    });
    assets.catch(() => { assets = null; });
    return assets;
}

function palette() {
    const style = getComputedStyle(document.documentElement);
    // Match the original widget's canvas palette, including theme RGB overrides.
    return { accent: `rgb(${style.getPropertyValue('--soa-accent-rgb').trim() || '170, 207, 209'})`,
        background: (style.getPropertyValue('--soa-bg') || '#05080d').trim() };
}

function disposeScene(scene) {
    if (!scene) return;
    clearTimeout(scene._initTimer);
    scene.stopAnimations?.();
    const disposed = new Set();
    const dispose = resource => {
        if (!resource || disposed.has(resource)) return;
        disposed.add(resource);
        try { resource.dispose?.(); } catch (_) {}
    };
    const object = node => {
        dispose(node.geometry);
        for (const material of [].concat(node.material?.materials || node.material || [])) {
            for (const value of Object.values(material)) if (value?.image) dispose(value);
            for (const uniform of Object.values(material.uniforms || {})) if (uniform.value?.image) dispose(uniform.value);
            dispose(material);
        }
    };
    scene.scene?.traverse(object);
    // Intro lines may already be detached from the live scene.
    scene.introLines?.traverse(object);
    while (scene.scene?.children.length) scene.scene.remove(scene.scene.children[0]);
}

export class AnimatedWorldView {
    constructor(label) {
        this.domElement = document.createElement('div');
        this.domElement.dataset.worldView = 'animated';
        this.domElement.setAttribute('role', 'img');
        Object.assign(this.domElement.style, { width: '100%', height: '100%' });
        this._label = label;
        this._pins = new Set();
        this._active = true;
        this._retries = 0;
        this._generation = 0;
        this._motion = matchMedia('(prefers-reduced-motion: reduce)');
        this._onMotion = () => { this._cancelFrames(); this._paint(); this._schedule(); };
        this._motion.addEventListener('change', this._onMotion);
        this._onVisibility = () => { this._cancelFrames(); this._schedule(); };
        document.addEventListener('visibilitychange', this._onVisibility);
        this._appearance = new MutationObserver(() => {
            const next = palette();
            if (this._colors && (next.accent !== this._colors.accent || next.background !== this._colors.background)) this._restart();
        });
        this._appearance.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ui', 'data-theme'] });
        this._resize = new ResizeObserver(() => {
            if (!this._scene) return;
            const { width, height } = this.domElement.getBoundingClientRect();
            if (width < 1 || height < 1) return;
            this._scene.camera.aspect = width / height;
            this._scene.camera.updateProjectionMatrix();
            this._scene.renderer.setSize(width, height);
            this._paint();
        });
        this._resize.observe(this.domElement);
        this._intersection = new IntersectionObserver(entries => {
            this._offscreen = !entries.at(-1)?.isIntersecting;
            this._cancelFrames(); this._schedule();
        });
        this._intersection.observe(this.domElement);
        this._showFallback('loading');
        this._ready = this._boot();
    }

    setLabel(label) {
        this._label = label;
        this.domElement.setAttribute('aria-label', label);
        this._fallback?.setLabel(label);
    }

    // The original camera keeps its orbit. Focus is used by the fallback only.
    setFocus(lat, lon) { this._focus = [lat, lon]; this._fallback?.setFocus(lat, lon); }

    addPin(lat, lon, label = '', altitude = 1) {
        if (this._destroyed || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return null;
        const pin = { args: [Number(lat), Number(lon), String(label), altitude], remove: () => {
            this._pins.delete(pin);
            pin.live?.remove(); pin.fallback?.remove();
            pin.live = pin.fallback = null;
            this._paint();
        } };
        this._pins.add(pin);
        if (this._scene) pin.live = this._scene.addPin(...pin.args);
        if (this._fallback) pin.fallback = this._fallback.addPin(...pin.args);
        this._paint();
        return pin;
    }

    setActive(active) { this._active = active; this._cancelFrames(); this._schedule(); }

    async _boot() {
        const generation = ++this._generation;
        try {
            const tiles = await loadAssets();
            if (this._destroyed || generation !== this._generation) return;
            // The owner attaches our host synchronously; assets await gives it
            // time to enter the DOM without allocating a probe context first.
            const { width, height } = this.domElement.getBoundingClientRect();
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('webgl', { alpha: true, antialias: true, stencil: true }) ||
                canvas.getContext('experimental-webgl', { alpha: true, antialias: true, stencil: true });
            if (!context) throw new Error('WebGL unavailable');
            this._canvas = canvas; this._gl = context;
            this._lose = context.getExtension('WEBGL_lose_context');
            this._onLoss = event => {
                event.preventDefault();
                if (!this._destroyed && canvas === this._canvas) this._fail(true);
            };
            canvas.addEventListener('webglcontextlost', this._onLoss, { passive: false });
            this._colors = palette();
            const accent = this._colors.accent;
            const scene = this._scene = new window.ENCOM.Globe(width || 240, height || 170, {
                canvas, context, devicePixelRatio: Math.min(devicePixelRatio || 1, 2),
                font: 'Fira Mono, ui-monospace, Menlo, monospace', data: [], tiles,
                baseColor: accent, markerColor: accent, pinColor: accent, satelliteColor: accent,
                scale: 1.1, viewAngle: 0.630, dayLength: 1000 * 45,
                introLinesDuration: 2000, introLinesColor: accent, maxPins: 32, maxMarkers: 32,
            });
            canvas.setAttribute('aria-hidden', 'true');
            scene.init(this._colors.background, () => {
                if (this._destroyed || generation !== this._generation || this._scene !== scene) return;
                this._paint();
                if (this._scene !== scene) return;
                this._fallback?.destroy(); this._fallback = null;
                for (const pin of this._pins) pin.fallback = null;
                this.domElement.replaceChildren(canvas);
                this.domElement.dataset.renderer = 'webgl';
                this._schedule();
            });
            const satellites = [];
            for (let i = 0; i < 2; i++) for (let j = 0; j < 3; j++) {
                satellites.push({ lat: 50 * i - 15, lon: 120 * j - 120, altitude: 1.5 });
            }
            scene.addConstellation(satellites);
            for (const pin of this._pins) pin.live = scene.addPin(...pin.args);
        } catch (_) {
            if (!this._destroyed && generation === this._generation) this._fail(false);
        }
    }

    _paint() {
        if (!this._scene || this._destroyed) return;
        try {
            if (this._gl.isContextLost()) { this._fail(true); return; }
            if (this._motion.matches) {
                // A still globe must show land, not freeze on the empty intro.
                this._scene.firstRenderDate = new Date(Date.now() - 2500);
                for (const pin of this._pins) {
                    if (!pin.live) continue;
                    pin.live.showTop(); pin.live.showLabel();
                    const vertices = pin.live.lineGeometry.vertices;
                    vertices[1].copy(vertices[0]).multiplyScalar(pin.args[3]);
                    pin.live.lineGeometry.verticesNeedUpdate = true;
                }
            }
            const scene = this._scene;
            const dayLength = scene.dayLength;
            // Resize, pin updates and a delayed media-change event may still
            // request a paint. None may rotate the camera under reduced motion.
            if (this._motion.matches) scene.dayLength = Infinity;
            try { scene.tick(); } finally { scene.dayLength = dayLength; }
        } catch (_) { this._fail(true); }
    }

    _schedule() {
        if (this._destroyed || !this._scene || this._timer || this._raf || !this._active ||
            document.hidden || this._offscreen || this._motion.matches) return;
        // Keep the original slow orbit at ~24 fps, yielding to terminal input.
        this._scene.lastRenderDate = new Date();
        this._timer = setTimeout(() => {
            this._timer = null;
            this._raf = requestAnimationFrame(() => {
                this._raf = null;
                if (this._destroyed || !this._active || document.hidden || this._offscreen || this._motion.matches) return;
                if (window.__soaLoad !== 'high' && performance.now() - (window.__soaLastInteract || -1000) > 300) this._paint();
                this._schedule();
            });
        }, 42);
    }

    _cancelFrames() {
        clearTimeout(this._timer); this._timer = null;
        if (this._raf) cancelAnimationFrame(this._raf);
        this._raf = null;
    }

    _release() {
        this._cancelFrames();
        if (this._canvas && this._onLoss) this._canvas.removeEventListener('webglcontextlost', this._onLoss);
        const scene = this._scene;
        this._scene = null;
        try { disposeScene(scene); } catch (_) {}
        // This is the actual r66 context. Removing a canvas or calling missing
        // renderer methods leaves its slot alive; this releases it immediately.
        try { if (this._gl && !this._gl.isContextLost()) this._lose?.loseContext(); } catch (_) {}
        if (this._canvas) { this._canvas.remove(); this._canvas.width = this._canvas.height = 0; }
        this._canvas = this._gl = this._lose = this._onLoss = null;
        for (const pin of this._pins) pin.live = null;
    }

    _showFallback(state = 'fallback') {
        this._fallback?.destroy();
        this._fallback = new StaticGlobe(this._label);
        if (this._focus) this._fallback.setFocus(...this._focus);
        for (const pin of this._pins) pin.fallback = this._fallback.addPin(...pin.args);
        this.domElement.replaceChildren(this._fallback.domElement);
        this.domElement.dataset.renderer = state;
        this.setLabel(this._label);
    }

    _fail(retry) {
        ++this._generation;
        this._release();
        this._showFallback();
        clearTimeout(this._retryTimer);
        if (retry && ++this._retries <= 2) {
            this._retryTimer = setTimeout(() => { if (!this._destroyed) this._ready = this._boot(); }, 2000 * this._retries);
        }
    }

    _restart() {
        if (this._destroyed) return;
        ++this._generation;
        clearTimeout(this._retryTimer);
        this._release(); this._showFallback('loading');
        this._ready = this._boot();
    }

    destroy() {
        this._destroyed = true; ++this._generation;
        clearTimeout(this._retryTimer);
        this._release();
        this._resize.disconnect(); this._intersection.disconnect(); this._appearance.disconnect();
        this._motion.removeEventListener('change', this._onMotion);
        document.removeEventListener('visibilitychange', this._onVisibility);
        this._fallback?.destroy(); this._fallback = null;
        this._pins.clear(); this.domElement.remove();
    }
}
