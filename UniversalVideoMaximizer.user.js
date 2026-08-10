// ==UserScript==
// @name         Universal Video Maximizer (Enhanced)
// @namespace    http://tampermonkey.net/
// @version      9.4
// @description  Ctrl+F11 = Maximize video. Full Shadow DOM support, VK/vkvideo.ru native, smart detection. Fixes SPA playlist navigation.
// @author       Kristijan1001 (enhanced)
// @match        *://*/*
// @license      MIT
// @grant        none
// @run-at       document-start
// @icon         data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3QgeD0iMiIgeT0iMiIgd2lkdGg9IjIwIiBoZWlnaHQ9IjIwIiByeD0iNiIgZmlsbD0iIzE1MTUxNSIvPjxwYXRoIGQ9Ik0xMCA4VjE2TDE2IDEyTDEwIDhaIiBmaWxsPSIjZmZmZmZmIi8+PC9zdmc+
// @downloadURL https://update.greasyfork.org/scripts/560411/Universal%20Video%20Maximizer%20%28Enhanced%29.user.js
// @updateURL https://update.greasyfork.org/scripts/560411/Universal%20Video%20Maximizer%20%28Enhanced%29.meta.js
// ==/UserScript==

(function () {
    'use strict';

    // ─── PERSISTENT STATE ────────────────────────────────────────────────────

    let enabled = false;
    let overlay = null;
    let video = null;
    let videoShadowRoot = null;
    let maximizedContainer = null;
    let originalContainerStyles = {};
    let originalVideoStyles = null;
    let originalParent = null;
    let originalNextSibling = null;
    let useInPlaceMode = false;
    let overlayBodyScrollStyle = '';
    let _vkStyleGuardian = null;
    let _vkSpaObserver = null; // NEW: watches for vk-video-player replacement on SPA nav

    let savedVolume       = parseFloat(localStorage.getItem('univ_max_volume') ?? 'NaN');
    let savedMuted        = localStorage.getItem('univ_max_muted') === 'true';
    let savedPlaybackRate = parseFloat(localStorage.getItem('univ_max_rate')) || 1.0;

    const OVERLAY_ID = 'universal-video-overlay';

    // ─── SITE DETECTION ──────────────────────────────────────────────────────

    const host = location.hostname;
    const isVK      = host.includes('vk.com') || host.includes('vkvideo.ru');
    const isYT      = host.includes('youtube.com') || host.includes('youtu.be');
    const isTwitch  = host.includes('twitch.tv');
    const isTwitter = host.includes('twitter.com') || host.includes('x.com');

    // ─── SHADOW DOM PIERCING ─────────────────────────────────────────────────

    function queryShadowAll(selector, root = document, results = []) {
        try {
            results.push(...Array.from(root.querySelectorAll(selector)));
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
            let node;
            while ((node = walker.nextNode())) {
                if (node.shadowRoot) queryShadowAll(selector, node.shadowRoot, results);
            }
        } catch (e) {}
        return results;
    }

    function findAllVideosWithContext(root = document, parentShadow = null, results = []) {
        try {
            for (const v of root.querySelectorAll('video')) {
                results.push({ video: v, shadowRoot: parentShadow });
            }
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
            let node;
            while ((node = walker.nextNode())) {
                if (node.shadowRoot) findAllVideosWithContext(node.shadowRoot, node.shadowRoot, results);
            }
        } catch (e) {}
        return results;
    }

    // ─── VIDEO SCORING ───────────────────────────────────────────────────────

    const MIN_WIDTH = 200, MIN_HEIGHT = 120, MIN_DURATION = 3;

    function scoreVideo(entry) {
        const { video: v } = entry;
        let score = 0;
        try {
            const rect = v.getBoundingClientRect();
            if (rect.width < MIN_WIDTH || rect.height < MIN_HEIGHT) return -1;
            if (rect.width === 0 || rect.height === 0) return -1;
            const cs = window.getComputedStyle(v);
            if (cs.display === 'none' || cs.visibility === 'hidden') return -1;
            if (v.duration && v.duration < MIN_DURATION && v.duration !== Infinity) return -1;
            const cls = String(v.className || '').toLowerCase();
            if (cls.includes('ad-preview') || cls.includes('taboola') || cls.includes('outbrain')) return -1;
            score += rect.width * rect.height;
            if (!v.paused) score += 500000;
            if (v.duration && v.duration > 30) score += 200000;
            if (v.duration && v.duration === Infinity) score += 100000;
        } catch (e) { return -1; }
        return score;
    }

    function findMainVideo() {
        const all = findAllVideosWithContext();
        let best = null, bestScore = -1;
        for (const entry of all) {
            const s = scoreVideo(entry);
            if (s > bestScore) { bestScore = s; best = entry; }
        }
        if (best) return best;
        const iframes = Array.from(document.querySelectorAll('iframe'));
        let bestIframe = null, maxArea = 0;
        for (const f of iframes) {
            const rect = f.getBoundingClientRect();
            if (rect.width < MIN_WIDTH || rect.height < MIN_HEIGHT) continue;
            const src = (f.src || '').toLowerCase();
            if (!src.includes('player') && !src.includes('embed') && !src.includes('video')) continue;
            const area = rect.width * rect.height;
            if (area > maxArea) { maxArea = area; bestIframe = f; }
        }
        if (bestIframe) return { video: bestIframe, shadowRoot: null, isIframe: true };
        return null;
    }

    // ─── VK STYLE GUARDIAN ───────────────────────────────────────────────────

    function startVkStyleGuardian(containerEl) {
        stopVkStyleGuardian();
        const reapply = () => {
            if (!enabled || !useInPlaceMode) return;
            containerEl.style.setProperty('position', 'fixed', 'important');
            containerEl.style.setProperty('top', '0', 'important');
            containerEl.style.setProperty('left', '0', 'important');
            containerEl.style.setProperty('width', '100vw', 'important');
            containerEl.style.setProperty('height', '100vh', 'important');
            containerEl.style.setProperty('z-index', '2147483647', 'important');
            containerEl.style.setProperty('background', '#000', 'important');
            containerEl.style.setProperty('margin', '0', 'important');
            containerEl.style.setProperty('border-radius', '0', 'important');
            containerEl.style.setProperty('transform', 'none', 'important');
        };
        _vkStyleGuardian = new MutationObserver((muts) => {
            for (const m of muts) {
                if (m.type === 'attributes' && m.attributeName === 'style') {
                    Promise.resolve().then(reapply);
                }
                if (m.type === 'childList') {
                    Promise.resolve().then(reapply);
                }
            }
        });
        _vkStyleGuardian.observe(containerEl, { attributes: true, attributeFilter: ['style'] });
        if (containerEl.parentElement) {
            _vkStyleGuardian.observe(containerEl.parentElement, { childList: true });
        }
    }

    function stopVkStyleGuardian() {
        if (_vkStyleGuardian) {
            _vkStyleGuardian.disconnect();
            _vkStyleGuardian = null;
        }
    }

    // ─── NEW: VK SPA NAVIGATION OBSERVER ─────────────────────────────────────
    // VKvideo destroys and recreates <vk-video-player> on every playlist navigation.
    // The stable parent DIV (VideoPlayer__player--...) persists. We watch it and
    // re-apply all maximizer styles whenever a new <vk-video-player> is inserted.

    function startVkSpaObserver(containerEl) {
        stopVkSpaObserver();
        const stableParent = containerEl.parentElement;
        if (!stableParent) return;

        _vkSpaObserver = new MutationObserver((muts) => {
            if (!enabled) return;
            for (const m of muts) {
                if (m.type !== 'childList') continue;
                const addedVkPlayer = Array.from(m.addedNodes)
                    .find(n => n.nodeType === 1 && n.tagName === 'VK-VIDEO-PLAYER');
                if (!addedVkPlayer) continue;

                // New vk-video-player was inserted — stop old guardian (stale element)
                stopVkStyleGuardian();

                // Small delay to let VK finish initialising the new element's shadow DOM
                setTimeout(() => {
                    if (!enabled) return;

                    const newContainer = addedVkPlayer;
                    maximizedContainer = newContainer;

                    // Re-snapshot styles for restore-on-exit
                    const elementsToFix = [];
                    let el = newContainer;
                    while (el && el !== document.body.parentElement) {
                        elementsToFix.push(el);
                        el = el.parentElement;
                    }
                    originalContainerStyles = elementsToFix.map(e => ({ el: e, style: e.getAttribute('style') || '' }));

                    // Fix overflow on ancestors
                    for (let i = 1; i < elementsToFix.length; i++) {
                        const e = elementsToFix[i];
                        const cs = window.getComputedStyle(e);
                        if (cs.overflow !== 'visible') e.style.setProperty('overflow', 'visible', 'important');
                    }

                    // Apply fullscreen styles to new container
                    newContainer.style.setProperty('position', 'fixed', 'important');
                    newContainer.style.setProperty('top', '0', 'important');
                    newContainer.style.setProperty('left', '0', 'important');
                    newContainer.style.setProperty('width', '100vw', 'important');
                    newContainer.style.setProperty('height', '100vh', 'important');
                    newContainer.style.setProperty('z-index', '2147483647', 'important');
                    newContainer.style.setProperty('background', '#000', 'important');
                    newContainer.style.setProperty('margin', '0', 'important');
                    newContainer.style.setProperty('border-radius', '0', 'important');
                    newContainer.style.setProperty('transform', 'none', 'important');

                    // Re-find video inside new shadow DOM
                    const searchRoot = newContainer.shadowRoot || newContainer;
                    const newVideoEntries = findAllVideosWithContext(searchRoot);
                    if (newVideoEntries.length > 0) {
                        video = newVideoEntries[0].video;
                        videoShadowRoot = newVideoEntries[0].shadowRoot;

                        if (newContainer.shadowRoot) {
                            const internalVideoContainer = video.closest('.video-wrapper, .video-container, [class*="video-wrap"]');
                            const internalPlayerRoot = video.closest('[class*="vk-vp-root"], [class*="player-wrapper"]');
                            [video, internalVideoContainer, internalPlayerRoot].forEach(v => {
                                if (!v) return;
                                v.style.setProperty('width', '100vw', 'important');
                                v.style.setProperty('height', '100vh', 'important');
                                v.style.setProperty('max-width', '100vw', 'important');
                                v.style.setProperty('max-height', '100vh', 'important');
                                v.style.setProperty('object-fit', 'contain', 'important');
                            });
                        }

                        try {
                            if (!isNaN(savedVolume)) video.volume = savedVolume;
                            video.muted = savedMuted;
                            video.playbackRate = savedPlaybackRate;
                        } catch (e) {}

                        if (video.paused) video.play().catch(() => {});
                    }

                    // Keep body overflow hidden
                    document.body.style.setProperty('overflow', 'hidden', 'important');

                    // Restart style guardian on the new element
                    startVkStyleGuardian(newContainer);

                    // Recreate exit button UI (old one had a stale container ref)
                    createInPlaceUI(newContainer);

                }, 300);
            }
        });

        _vkSpaObserver.observe(stableParent, { childList: true });
    }

    function stopVkSpaObserver() {
        if (_vkSpaObserver) {
            _vkSpaObserver.disconnect();
            _vkSpaObserver = null;
        }
    }

    // ─── VK / SHADOW-DOM IN-PLACE MAXIMIZER ──────────────────────────────────

    function getPlayerHostContainer(videoEl) {
        const vkPlayer = document.querySelector('vk-video-player');
        if (vkPlayer) return vkPlayer;
        let el = videoEl;
        const rootNode = videoEl.getRootNode();
        if (rootNode instanceof ShadowRoot) el = rootNode.host;
        while (el && el !== document.body) {
            const rect = el.getBoundingClientRect();
            if (rect.width >= 400 && rect.height >= 200) return el;
            el = el.parentElement;
        }
        return document.body;
    }

    function applyInPlaceMaximize(containerEl) {
        const elementsToFix = [];
        let el = containerEl;
        while (el && el !== document.body.parentElement) {
            elementsToFix.push(el);
            el = el.parentElement;
        }
        const saved = elementsToFix.map(e => ({ el: e, style: e.getAttribute('style') || '' }));
        maximizedContainer = containerEl;
        originalContainerStyles = saved;

        for (let i = 1; i < elementsToFix.length; i++) {
            const e = elementsToFix[i];
            const cs = window.getComputedStyle(e);
            if (cs.overflow !== 'visible') e.style.setProperty('overflow', 'visible', 'important');
        }

        containerEl.style.setProperty('position', 'fixed', 'important');
        containerEl.style.setProperty('top', '0', 'important');
        containerEl.style.setProperty('left', '0', 'important');
        containerEl.style.setProperty('width', '100vw', 'important');
        containerEl.style.setProperty('height', '100vh', 'important');
        containerEl.style.setProperty('z-index', '2147483647', 'important');
        containerEl.style.setProperty('background', '#000', 'important');
        containerEl.style.setProperty('margin', '0', 'important');
        containerEl.style.setProperty('border-radius', '0', 'important');
        containerEl.style.setProperty('transform', 'none', 'important');

        const rootNode = video.getRootNode();
        if (rootNode instanceof ShadowRoot) {
            const internalVideoContainer = video.closest('.video-wrapper, .video-container, [class*="video-wrap"]');
            const internalPlayerRoot = video.closest('[class*="vk-vp-root"], [class*="player-wrapper"]');
            [video, internalVideoContainer, internalPlayerRoot].forEach(v => {
                if (!v) return;
                v.style.setProperty('width', '100vw', 'important');
                v.style.setProperty('height', '100vh', 'important');
                v.style.setProperty('max-width', '100vw', 'important');
                v.style.setProperty('max-height', '100vh', 'important');
                v.style.setProperty('object-fit', 'contain', 'important');
            });
        }

        overlayBodyScrollStyle = document.body.getAttribute('style') || '';
        document.body.style.setProperty('overflow', 'hidden', 'important');

        // Start guardian AFTER applying styles so it watches for VK overwriting them
        startVkStyleGuardian(containerEl);

        // NEW: start SPA observer so playlist navigation keeps fullscreen
        startVkSpaObserver(containerEl);

        createInPlaceUI(containerEl);
    }

    function removeInPlaceMaximize() {
        if (!maximizedContainer) return;

        // Stop BOTH observers first so they don't fight us while restoring
        stopVkStyleGuardian();
        stopVkSpaObserver(); // NEW

        for (const { el, style } of originalContainerStyles) {
            if (style) el.setAttribute('style', style);
            else el.removeAttribute('style');
        }
        maximizedContainer = null;
        originalContainerStyles = {};

        if (video) {
            const rootNode = video.getRootNode();
            if (rootNode instanceof ShadowRoot) {
                const internalVideoContainer = video.closest('.video-wrapper, .video-container, [class*="video-wrap"]');
                const internalPlayerRoot = video.closest('[class*="vk-vp-root"], [class*="player-wrapper"]');
                [video, internalVideoContainer, internalPlayerRoot].forEach(v => { if (v) v.removeAttribute('style'); });
            }
        }

        if (overlayBodyScrollStyle) document.body.setAttribute('style', overlayBodyScrollStyle);
        else document.body.removeAttribute('style');

        document.getElementById('uvmax-inplace-ui')?.remove();
    }

    function createInPlaceUI(container) {
        document.getElementById('uvmax-inplace-ui')?.remove();
        injectStyles();
        const ui = document.createElement('div');
        ui.id = 'uvmax-inplace-ui';
        ui.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
            z-index: 2147483648; pointer-events: none;
        `;
        const exitBtn = document.createElement('button');
        exitBtn.className = 'fancy-exit-btn';
        exitBtn.style.pointerEvents = 'all';
        exitBtn.style.opacity = '0';
        exitBtn.style.transition = 'opacity 0.3s ease';
        exitBtn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3"
                 stroke-linecap="round" stroke-linejoin="round">
                <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
            Exit
        `;
        exitBtn.onclick = removeMaxMode;
        ui.append(exitBtn);
        document.documentElement.appendChild(ui);

        let hideTimer;
        const showUI = () => {
            exitBtn.style.opacity = '1';
            clearTimeout(hideTimer);
            hideTimer = setTimeout(() => { exitBtn.style.opacity = '0'; }, 2000);
        };
        exitBtn.addEventListener('mouseenter', () => clearTimeout(hideTimer));
        exitBtn.addEventListener('mouseleave', () => {
            hideTimer = setTimeout(() => { exitBtn.style.opacity = '0'; }, 800);
        });
        document.addEventListener('mousemove', showUI, { passive: true });
        const origRemove = ui.remove.bind(ui);
        ui.remove = () => {
            document.removeEventListener('mousemove', showUI);
            origRemove();
        };
    }

    // ─── STYLES ───────────────────────────────────────────────────────────────

    function injectStyles() {
        if (document.getElementById('univ-video-styles')) return;
        const css = `
            #${OVERLAY_ID} {
                position: fixed !important; top: 0 !important; left: 0 !important;
                width: 100vw !important; height: 100vh !important;
                background: #000 !important; z-index: 2147483647 !important;
                display: flex !important; align-items: center !important;
                justify-content: center !important; overflow: hidden !important;
            }
            .uvmax-container {
                position: relative; width: 100%; height: 100%;
                background: black; display: flex;
                align-items: center; justify-content: center;
            }
            .uvmax-controls-overlay {
                position: absolute; bottom: 0; left: 0; right: 0;
                background: linear-gradient(to top,rgba(0,0,0,0.85) 0%,rgba(0,0,0,0.4) 60%,transparent 100%);
                padding: 12px 30px 22px 20px;
                opacity: 0; transition: opacity 0.3s ease; pointer-events: all;
            }
            .fancy-exit-btn {
                position: absolute; top: 20px; right: 20px;
                background: linear-gradient(135deg,rgba(239,68,68,0.3),rgba(220,38,38,0.3));
                border: 1px solid rgba(239,68,68,0.6);
                color: white; padding: 8px 16px; border-radius: 16px; cursor: pointer;
                font-size: 13px; font-weight: 700; backdrop-filter: blur(20px);
                box-shadow: 0 8px 32px rgba(239,68,68,0.35);
                transition: opacity 0.3s ease, transform 0.35s ease, background 0.35s ease;
                display: flex; align-items: center; gap: 6px; font-family: sans-serif;
                opacity: 0; pointer-events: all;
            }
            .fancy-exit-btn:hover {
                transform: translateY(-2px) scale(1.05);
                background: linear-gradient(135deg,rgba(239,68,68,0.55),rgba(220,38,38,0.55));
            }
            .fancy-exit-btn:active { transform: scale(0.97); }
            .uvmax-progress-container {
                width: 100%; height: 18px; cursor: pointer; position: relative;
                display: flex; align-items: center; padding: 7px 0; margin-bottom: 8px;
            }
            .uvmax-progress-bg {
                width: 100%; height: 4px; background: rgba(255,255,255,0.25);
                border-radius: 2px; position: relative;
            }
            .uvmax-progress-fill {
                height: 100%;
                background: linear-gradient(90deg, #f09433, #e6683c);
                border-radius: 3px; width: 0%; transition: width 0.1s linear; position: relative;
            }
            .uvmax-progress-thumb {
                position: absolute; right: -6px; top: 50%; transform: translateY(-50%);
                width: 13px; height: 13px; background: #f09433; border-radius: 50%;
                opacity: 0; transition: opacity 0.3s; box-shadow: 0 2px 8px rgba(0,0,0,0.4);
            }
            .uvmax-controls-overlay:hover .uvmax-progress-thumb { opacity: 1; }
            .uvmax-controls-row { display: flex; align-items: center; gap: 14px; pointer-events: all; }
            .uvmax-play-btn {
                background: rgba(255,255,255,0.15);
                border: 1px solid rgba(255,255,255,0.2);
                color: white; cursor: pointer; padding: 0; border-radius: 50%;
                width: 46px; height: 46px;
                display: flex; align-items: center; justify-content: center;
                backdrop-filter: blur(10px);
                box-shadow: 0 4px 14px rgba(0,0,0,0.35);
                transition: all 0.25s cubic-bezier(0.34,1.56,0.64,1); flex-shrink: 0;
            }
            .uvmax-play-btn:hover {
                background: rgba(255,255,255,0.28); border-color: rgba(255,255,255,0.45);
                transform: scale(1.1); box-shadow: 0 6px 22px rgba(0,0,0,0.45);
            }
            .uvmax-play-btn:active { transform: scale(0.94); }
            .uvmax-play-btn svg { filter: drop-shadow(0 2px 4px rgba(0,0,0,0.5)); }
            .uvmax-time {
                color: white; font-size: 12px; font-weight: 600; min-width: 95px;
                text-shadow: 0 1px 3px rgba(0,0,0,0.8); font-family: sans-serif;
            }
            .uvmax-speed-btn {
                background: rgba(255,255,255,0.18); border: none; color: white;
                font-size: 11px; font-weight: 700; cursor: pointer;
                padding: 5px 11px; border-radius: 14px; transition: all 0.25s;
                min-width: 42px; font-family: sans-serif;
            }
            .uvmax-speed-btn:hover { background: rgba(255,255,255,0.32); }
            .uvmax-volume-wrap { display: flex; align-items: center; gap: 8px; margin-left: auto; margin-right: 12px; }
            .uvmax-mute-btn {
                background: none; border: none; color: white; font-size: 19px;
                cursor: pointer; padding: 5px; transition: transform 0.2s;
            }
            .uvmax-mute-btn:hover { transform: scale(1.12); }
            .uvmax-vol-slider {
                width: 80px; height: 22px; display: flex; align-items: center;
                cursor: pointer; position: relative;
            }
            .uvmax-vol-track {
                width: 100%; height: 4px; background: rgba(255,255,255,0.28);
                border-radius: 2px; position: relative;
            }
            .uvmax-vol-fill {
                height: 100%;
                background: linear-gradient(90deg, #f09433, #e6683c);
                border-radius: 2px; position: relative;
            }
            .uvmax-vol-thumb {
                position: absolute; top: 50%; right: -6px; transform: translateY(-50%);
                width: 13px; height: 13px; background: white; border-radius: 50%;
                box-shadow: 0 2px 5px rgba(0,0,0,0.35); cursor: grab;
            }
            html:has(#${OVERLAY_ID}) { overflow: hidden !important; }
        `;
        const s = document.createElement('style');
        s.id = 'univ-video-styles';
        s.textContent = css;
        (document.head || document.documentElement).appendChild(s);
    }

    // ─── CUSTOM CONTROLS DOM ─────────────────────────────────────────────────

    function createCustomControls(videoEl) {
        const initVolume = (videoEl.readyState > 0 || videoEl.volume !== 1)
            ? videoEl.volume
            : (isNaN(savedVolume) ? 1.0 : savedVolume);
        const initMuted = videoEl.muted !== undefined ? videoEl.muted : savedMuted;
        savedVolume = initVolume;
        savedMuted  = initMuted;
        localStorage.setItem('univ_max_volume', savedVolume);
        localStorage.setItem('univ_max_muted',  savedMuted);

        const container = document.createElement('div');
        container.className = 'uvmax-container';

        videoEl.style.cssText = `
            width: 100vw !important; height: 100vh !important;
            max-width: 100vw !important; max-height: 100vh !important;
            object-fit: contain !important; display: block !important;
            background: black !important; margin: 0 !important; border-radius: 0 !important;
        `;
        videoEl.controls = false;
        videoEl.muted = initMuted;
        videoEl.volume = initVolume;
        videoEl.playbackRate = savedPlaybackRate;

        const overlayDiv = document.createElement('div');
        overlayDiv.className = 'uvmax-controls-overlay';

        const progContainer = document.createElement('div');
        progContainer.className = 'uvmax-progress-container';
        progContainer.innerHTML = `<div class="uvmax-progress-bg"><div class="uvmax-progress-fill"><div class="uvmax-progress-thumb"></div></div></div>`;
        const progFill = progContainer.querySelector('.uvmax-progress-fill');

        const row = document.createElement('div');
        row.className = 'uvmax-controls-row';

        const playBtn = document.createElement('button');
        playBtn.className = 'uvmax-play-btn';
        playBtn.innerHTML = `
            <svg class="pi" width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M8 5v14l11-7z" fill="white"/></svg>
            <svg class="pa" width="20" height="20" viewBox="0 0 24 24" fill="none" style="display:none"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" fill="white"/></svg>
        `;

        const timeDisp = document.createElement('div');
        timeDisp.className = 'uvmax-time';
        timeDisp.textContent = '0:00 / 0:00';

        const speedBtn = document.createElement('button');
        speedBtn.className = 'uvmax-speed-btn';
        speedBtn.textContent = savedPlaybackRate.toFixed(2) + 'x';

        const volWrap = document.createElement('div');
        volWrap.className = 'uvmax-volume-wrap';

        const muteBtn = document.createElement('button');
        muteBtn.className = 'uvmax-mute-btn';
        muteBtn.innerHTML = initMuted ? '🔇' : '🔊';

        const volSlider = document.createElement('div');
        volSlider.className = 'uvmax-vol-slider';
        volSlider.innerHTML = `<div class="uvmax-vol-track"><div class="uvmax-vol-fill" style="width:${initVolume * 100}%"><div class="uvmax-vol-thumb"></div></div></div>`;
        const volFill = volSlider.querySelector('.uvmax-vol-fill');

        volWrap.append(muteBtn, volSlider);
        row.append(playBtn, timeDisp, speedBtn, volWrap);
        overlayDiv.append(progContainer, row);

        const exitBtn = document.createElement('button');
        exitBtn.className = 'fancy-exit-btn';
        exitBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg> Exit`;
        exitBtn.onclick = removeMaxMode;

        container.append(videoEl, overlayDiv, exitBtn);

        // ── Shared idle-hide timer ────────────────────────────────────────────
        let hideTimeout;
        const showControls = () => {
            overlayDiv.style.opacity = '1';
            exitBtn.style.opacity = '1';
            clearTimeout(hideTimeout);
            hideTimeout = setTimeout(() => {
                overlayDiv.style.opacity = '0';
                exitBtn.style.opacity = '0';
            }, 2000);
        };
        const hideControls = () => {
            clearTimeout(hideTimeout);
            overlayDiv.style.opacity = '0';
            exitBtn.style.opacity = '0';
        };
        container.addEventListener('mousemove', showControls);
        container.addEventListener('mouseleave', hideControls);
        overlayDiv.addEventListener('mouseenter', () => clearTimeout(hideTimeout));
        overlayDiv.addEventListener('mouseleave', () => {
            hideTimeout = setTimeout(() => {
                overlayDiv.style.opacity = '0';
                exitBtn.style.opacity = '0';
            }, 800);
        });
        exitBtn.addEventListener('mouseenter', () => clearTimeout(hideTimeout));
        exitBtn.addEventListener('mouseleave', () => {
            hideTimeout = setTimeout(() => {
                overlayDiv.style.opacity = '0';
                exitBtn.style.opacity = '0';
            }, 800);
        });

        // ── Playback ──────────────────────────────────────────────────────────
        const fmt = s => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
        const updatePlayIcon = () => {
            const p = videoEl.paused;
            playBtn.querySelector('.pi').style.display = p ? 'block' : 'none';
            playBtn.querySelector('.pa').style.display = p ? 'none' : 'block';
        };
        const togglePlay = () => videoEl.paused ? videoEl.play().catch(() => {}) : videoEl.pause();
        playBtn.onclick = e => { e.stopPropagation(); togglePlay(); };
        videoEl.onclick = e => { if (!e.target.closest('.uvmax-controls-overlay')) togglePlay(); };
        videoEl.addEventListener('play', updatePlayIcon);
        videoEl.addEventListener('pause', updatePlayIcon);
        updatePlayIcon();

        videoEl.addEventListener('timeupdate', () => {
            if (videoEl.duration) {
                progFill.style.width = (videoEl.currentTime / videoEl.duration * 100) + '%';
                timeDisp.textContent = `${fmt(videoEl.currentTime)} / ${fmt(videoEl.duration)}`;
            }
        });

        // ── Seek ──────────────────────────────────────────────────────────────
        let seekDrag = false;
        const doSeek = e => {
            const r = progContainer.querySelector('.uvmax-progress-bg').getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
            if (videoEl.duration) videoEl.currentTime = pct * videoEl.duration;
        };
        progContainer.onmousedown = e => {
            seekDrag = true; doSeek(e);
            document.addEventListener('mousemove', onSeekMove);
            document.addEventListener('mouseup', onSeekUp);
        };
        const onSeekMove = e => { if (seekDrag) doSeek(e); };
        const onSeekUp = () => { seekDrag = false; document.removeEventListener('mousemove', onSeekMove); document.removeEventListener('mouseup', onSeekUp); };

        // ── Volume ────────────────────────────────────────────────────────────
        const doVol = e => {
            const r = volSlider.querySelector('.uvmax-vol-track').getBoundingClientRect();
            const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
            videoEl.volume = pct;
            if (pct > 0) videoEl.muted = false;
            savedVolume = pct; savedMuted = videoEl.muted;
            localStorage.setItem('univ_max_volume', savedVolume);
            localStorage.setItem('univ_max_muted', savedMuted);
            volFill.style.width = (pct * 100) + '%';
            muteBtn.innerHTML = (videoEl.muted || pct === 0) ? '🔇' : '🔊';
        };
        let volDrag = false;
        volSlider.onmousedown = e => {
            volDrag = true; doVol(e);
            document.addEventListener('mousemove', onVolMove);
            document.addEventListener('mouseup', onVolUp);
        };
        const onVolMove = e => { if (volDrag) doVol(e); };
        const onVolUp = () => { volDrag = false; document.removeEventListener('mousemove', onVolMove); document.removeEventListener('mouseup', onVolUp); };

        muteBtn.onclick = e => {
            e.stopPropagation();
            videoEl.muted = !videoEl.muted;
            muteBtn.innerHTML = videoEl.muted ? '🔇' : '🔊';
            savedMuted = videoEl.muted;
            localStorage.setItem('univ_max_muted', savedMuted);
        };

        // ── Speed ─────────────────────────────────────────────────────────────
        const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4];
        speedBtn.onclick = e => {
            e.stopPropagation();
            const idx = SPEEDS.indexOf(savedPlaybackRate);
            savedPlaybackRate = SPEEDS[(idx + 1) % SPEEDS.length];
            videoEl.playbackRate = savedPlaybackRate;
            localStorage.setItem('univ_max_rate', savedPlaybackRate);
            speedBtn.textContent = savedPlaybackRate.toFixed(2) + 'x';
        };

        return container;
    }

    // ─── CORE: APPLY / REMOVE ────────────────────────────────────────────────

    function applyMaxMode() {
        if (enabled) { removeMaxMode(); return; }
        const found = findMainVideo();
        if (!found) { showToast('No video found on this page'); return; }
        video = found.video;
        videoShadowRoot = found.shadowRoot || null;
        const isIframe = !!found.isIframe;
        enabled = true;
        injectStyles();

        if (videoShadowRoot || isVK) {
            useInPlaceMode = true;
            const hostContainer = isIframe ? video : getPlayerHostContainer(video);
            applyInPlaceMaximize(hostContainer);
            try {
                if (!isNaN(savedVolume)) video.volume = savedVolume;
                video.muted = savedMuted;
                video.playbackRate = savedPlaybackRate;
            } catch(e) {}
            if (video.tagName === 'VIDEO' && video.paused) video.play().catch(() => {});
            return;
        }

        useInPlaceMode = false;

        if (isIframe) {
            originalParent = video.parentElement;
            originalNextSibling = video.nextSibling;
            originalVideoStyles = video.getAttribute('style');
            overlay = document.createElement('div');
            overlay.id = OVERLAY_ID;
            const c = document.createElement('div');
            c.className = 'uvmax-container';
            video.style.cssText = 'width:100%;height:100%;object-fit:contain;background:black;border:none;';
            const exitBtn = document.createElement('button');
            exitBtn.className = 'fancy-exit-btn';
            exitBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg> Exit`;
            exitBtn.onclick = removeMaxMode;
            let ifrHideTimer;
            const showIfrBtn = () => { exitBtn.style.opacity = '1'; clearTimeout(ifrHideTimer); ifrHideTimer = setTimeout(() => { exitBtn.style.opacity = '0'; }, 2000); };
            c.addEventListener('mousemove', showIfrBtn);
            c.addEventListener('mouseleave', () => { clearTimeout(ifrHideTimer); exitBtn.style.opacity = '0'; });
            exitBtn.addEventListener('mouseenter', () => clearTimeout(ifrHideTimer));
            exitBtn.addEventListener('mouseleave', () => { ifrHideTimer = setTimeout(() => { exitBtn.style.opacity = '0'; }, 800); });
            c.append(video, exitBtn);
            overlay.appendChild(c);
            document.documentElement.appendChild(overlay);
            return;
        }

        originalParent = video.parentElement;
        originalNextSibling = video.nextSibling;
        originalVideoStyles = video.getAttribute('style');
        overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.appendChild(createCustomControls(video));
        document.documentElement.appendChild(overlay);
        if (video.paused) video.play().catch(() => {});
    }

    function removeMaxMode() {
        if (!enabled) return;
        enabled = false;

        if (useInPlaceMode) {
            removeInPlaceMaximize();
            useInPlaceMode = false;
            video = null;
            videoShadowRoot = null;
            return;
        }

        if (video) {
            if (originalVideoStyles) video.setAttribute('style', originalVideoStyles);
            else video.removeAttribute('style');
            if (originalParent) {
                if (originalNextSibling) originalParent.insertBefore(video, originalNextSibling);
                else originalParent.appendChild(video);
            } else {
                document.body.appendChild(video);
            }
        }

        overlay?.remove();
        overlay = null;
        video = null;
        videoShadowRoot = null;
        originalParent = null;
        originalNextSibling = null;
    }

    // ─── TOAST NOTIFICATION ───────────────────────────────────────────────────

    function showToast(msg) {
        injectStyles();
        const t = document.createElement('div');
        t.style.cssText = `
            position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%);
            background: rgba(0,0,0,0.85); color: white; padding: 10px 22px;
            border-radius: 20px; font-size: 14px; font-family: sans-serif;
            z-index: 2147483647; pointer-events: none;
            box-shadow: 0 4px 20px rgba(0,0,0,0.5); backdrop-filter: blur(10px);
            border: 1px solid rgba(255,255,255,0.15);
        `;
        t.textContent = msg;
        document.documentElement.appendChild(t);
        setTimeout(() => t.remove(), 2500);
    }

    // ─── KEYBOARD HANDLER ────────────────────────────────────────────────────

    document.addEventListener('keydown', e => {
        if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'F11') {
            e.preventDefault(); e.stopPropagation();
            applyMaxMode();
            return;
        }
        if (!enabled) return;
        if (e.key === 'Escape' || e.key.toLowerCase() === 'q') {
            e.preventDefault(); e.stopPropagation();
            removeMaxMode();
        } else if (e.key === ' ') {
            e.preventDefault(); e.stopPropagation();
            if (video?.tagName === 'VIDEO') video.paused ? video.play().catch(() => {}) : video.pause();
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            if (video?.tagName === 'VIDEO' && video.duration) video.currentTime = Math.min(video.duration, video.currentTime + 10);
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            if (video?.tagName === 'VIDEO') video.currentTime = Math.max(0, video.currentTime - 10);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (video?.tagName === 'VIDEO') { video.volume = Math.min(1, video.volume + 0.1); video.muted = false; }
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (video?.tagName === 'VIDEO') video.volume = Math.max(0, video.volume - 0.1);
        } else if (e.key === 'm' || e.key === 'M') {
            if (video?.tagName === 'VIDEO') video.muted = !video.muted;
        } else if (e.key === 'f' || e.key === 'F') {
            if (video?.tagName === 'VIDEO' && video.requestFullscreen) video.requestFullscreen().catch(() => {});
        }
    }, true);

    // ─── MUTATION OBSERVER (for SPAs & dynamic video loads) ──────────────────

    let pendingActivation = false;

    const observer = new MutationObserver(() => {
        if (!pendingActivation) return;
        const found = findMainVideo();
        if (found) {
            pendingActivation = false;
            applyMaxMode();
        }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });

    document.addEventListener('keydown', e => {
        if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'F11') {
            if (!enabled) {
                const found = findMainVideo();
                if (!found) { pendingActivation = true; showToast('Waiting for video to load…'); }
            }
        }
    }, true);

    // ─── CLEANUP ON PAGE UNLOAD ───────────────────────────────────────────────

    window.addEventListener('beforeunload', () => {
        if (enabled) removeMaxMode();
        observer.disconnect();
    });

    // ─── INIT ─────────────────────────────────────────────────────────────────

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectStyles);
    } else {
        injectStyles();
    }

})();