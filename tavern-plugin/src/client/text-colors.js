function findTavernQuoteRanges(text) {
    // Match only complete same-line pairs, including the delimiters.
    const pattern = /"[^"\r\n]+"|“[^”\r\n]+”|«[^»\r\n]+»|「[^」\r\n]+」|『[^』\r\n]+』|＂[^＂\r\n]+＂/g;
    return Array.from(String(text).matchAll(pattern), match => [match.index, match.index + match[0].length]);
}

function installTavernTextColors(root, options, findQuotes) {
    const doc = root.ownerDocument, win = doc.defaultView;
    if (!win.CSS || !win.CSS.highlights || typeof win.Highlight !== 'function') return { setEnabled() {}, setColors() {}, dispose() {} };
    const prefix = 'dsh-tavern-text-' + Math.random().toString(36).slice(2);
    const colors = { 'quote-light': true, 'quote-dark': true, 'em-light': true, 'em-dark': true };
    const highlights = new Map();
    const style = doc.createElement('style');
    style.setAttribute('data-dsh-tavern-text-colors', '');
    function setColors(overrides) {
        style.textContent = Object.entries(colors).map(([kind, fallback]) => {
            const value = overrides && overrides[kind.startsWith('quote') ? 'quote' : 'em'];
            const color = typeof value === 'string' && win.CSS.supports('color', value) && !/[;{}]/.test(value)
                ? value : 'var(--dsw-alias-brand-primary, currentColor)';
            return '::highlight(' + prefix + '-' + kind + '){color:' + color + '}';
        }).join('\n');
    }
    setColors(options.colors);
    doc.head.appendChild(style);
    for (const kind of Object.keys(colors)) {
        const highlight = new win.Highlight();
        highlight.priority = kind.startsWith('quote') ? 2 : 1;
        highlights.set(kind, highlight);
        win.CSS.highlights.set(prefix + '-' + kind, highlight);
    }
    let enabled = options.enabled !== false, disposed = false, timer = null;
    const excluded = 'script,style,textarea,input,select,button,a,code,pre,kbd,samp,svg,math,[hidden],[contenteditable]:not([contenteditable="false"]),[role="button"],[role="textbox"]';
    const blocks = 'p,div,li,td,th,blockquote,section,article,h1,h2,h3,h4,h5,h6';
    // A refresh reads the same ancestors for many text nodes. Cache only for this
    // synchronous pass so later theme/card mutations always get fresh styles.
    let computedColors, explicitColors;
    function computedColor(element) {
        if (!computedColors.has(element)) computedColors.set(element, win.getComputedStyle(element).color);
        return computedColors.get(element);
    }
    function explicitColor(element) {
        if (explicitColors.has(element)) return explicitColors.get(element);
        const own = element.hasAttribute('color') || Boolean(element.style.color || element.style.webkitTextFillColor)
            || (element.matches('span,font,q,em,i,b,strong,u,mark') && element.parentElement
                && computedColor(element) !== computedColor(element.parentElement));
        const result = Boolean(own || (element !== root && element.parentElement && explicitColor(element.parentElement)));
        explicitColors.set(element, result);
        return result;
    }
    const paletteCache = new Map();
    let canvas;
    function palette(element) {
        const color = computedColor(element);
        if (paletteCache.has(color)) return paletteCache.get(color);
        let rgb = color.match(/[\d.]+/g) || [];
        if (!/^rgba?\(/.test(color)) {
            // Modern themes may use oklch/display-p3; read their sRGB equivalent.
            if (!canvas) { canvas = doc.createElement('canvas'); canvas.width = canvas.height = 1; }
            const context = canvas.getContext('2d', { willReadFrequently: true });
            if (context) { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); rgb = context.getImageData(0, 0, 1, 1).data; }
        }
        const result = Number(rgb[0]) * .2126 + Number(rgb[1]) * .7152 + Number(rgb[2]) * .0722 > 145 ? 'dark' : 'light';
        paletteCache.set(color, result);
        return result;
    }
    function add(kind, entry, start, end) {
        const range = doc.createRange();
        range.setStart(entry.node, start); range.setEnd(entry.node, end);
        highlights.get(kind + '-' + entry.palette).add(range);
    }
    function refresh() {
        timer = null;
        for (const highlight of highlights.values()) highlight.clear();
        if (disposed || !enabled) return;
        computedColors = new WeakMap(); explicitColors = new WeakMap();
        const walker = doc.createTreeWalker(root, 4); // SHOW_TEXT; never edit React/card-owned DOM.
        let group = [], block = null, text = '';
        function flush() {
            for (const [start, end] of findQuotes(text)) for (const entry of group) {
                const from = Math.max(start, entry.offset), to = Math.min(end, entry.offset + entry.node.length);
                if (from < to) add('quote', entry, from - entry.offset, to - entry.offset);
            }
            group = []; text = '';
        }
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const element = node.parentElement;
            if (!element || element.closest(excluded) || explicitColor(element)) { flush(); block = null; continue; }
            const owner = element.closest(blocks) || root;
            // <br> is a rendered line break even without a newline text node.
            if (owner !== block || (node.previousSibling && node.previousSibling.nodeName === 'BR')) flush();
            block = owner;
            const entry = { node, offset: text.length, palette: palette(element) };
            group.push(entry); text += node.data;
            if (element.closest('q')) add('quote', entry, 0, node.length);
            else if (element.closest('em,i')) add('em', entry, 0, node.length);
        }
        flush();
    }
    function schedule() { if (!disposed && enabled && timer === null) timer = win.setTimeout(refresh, 32); }
    const observer = new win.MutationObserver(schedule);
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style', 'class', 'color', 'hidden'] });
    if (doc.documentElement !== root) observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
    // Batch mounts before reading computed styles; each message adds a stylesheet.
    schedule();
    return {
        setColors,
        setEnabled(value) {
            enabled = value !== false;
            if (timer !== null) win.clearTimeout(timer);
            timer = null;
            if (enabled) schedule();
            else for (const highlight of highlights.values()) highlight.clear();
        },
        dispose() {
            disposed = true; observer.disconnect(); if (timer !== null) win.clearTimeout(timer);
            for (const kind of highlights.keys()) win.CSS.highlights.delete(prefix + '-' + kind);
            style.remove();
        }
    };
}

// Display colors belong to the host theme; legacy per-browser overrides are ignored.
function tavernTextColorsEnabled() { return true; }
function tavernTextColorOverrides(host) {
    const doc = host.document;
    const probe = doc.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--dsw-alias-brand-primary, currentColor)';
    doc.body.appendChild(probe);
    const accent = host.getComputedStyle(probe).color;
    probe.remove();
    return { quote: accent, em: accent };
}
function TavernColoredMarkdown(props) {
    const root = React.useRef(null);
    React.useEffect(function () {
        const colors = installTavernTextColors(root.current, {}, findTavernQuoteRanges);
        return () => colors.dispose();
    }, []);
    return React.createElement('div', { ref: root, className: 'dsh-tavern-colored-markdown' }, React.createElement(DshUi.MarkdownText, props));
}
