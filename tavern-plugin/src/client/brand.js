// The tavern shell owns the tab while it is mounted. Brand images reach the
// stylesheet through custom properties so tavern.css stays a verbatim asset.
// The icon link is appended last so it wins over the host icon; disposal
// restores the host icon.
function installTavernBrand(doc, urls) {
  const root = doc.documentElement;
  const properties = { '--dsh-tavern-logo': urls.logo, '--dsh-tavern-lockup': urls.lockup, '--dsh-tavern-lockup-dark': urls['lockup-dark'] };
  for (const [name, url] of Object.entries(properties)) root.style.setProperty(name, 'url("' + url + '")');
  const link = doc.createElement('link');
  link.rel = 'icon';
  link.type = 'image/svg+xml';
  link.href = urls.logo;
  link.dataset.plugin = 'dsh-tavern-plugin';
  doc.head.appendChild(link);
  return function () {
    link.remove();
    for (const name of Object.keys(properties)) root.style.removeProperty(name);
  };
}
