// One observer of DSH theme tokens shared by every message frame and inline fragment.
// DSH emits preferences as CSS variables and stylesheets, so each head/root style
// mutation is re-read once here instead of once per mounted card.
const tavernHostThemeListeners = new Set();
let tavernHostThemeObserver = null, tavernHostTheme = null;
function readTavernHostTheme(win) {
    const value = parseFloat(win.getComputedStyle(win.document.body).getPropertyValue("--dsh-content-font-size"));
    return { fontSize: Number.isFinite(value) && value >= 8 && value <= 48 ? value : 14, textColorOverrides: tavernTextColorOverrides(win) };
}
function currentTavernHostTheme(win) {
    return tavernHostTheme || readTavernHostTheme(win);
}
function subscribeTavernHostTheme(win, listener) {
    if (!tavernHostThemeObserver) {
        tavernHostTheme = readTavernHostTheme(win);
        tavernHostThemeObserver = new win.MutationObserver(function () {
            const next = readTavernHostTheme(win);
            if (next.fontSize === tavernHostTheme.fontSize && next.textColorOverrides.quote === tavernHostTheme.textColorOverrides.quote) return;
            tavernHostTheme = next;
            tavernHostThemeListeners.forEach(function (notify) { notify(next); });
        });
        tavernHostThemeObserver.observe(win.document.head, { subtree: true, childList: true, characterData: true });
        [win.document.documentElement, win.document.body].filter(Boolean).forEach(function (node) { tavernHostThemeObserver.observe(node, { attributes: true, attributeFilter: ["style", "class", "data-ds-dark-theme"] }); });
    }
    tavernHostThemeListeners.add(listener);
    return function () {
        tavernHostThemeListeners.delete(listener);
        if (tavernHostThemeListeners.size || !tavernHostThemeObserver) return;
        tavernHostThemeObserver.disconnect();
        tavernHostThemeObserver = null;
        tavernHostTheme = null;
    };
}
