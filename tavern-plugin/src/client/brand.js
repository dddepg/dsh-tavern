// The tavern shell owns the tab while it is mounted. The logo reaches the
// stylesheet through a custom property so tavern.css stays a verbatim asset.
// The icon link is appended last so it wins over the host icon; disposal
// restores the host icon.
function installTavernBrand(doc, logoUrl) {
  const root = doc.documentElement;
  root.style.setProperty('--dsh-tavern-logo', 'url("' + logoUrl + '")');
  const link = doc.createElement('link');
  link.rel = 'icon';
  link.type = 'image/svg+xml';
  link.href = logoUrl;
  link.dataset.plugin = 'dsh-tavern-plugin';
  doc.head.appendChild(link);
  return function () {
    link.remove();
    root.style.removeProperty('--dsh-tavern-logo');
  };
}
