// Small presentation fragments share the trusted card's host DOM so its shared
// styles and hydration observers can reach them. Executable documents stay framed.
function parseTavernInlineFragment(content, doc) {
    if (!doc?.createElement || /<!doctype|<\/?(?:html|head|body)\b/i.test(content)) return null;
    const template = doc.createElement('template');
    template.innerHTML = String(content);
    const allowed = new Set(['DIV','SPAN','P','IMG','BR','HR','B','STRONG','I','EM','U','S','SMALL','SUB','SUP','BLOCKQUOTE','PRE','CODE','UL','OL','LI','DL','DT','DD','TABLE','THEAD','TBODY','TFOOT','TR','TD','TH','CAPTION','COLGROUP','COL','H1','H2','H3','H4','H5','H6','A','DETAILS','SUMMARY','SECTION','ARTICLE','FIGURE','FIGCAPTION']);
    for (const node of template.content.querySelectorAll('*')) {
        if (!allowed.has(node.tagName)) return null;
        for (const attr of node.attributes) {
            const name = attr.name.toLowerCase();
            if (name.startsWith('on') || name === 'srcdoc' || name === 'is') return null;
            if (['href','src','xlink:href'].includes(name)) {
                const value = attr.value.replace(/[\u0000-\u0020]/g, '');
                if (/^(?:javascript|vbscript):/i.test(value) || (/^data:/i.test(value) && !(node.tagName === 'IMG' && name === 'src' && /^data:image\//i.test(value)))) return null;
            }
        }
    }
    return template.content;
}

// One observer for all fragments: DSH writes the preference as a CSS variable on body.
const tavernContentFontListeners = new Set();
let tavernContentFontObserver = null, tavernContentFontSize = 14;
function readTavernContentFontSize(win) {
    const value = parseFloat(win.getComputedStyle(win.document.body).getPropertyValue("--dsh-content-font-size"));
    return Number.isFinite(value) && value >= 8 && value <= 48 ? value : 14;
}
function subscribeTavernContentFontSize(win, listener) {
    if (!tavernContentFontObserver) {
        tavernContentFontSize = readTavernContentFontSize(win);
        tavernContentFontObserver = new win.MutationObserver(function () {
            const next = readTavernContentFontSize(win);
            if (next === tavernContentFontSize) return;
            tavernContentFontSize = next;
            tavernContentFontListeners.forEach(function (notify) { notify(next); });
        });
        tavernContentFontObserver.observe(win.document.head, { subtree: true, childList: true, characterData: true });
        [win.document.documentElement, win.document.body].forEach(function (node) { tavernContentFontObserver.observe(node, { attributes: true, attributeFilter: ["style", "class"] }); });
    }
    tavernContentFontListeners.add(listener);
    listener(tavernContentFontSize);
    return function () {
        tavernContentFontListeners.delete(listener);
        if (tavernContentFontListeners.size || !tavernContentFontObserver) return;
        tavernContentFontObserver.disconnect();
        tavernContentFontObserver = null;
    };
}

function TavernInlineFragment(props) {
    const ref = React.useRef(null);
    React.useLayoutEffect(function () {
        const root = ref.current;
        if (!root) return;
        const fragment = parseTavernInlineFragment(props.content, root.ownerDocument);
        if (fragment) root.replaceChildren(fragment);
        // Same text-only scaling as message iframes, so both card paths follow the preference alike.
        const scaler = createTavernFontScaler(root, restoreTavernFrameFontStyles);
        const unsubscribe = subscribeTavernContentFontSize(root.ownerDocument.defaultView, scaler.set);
        return function () { unsubscribe(); scaler.dispose(); root.replaceChildren(); };
    }, [props.content]);
    return React.createElement('div', {ref, className:'mes_text dsh-tavern-inline-fragment'});
}
