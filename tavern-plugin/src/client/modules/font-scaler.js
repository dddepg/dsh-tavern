// Scales text by fontSize / 14 without resizing boxes: viewport units and fixed
// layouts stay intact. Shared by message iframes (embedded via toString, so it must
// stay self-contained) and trusted inline fragments in the host DOM.

// Also used on runtime-report clones: presentation preferences must never become saved card styles.
function restoreTavernFrameFontStyles(root) {
	const attribute = "data-dsh-tavern-font-original";
	const nodes = Array.from(root.querySelectorAll("[" + attribute + "]"));
	if (root.hasAttribute && root.hasAttribute(attribute)) nodes.unshift(root);
	nodes.forEach(function (node) {
		try {
			const saved = JSON.parse(node.getAttribute(attribute));
			["font-size", "line-height"].forEach(function (name, index) {
				if (node.style.getPropertyValue(name) !== saved.applied[index]) return;
				const original = saved.original[index];
				if (original[0]) node.style.setProperty(name, original[0], original[1]);
				else node.style.removeProperty(name);
			});
			if (!saved.hadStyle && !node.getAttribute("style")) node.removeAttribute("style");
		} catch (_) {}
		node.removeAttribute(attribute);
	});
}

function createTavernFontScaler(root, restore) {
	const doc = root.ownerDocument, view = doc.defaultView;
	// Inside a frame the whole document is ours; in the host DOM only the root's subtree.
	const own = root === doc.body;
	const scope = own ? "*" : "[data-dsh-tavern-font-root]";
	if (!own) root.setAttribute("data-dsh-tavern-font-root", "");
	let fontSize = 14, scheduled = false, disposed = false, scaledText = new WeakSet();
	// Mouse-follow effects update transforms every frame. They do not change
	// typography; remeasuring would cancel the author's running transitions.
	const paintOnly = new Set(["transform", "transform-origin", "translate", "rotate", "scale", "opacity"]);
	function hasText(node) {
		return /^(INPUT|TEXTAREA|SELECT|OPTION)$/.test(node.tagName) || Array.from(node.childNodes).some(function (child) { return child.nodeType === 3 && /\S/.test(child.nodeValue || ""); });
	}
	function typographyChanged(record) {
		// Clocks, counters and streamed text only replace text. Computed sizes stay the
		// same unless an element starts or stops directly holding text.
		if (record.type === "characterData" || (record.type === "childList"
			&& Array.from(record.addedNodes).concat(Array.from(record.removedNodes)).every(function (node) { return node.nodeType === 3; }))) {
			const owner = record.type === "characterData" ? record.target.parentNode : record.target;
			return !owner || owner.nodeType !== 1 || hasText(owner) !== scaledText.has(owner);
		}
		if (record.type !== "attributes" || record.attributeName !== "style") return true;
		const before = doc.createElement("span").style;
		before.cssText = record.oldValue || "";
		const after = record.target.style;
		if (!after) return true;
		for (const name of new Set([...before, ...after])) {
			if (paintOnly.has(name)) continue;
			if (before.getPropertyValue(name) !== after.getPropertyValue(name)
				|| before.getPropertyPriority(name) !== after.getPropertyPriority(name)) return true;
		}
		return false;
	}
	const observer = new view.MutationObserver(function (records) {
		// At the original size there is nothing to keep in sync.
		if (fontSize !== 14 && (!records || records.some(typographyChanged))) schedule();
	});
	function observe() { observer.observe(own ? doc.documentElement : root, { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true, attributeFilter: ["style", "class", "hidden"] }); }
	function schedule() {
		if (scheduled || disposed) return;
		scheduled = true;
		view.requestAnimationFrame(apply);
	}
	function apply() {
		scheduled = false;
		const target = own ? doc.body : root;
		if (disposed || !target) return;
		observer.disconnect();
		// Cancel author transitions while restoring/measuring; otherwise computed font
		// sizes can still be the previous scaled frame, which compounds on each update.
		const measurementStyle = doc.createElement("style");
		measurementStyle.setAttribute("data-dsh-tavern-font-measure", "");
		measurementStyle.textContent = own ? "*,*::before,*::after{transition:none!important}" : [scope, scope + " *", scope + " *::before", scope + " *::after"].join(",") + "{transition:none!important}";
		(doc.head || doc.documentElement).appendChild(measurementStyle);
		try {
			restore(target);
			scaledText = new WeakSet();
			const ratio = fontSize / 14;
			if (ratio === 1) return;
			// Measure everything before writing, with our old overrides removed. This prevents
			// inherited em/rem sizes and repeated preference changes from compounding.
			const measured = [target].concat(Array.from(target.querySelectorAll("*"))).filter(function (node) {
				return node.style && !/^(SCRIPT|STYLE|LINK|META|NOSCRIPT)$/.test(node.tagName) && (!node.closest("svg") || node.tagName.toLowerCase() === "svg");
			}).map(function (node) {
				const text = hasText(node);
				if (text) scaledText.add(node);
				const style = view.getComputedStyle(node), factor = text ? ratio : 1;
				return { node: node, size: parseFloat(style.fontSize) * factor, line: parseFloat(style.lineHeight) * factor };
			});
			measured.forEach(function (item) {
				if (!Number.isFinite(item.size) || item.size <= 0) return;
				const node = item.node, names = ["font-size", "line-height"];
				const saved = { hadStyle: node.hasAttribute("style"), original: names.map(function (name) { return [node.style.getPropertyValue(name), node.style.getPropertyPriority(name)]; }), applied: [] };
				node.style.setProperty("font-size", item.size.toFixed(4) + "px", "important");
				if (Number.isFinite(item.line)) node.style.setProperty("line-height", item.line.toFixed(4) + "px", "important");
				saved.applied = names.map(function (name) { return node.style.getPropertyValue(name); });
				node.setAttribute("data-dsh-tavern-font-original", JSON.stringify(saved));
			});
		} finally {
			// Flush the final values before restoring transitions, so the adapter itself
			// does not start another interpolation from the temporary unscaled state.
			void view.getComputedStyle(target).fontSize;
			measurementStyle.remove();
			observe();
		}
	}
	function loaded(event) { if (own || root.contains(event.target)) schedule(); }
	observe();
	view.addEventListener("resize", schedule);
	doc.addEventListener("load", loaded, true);
	return {
		set: function (next) {
			next = Number(next);
			if (!Number.isFinite(next) || next < 8 || next > 48 || next === fontSize) return;
			fontSize = next;
			schedule();
		},
		dispose: function () {
			if (disposed) return;
			disposed = true;
			observer.disconnect();
			view.removeEventListener("resize", schedule);
			doc.removeEventListener("load", loaded, true);
			restore(own ? doc.body : root);
			if (!own) root.removeAttribute("data-dsh-tavern-font-root");
		}
	};
}
