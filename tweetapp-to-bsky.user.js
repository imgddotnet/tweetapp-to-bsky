// ==UserScript==
// @name         tweetapp-to-bsky
// @namespace    https://github.com/imgddotnet/tweetapp-to-bsky
// @version      0.1.0
// @description  Crosspost from app.tweet.app to Bluesky (Text, up to 10 Images via gallery embed, Video, OGP Link Cards)
// @author       imgddotnet
// @license      MIT
// @homepageURL  https://github.com/imgddotnet/tweetapp-to-bsky
// @supportURL   https://github.com/imgddotnet/tweetapp-to-bsky/issues
// @updateURL    https://raw.githubusercontent.com/imgddotnet/tweetapp-to-bsky/main/tweetapp-to-bsky.user.js
// @downloadURL  https://raw.githubusercontent.com/imgddotnet/tweetapp-to-bsky/main/tweetapp-to-bsky.user.js
// @match        https://app.tweet.app/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      *
// @connect      bsky.social
// @connect      video.bsky.app
// @connect      api.bsky.app
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    const SELECTORS = {
        COMPOSE_INPUT: [
            'textarea#public-tweet-input',
            'textarea#public-modal-tweet-input',
            'textarea[name="compose-text"]',
            'textarea[placeholder*="happening" i]',
            '[contenteditable="true"][aria-label*="happening" i]',
            '[contenteditable="true"][aria-placeholder*="happening" i]'
        ].join(', '),
        EXCLUDED_BUTTONS: [
            '#public-sidebar-compose-btn',
            '#public-mobile-compose-btn',
            '[aria-label*="avatar" i]',
            '[aria-label^="View @"]',
            '.tt-compose-btn',
            '.tt-gif-btn',
            '.bsky-gear-btn'
        ].join(', ')
    };

    const CONFIG = {
        VERSION: '0.1.0',
        TIMEOUT: { DEFAULT: 60000, PARSER: 15000, VIDEO_FETCH: 120000, VIDEO_UPLOAD: 180000 },
        IMAGE: {
            MAX_COUNT: 10,
            MAX_DIMENSION: 4000,
            MAX_SIZE: 2000000,
            QUALITY: 0.88,
            THUMB_DIMENSION: 800,
            SUPPORTED_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
        },
        VIDEO: {
            MAX_SIZE: 300 * 1024 * 1024,
            UPLOAD_ENDPOINT: 'https://video.bsky.app/xrpc/app.bsky.video.uploadVideo',
            JOB_STATUS_ENDPOINT: 'https://video.bsky.app/xrpc/app.bsky.video.getJobStatus',
            POLL_INTERVAL_MS: 2000,
            POLL_MAX_ATTEMPTS: 180
        },
        USER_AGENT: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    };

    const settings = {
        pdsUrl: GM_getValue('bsky_pds_url', 'https://bsky.social').replace(/^https:\/\/https:\/\//, 'https://'),
        handle: GM_getValue('bsky_handle', ''),
        password: GM_getValue('bsky_app_password', ''),
        session: GM_getValue('bsky_session', null),
        crosspostChecked: GM_getValue('bsky_crosspost_checked', false)
    };

    let settingsPanel = null;
    let isBridging = false;
    const bypassButtons = new WeakSet();

    // ネットワーク通信
    const Net = {
        gmRequest(opts) {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    timeout: CONFIG.TIMEOUT.DEFAULT,
                    ...opts,
                    onload: r => r.status >= 200 && r.status < 300 ? resolve(r) : reject(new Error(`HTTP ${r.status}`)),
                    onerror: () => reject(new Error('Network error')),
                    ontimeout: () => reject(new Error('Timeout'))
                });
            });
        },
        async fetchBlob(url, timeout = CONFIG.TIMEOUT.DEFAULT) {
            if (url?.startsWith('blob:') || url?.startsWith('data:')) {
                return (await fetch(url)).blob();
            }
            return (await this.gmRequest({ method: 'GET', url, responseType: 'blob', timeout })).response;
        },
        async fetchText(url) {
            try {
                const res = await this.gmRequest({
                    method: 'GET',
                    url,
                    timeout: CONFIG.TIMEOUT.PARSER,
                    headers: { Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', 'User-Agent': CONFIG.USER_AGENT }
                });
                return res.responseText;
            } catch {
                return null;
            }
        },
        async fetchJson(url) {
            const text = await this.fetchText(url);
            try { return text ? JSON.parse(text) : null; } catch { return null; }
        }
    };

    // テキスト・OGP 解析
    const Parser = {
        byteLen: str => new TextEncoder().encode(str).length,
        parseFacets(text) {
            const facets = [];
            const rules = [
                { regex: /(#[\p{L}\p{N}_]+)/gu, type: 'app.bsky.richtext.facet#tag', key: 'tag', val: m => m.slice(1) },
                { regex: /(https?:\/\/[^\s]+)/g, type: 'app.bsky.richtext.facet#link', key: 'uri', val: m => m }
            ];
            for (const { regex, type, key, val } of rules) {
                let m;
                while ((m = regex.exec(text))) {
                    const byteStart = this.byteLen(text.slice(0, m.index));
                    facets.push({
                        index: { byteStart, byteEnd: byteStart + this.byteLen(m[0]) },
                        features: [{ $type: type, [key]: val(m[0]) }]
                    });
                }
            }
            return facets;
        },
        async fetchLinkMeta(targetUrl) {
            const domain = new URL(targetUrl).hostname;
            if (domain.includes('tweet.app')) return null;

            if (domain.includes('youtube.com') || domain.includes('youtu.be')) {
                const vid = targetUrl.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/)?.[1];
                const j = await Net.fetchJson(`https://www.youtube.com/oembed?url=${encodeURIComponent(targetUrl)}&format=json`);
                if (j) return { title: j.title || domain, description: j.author_name || '', imageUrl: j.thumbnail_url || (vid ? `https://i.ytimg.com/vi/${vid}/maxresdefault.jpg` : '') };
            }
            if (domain.includes('x.com') || domain.includes('twitter.com')) {
                const j = await Net.fetchJson(`https://publish.twitter.com/oembed?url=${encodeURIComponent(targetUrl)}&omit_script=true`);
                if (j) return { title: j.author_name || domain, description: (j.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), imageUrl: '' };
            }

            const html = await Net.fetchText(targetUrl);
            if (!html) return { title: domain, description: '', imageUrl: '' };

            const doc = new DOMParser().parseFromString(html, 'text/html');
            const meta = (...names) => names.map(n => doc.querySelector(`meta[name="${n}"],meta[property="${n}"]`)?.content?.trim()).find(Boolean) || '';
            let imageUrl = meta('twitter:image', 'twitter:image:src', 'og:image');
            if (imageUrl && !imageUrl.startsWith('http')) {
                try { imageUrl = new URL(imageUrl, targetUrl).href; } catch { imageUrl = ''; }
            }
            return {
                title: meta('twitter:title', 'og:title') || doc.querySelector('title')?.textContent?.trim() || domain,
                description: meta('twitter:description', 'og:description', 'description'),
                imageUrl
            };
        }
    };

    // Bluesky API
    const Bsky = {
        async xrpc(method, endpoint, data = null, headers = {}) {
            const h = { ...headers };
            if (settings.session) h.Authorization = `Bearer ${settings.session.accessJwt}`;
            const isRaw = data instanceof Blob || data instanceof ArrayBuffer;
            if (data && !isRaw) h['Content-Type'] = 'application/json';

            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method,
                    url: `${settings.pdsUrl}/xrpc/${endpoint}`,
                    headers: h,
                    data: data && !isRaw ? JSON.stringify(data) : data,
                    binary: isRaw,
                    timeout: CONFIG.TIMEOUT.DEFAULT,
                    onload: r => {
                        let body = r.responseText;
                        try { body = JSON.parse(r.responseText); } catch {}
                        r.status >= 200 && r.status < 300 ? resolve(body) : reject(new Error(body?.message || `HTTP ${r.status}`));
                    },
                    onerror: () => reject(new Error('PDS Connection Refused')),
                    ontimeout: () => reject(new Error('Timeout'))
                });
            });
        },
        async ensureSession() {
            if (settings.session) {
                try {
                    await this.xrpc('GET', 'com.atproto.server.getSession');
                    return;
                } catch {}
            }
            settings.session = await this.xrpc('POST', 'com.atproto.server.createSession', {
                identifier: settings.handle,
                password: settings.password
            });
            GM_setValue('bsky_session', settings.session);
        },
        async uploadBlob(blob, mime) {
            return (await this.xrpc('POST', 'com.atproto.repo.uploadBlob', blob, {
                'Content-Type': mime || blob.type || 'application/octet-stream'
            })).blob;
        },
        async createPost(record) {
            return this.xrpc('POST', 'com.atproto.repo.createRecord', {
                repo: settings.session.did,
                collection: 'app.bsky.feed.post',
                record
            });
        },
        async uploadVideo(blob, onProgress) {
            onProgress('Video Auth...');
            const mime = blob.type || 'video/mp4';
            let token = null;
            try {
                const auth = await this.xrpc('POST', 'com.atproto.server.getServiceAuth', {
                    aud: 'did:web:video.bsky.app',
                    lxm: 'com.atproto.repo.uploadBlob',
                    exp: Math.floor(Date.now() / 1000) + 1800
                });
                token = auth.token || auth.accessJwt;
            } catch {}

            if (!token) {
                onProgress('Uploading PDS...');
                return this.uploadBlob(blob, mime);
            }

            onProgress('Uploading Video...');
            const buffer = await blob.arrayBuffer();
            const upUrl = new URL(CONFIG.VIDEO.UPLOAD_ENDPOINT);
            upUrl.searchParams.set('did', settings.session.did);
            upUrl.searchParams.set('name', `video_${Date.now()}.${mime.includes('quicktime') ? 'mov' : 'mp4'}`);

            const upRes = await Net.gmRequest({
                method: 'POST',
                url: upUrl.toString(),
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': mime },
                data: buffer,
                binary: true,
                timeout: CONFIG.TIMEOUT.VIDEO_UPLOAD
            });
            const upJson = JSON.parse(upRes.responseText);
            if (upJson.blob) {
                upJson.blob.mimeType = mime;
                return upJson.blob;
            }
            if (!upJson.jobId) throw new Error('No video jobId');

            for (let i = 0; i < CONFIG.VIDEO.POLL_MAX_ATTEMPTS; i++) {
                await new Promise(r => setTimeout(r, CONFIG.VIDEO.POLL_INTERVAL_MS));
                const stRes = await Net.gmRequest({
                    method: 'GET',
                    url: `${CONFIG.VIDEO.JOB_STATUS_ENDPOINT}?jobId=${encodeURIComponent(upJson.jobId)}`,
                    headers: { Authorization: `Bearer ${token}` }
                });
                const parsed = JSON.parse(stRes.responseText);
                const js = parsed.jobStatus || parsed;
                if (js.progress != null) onProgress(`Encoding ${js.progress}%`);
                if (js.blob) {
                    js.blob.mimeType = mime;
                    return js.blob;
                }
                if (js.state === 'JOB_STATE_FAILED') throw new Error(js.error || 'Video encoding failed');
            }
            throw new Error('Video encoding timeout');
        }
    };

    // メディア変換・埋め込み生成
    const Media = {
        async detectImageMime(blob) {
            const b = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
            if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
            if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
            if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
            if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
            return blob.type?.startsWith('image/') ? blob.type.toLowerCase() : 'image/jpeg';
        },
        loadImage(blob) {
            return new Promise((resolve, reject) => {
                const url = URL.createObjectURL(blob);
                const img = new Image();
                img.onload = () => {
                    URL.revokeObjectURL(url);
                    resolve({ img, width: Math.max(1, img.naturalWidth || 1), height: Math.max(1, img.naturalHeight || 1) });
                };
                img.onerror = () => {
                    URL.revokeObjectURL(url);
                    reject(new Error('Image decode failed'));
                };
                img.src = url;
            });
        },
        async prepareImage(rawBlob, { maxDim = CONFIG.IMAGE.MAX_DIMENSION, allowPassthrough = true } = {}) {
            const mime = await this.detectImageMime(rawBlob);
            const normalized = rawBlob.type === mime ? rawBlob : new Blob([rawBlob], { type: mime });
            const { img, width: natW, height: natH } = await this.loadImage(normalized);

            if (allowPassthrough && CONFIG.IMAGE.SUPPORTED_TYPES.includes(mime) && natW <= maxDim && natH <= maxDim && normalized.size <= CONFIG.IMAGE.MAX_SIZE) {
                return { blob: normalized, mime, aspectRatio: { width: natW, height: natH } };
            }

            let scale = Math.min(1, maxDim / Math.max(natW, natH));
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');

            try {
                for (let step = 0; step < 6; step++) {
                    const w = Math.max(1, Math.round(natW * scale));
                    const h = Math.max(1, Math.round(natH * scale));
                    canvas.width = w;
                    canvas.height = h;
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(0, 0, w, h);
                    ctx.drawImage(img, 0, 0, w, h);

                    for (const q of [CONFIG.IMAGE.QUALITY, 0.78, 0.66, 0.54]) {
                        const encoded = await new Promise(r => canvas.toBlob(b => r(b || null), 'image/jpeg', q));
                        if (encoded && encoded.size > 0 && encoded.size <= CONFIG.IMAGE.MAX_SIZE) {
                            return { blob: encoded, mime: 'image/jpeg', aspectRatio: { width: w, height: h } };
                        }
                    }
                    scale *= 0.7;
                }
            } finally {
                canvas.width = 0;
                canvas.height = 0;
            }
            throw new Error('Image exceeds 2MB limit after compression');
        },
        async buildGalleryEmbed(sources, onProgress) {
            const list = Array.from(sources).slice(0, CONFIG.IMAGE.MAX_COUNT);
            const items = [];
            for (let i = 0; i < list.length; i++) {
                onProgress(`Image ${i + 1}/${list.length}...`);
                const src = list[i];
                const raw = src instanceof Blob ? src : await Net.fetchBlob(src.src);
                const { blob, mime, aspectRatio } = await this.prepareImage(raw);
                items.push({
                    $type: 'app.bsky.embed.gallery#image',
                    image: await Bsky.uploadBlob(blob, mime),
                    alt: '',
                    aspectRatio
                });
            }
            return { $type: 'app.bsky.embed.gallery', items };
        },
        async buildVideoEmbed(source, onProgress) {
            const blob = source instanceof Blob ? source : await Net.fetchBlob(source.src || source.currentSrc || source.querySelector?.('source')?.src, CONFIG.TIMEOUT.VIDEO_FETCH);
            if (blob.size > CONFIG.VIDEO.MAX_SIZE) throw new Error('Exceeds 300MB limit');
            const ref = await Bsky.uploadVideo(blob, onProgress);
            return {
                $type: 'app.bsky.embed.video',
                video: ref,
                aspectRatio: { width: Math.max(1, source.videoWidth || 16), height: Math.max(1, source.videoHeight || 9) }
            };
        },
        async buildExternalEmbed(url, onProgress) {
            try {
                onProgress('Fetching Link...');
                const meta = await Parser.fetchLinkMeta(url);
                if (!meta) return null;
                const external = { uri: url, title: meta.title.slice(0, 300), description: meta.description.slice(0, 800) };
                if (meta.imageUrl?.startsWith('http')) {
                    try {
                        onProgress('Fetching Thumb...');
                        const thumbRaw = await Net.fetchBlob(meta.imageUrl);
                        const { blob, mime } = await this.prepareImage(thumbRaw, { maxDim: CONFIG.IMAGE.THUMB_DIMENSION, allowPassthrough: false });
                        external.thumb = await Bsky.uploadBlob(blob, mime);
                    } catch {}
                }
                return { $type: 'app.bsky.embed.external', external };
            } catch {
                return null;
            }
        }
    };

    // app.tweet.app DOM 操作
    const Dom = {
        isSubmitBtn(btn) {
            if (btn?.tagName !== 'BUTTON' || btn.matches(SELECTORS.EXCLUDED_BUTTONS)) return false;
            const label = (btn.textContent || btn.getAttribute('aria-label') || '').trim();
            return /^(Post|Tweet|Reply|ポスト|ツイート|返信)$/i.test(label);
        },
        getText(el) {
            return !el ? '' : (el.tagName === 'TEXTAREA' ? el.value : (el.innerText || el.textContent || ''));
        },
        findRootByInput(inputEl) {
            let node = inputEl?.parentElement;
            while (node && node !== document.body) {
                if (node.querySelectorAll(SELECTORS.COMPOSE_INPUT).length > 1) break;
                if (Array.from(node.querySelectorAll('button')).some(b => this.isSubmitBtn(b))) return node;
                node = node.parentElement;
            }
            return null;
        },
        findByButton(btn) {
            let node = btn.parentElement;
            while (node && node !== document.body) {
                const inputs = node.querySelectorAll(SELECTORS.COMPOSE_INPUT);
                if (inputs.length === 1) return { root: node, input: inputs[0] };
                if (inputs.length > 1) break;
                node = node.parentElement;
            }
            return null;
        },
        getAttachments(root) {
            const videos = Array.from(root.querySelectorAll('video')).filter(v => !v.closest('article'));
            const images = Array.from(root.querySelectorAll('img')).filter(img => {
                if (img.closest('article, button[aria-label^="View @"], button[aria-label="Open profile menu"]')) return false;
                if (/avatar/i.test(img.alt || '') || !/^(blob:|data:|https?:)/.test(img.src || '')) return false;
                const r = img.getBoundingClientRect();
                return !(r.width > 0 && r.width < 40 && r.height > 0 && r.height < 40);
            });
            if (images.length || videos.length) return { images, videos };

            const fImgs = [], fVids = [];
            for (const inp of root.querySelectorAll('input[type="file"]')) {
                for (const f of inp.files || []) {
                    if (f.type.startsWith('video/')) fVids.push(f);
                    else if (f.type.startsWith('image/')) fImgs.push(f);
                }
            }
            return { images: fImgs, videos: fVids };
        }
    };

    // UI
    const UI = {
        notify(text, isError = false) {
            document.getElementById('bsky-notification')?.remove();
            const el = document.createElement('div');
            el.id = 'bsky-notification';
            el.className = `bsky-notification ${isError ? 'error' : ''}`;
            el.innerHTML = `<div class="bsky-notification-title">Tweet.app to Bluesky</div><div>${text}</div>`;
            document.body.appendChild(el);
            setTimeout(() => {
                el.classList.add('fade-out');
                setTimeout(() => el.remove(), 400);
            }, 4000);
        },
        toggleSettings() {
            if (settingsPanel) {
                settingsPanel.remove();
                settingsPanel = null;
                return;
            }
            settingsPanel = document.createElement('div');
            settingsPanel.className = 'bsky-settings';
            settingsPanel.innerHTML = `
                <fieldset>
                    <legend><span>Bluesky Settings</span><small>v${CONFIG.VERSION}</small></legend>
                    <label>PDS URL</label>
                    <input type="url" name="pds" value="${settings.pdsUrl}" placeholder="https://bsky.social">
                    <label>Handle</label>
                    <input type="text" name="handle" value="${settings.handle}" placeholder="user.bsky.social">
                    <label>App Password</label>
                    <input type="password" name="password" value="${settings.password}" placeholder="xxxx-xxxx-xxxx-xxxx">
                    <div class="actions">
                        <button type="button" id="bsky-close" class="secondary">Cancel</button>
                        <button type="button" id="bsky-save">Save</button>
                    </div>
                </fieldset>`;
            document.body.appendChild(settingsPanel);

            settingsPanel.querySelector('#bsky-close').onclick = () => this.toggleSettings();
            settingsPanel.querySelector('#bsky-save').onclick = () => {
                settings.pdsUrl = (settingsPanel.querySelector('[name="pds"]').value.trim() || 'https://bsky.social').replace(/^https:\/\/https:\/\//, 'https://');
                settings.handle = settingsPanel.querySelector('[name="handle"]').value.trim();
                settings.password = settingsPanel.querySelector('[name="password"]').value.trim();
                settings.session = null;
                GM_setValue('bsky_pds_url', settings.pdsUrl);
                GM_setValue('bsky_handle', settings.handle);
                GM_setValue('bsky_app_password', settings.password);
                GM_setValue('bsky_session', null);
                this.toggleSettings();
                this.notify('Settings saved!');
            };
        },
        injectNav() {
            if (document.getElementById('bsky-nav-menu')) return;
            const anchor = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim().startsWith('Invite friends'))
                || Array.from(document.querySelectorAll('nav')).find(n => n.offsetParent !== null)?.querySelector('button:last-of-type');
            if (!anchor) return;

            const item = anchor.cloneNode(true);
            item.id = 'bsky-nav-menu';
            const icon = item.querySelector('svg');
            if (icon) {
                icon.style.color = '#1d9bf0';
                icon.innerHTML = '<path d="M12 2.69l7.92 7.92-7.92 7.92-7.92-7.92Z" fill="#1d9bf0" stroke="#1d9bf0"></path>';
            }
            const spans = item.querySelectorAll('span.flex.flex-col > span');
            if (spans[0]) spans[0].textContent = 'Bluesky';
            if (spans[1]) spans[1].textContent = 'Crosspost settings';
            item.onclick = e => { e.preventDefault(); e.stopPropagation(); this.toggleSettings(); };
            anchor.insertAdjacentElement('afterend', item);
        },
        injectCheckbox(inputEl) {
            const root = Dom.findRootByInput(inputEl);
            if (!root || root.querySelector('.bsky-box')) return;
            const submitBtn = Array.from(root.querySelectorAll('button')).find(b => Dom.isSubmitBtn(b));
            if (!submitBtn) return;

            const box = document.createElement('div');
            box.className = 'bsky-box';
            box.innerHTML = `<label><input type="checkbox" ${settings.crosspostChecked ? 'checked' : ''}><span>Bluesky</span></label><button type="button" class="bsky-gear-btn" title="Settings">⚙</button>`;

            box.querySelector('input').onchange = e => {
                settings.crosspostChecked = e.target.checked;
                GM_setValue('bsky_crosspost_checked', settings.crosspostChecked);
                document.querySelectorAll('.bsky-box input').forEach(i => { i.checked = settings.crosspostChecked; });
            };
            box.querySelector('.bsky-gear-btn').onclick = e => { e.preventDefault(); e.stopPropagation(); this.toggleSettings(); };

            const cancelBtn = Array.from(submitBtn.parentElement?.querySelectorAll('button') || []).find(b => /^Cancel$/i.test(b.textContent.trim()));
            (cancelBtn || submitBtn).insertAdjacentElement('beforebegin', box);
        }
    };

    // 投稿実行
    async function handleCrosspost(input, root, btn, event) {
        if (bypassButtons.has(btn)) {
            bypassButtons.delete(btn);
            return;
        }
        if (isBridging) {
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        if (!settings.crosspostChecked) return;

        if (!settings.handle || !settings.password) {
            event.preventDefault();
            event.stopImmediatePropagation();
            UI.notify('Bluesky handle or app password is not set.', true);
            UI.toggleSettings();
            return;
        }

        const text = Dom.getText(input).trim();
        const { images, videos } = Dom.getAttachments(root);
        if (!text && !images.length && !videos.length) return;

        event.preventDefault();
        event.stopImmediatePropagation();
        isBridging = true;

        const labelNode = btn.querySelector('span') || btn;
        const origLabel = labelNode.textContent;
        const origMinW = labelNode.style.minWidth;
        labelNode.style.minWidth = '115px';
        btn.style.opacity = '0.7';
        const setStatus = msg => { labelNode.textContent = msg; };

        let ok = false;
        try {
            setStatus('Initializing...');
            await Bsky.ensureSession();

            const record = {
                $type: 'app.bsky.feed.post',
                text,
                createdAt: new Date().toISOString(),
                facets: Parser.parseFacets(text)
            };

            if (videos.length) {
                record.embed = await Media.buildVideoEmbed(videos[0], setStatus);
            } else if (images.length) {
                record.embed = await Media.buildGalleryEmbed(images, setStatus);
            } else {
                const url = text.match(/(https?:\/\/[^\s]+)/)?.[0];
                if (url) {
                    const card = await Media.buildExternalEmbed(url, setStatus);
                    if (card) record.embed = card;
                }
            }

            setStatus('Posting Bsky...');
            await Bsky.createPost(record);
            UI.notify('Crossposted to Bluesky!');
            ok = true;
        } catch (err) {
            UI.notify(err.message || 'Bluesky crosspost failed', true);
        } finally {
            labelNode.textContent = origLabel;
            labelNode.style.minWidth = origMinW;
            btn.style.opacity = '1';
            isBridging = false;

            if (ok && document.body.contains(btn)) {
                bypassButtons.add(btn);
                btn.click();
            }
        }
    }

    document.addEventListener('click', e => {
        const btn = e.target.closest('button');
        if (!btn || btn.disabled || !Dom.isSubmitBtn(btn)) return;
        const found = Dom.findByButton(btn);
        if (found) handleCrosspost(found.input, found.root, btn, e);
    }, true);

    GM_addStyle(`
        .bsky-box { display: inline-flex; align-items: center; gap: 4px; margin-right: 8px; user-select: none; }
        .bsky-box label { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; cursor: pointer; }
        .bsky-box input { width: 14px; height: 14px; cursor: pointer; accent-color: #1d9bf0; margin: 0; }
        .bsky-gear-btn { background: none; border: none; color: #64748b; cursor: pointer; font-size: 13px; padding: 2px 4px; border-radius: 4px; }
        .bsky-gear-btn:hover { color: #1d9bf0; background: rgba(29, 155, 240, 0.1); }
        .bsky-notification { position: fixed; top: 20px; left: 50%; transform: translateX(-50%); background: #1d9bf0; color: #fff; padding: 10px 18px; border-radius: 10px; z-index: 100001; font-family: sans-serif; font-size: 13px; box-shadow: 0 4px 15px rgba(0,0,0,0.3); transition: opacity 0.35s, transform 0.35s; }
        .bsky-notification.error { background: #f4212e; }
        .bsky-notification.fade-out { opacity: 0; transform: translateX(-50%) translateY(-16px); }
        .bsky-notification-title { font-weight: bold; margin-bottom: 2px; }
        .bsky-settings { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 320px; max-width: calc(100vw - 24px); background: #15202b; padding: 16px; border-radius: 14px; border: 1px solid #38444d; box-shadow: 0 10px 30px rgba(0,0,0,0.6); z-index: 100000; font-family: sans-serif; color: #fff; font-size: 13px; }
        .bsky-settings fieldset { border: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
        .bsky-settings legend { display: flex; justify-content: space-between; align-items: baseline; width: 100%; margin-bottom: 8px; font-weight: bold; color: #1d9bf0; font-size: 14px; }
        .bsky-settings legend small { font-size: 11px; color: #8899a6; font-family: monospace; font-weight: normal; }
        .bsky-settings label { font-size: 12px; color: #cbd5e1; margin-top: 4px; }
        .bsky-settings input { width: 100%; padding: 7px 9px; border-radius: 8px; border: 1px solid #38444d; background: #192734; color: #fff; box-sizing: border-box; font-size: 13px; }
        .bsky-settings .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
        .bsky-settings .actions button { background: #1d9bf0; border: none; color: #fff; padding: 6px 14px; border-radius: 9999px; cursor: pointer; font-weight: bold; font-size: 13px; }
        .bsky-settings .actions button.secondary { background: transparent; border: 1px solid #38444d; color: #cbd5e1; }
    `);

    let timer = null;
    const scan = () => {
        UI.injectNav();
        document.querySelectorAll(SELECTORS.COMPOSE_INPUT).forEach(el => UI.injectCheckbox(el));
    };
    new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(scan, 100);
    }).observe(document.body, { childList: true, subtree: true });
    scan();
})();
