import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import path from 'node:path'
const source = process.argv[2]
if (!source) throw new Error('Pass an unmodified dsh-dream-skin 9.23.0 package directory')
const root = new URL('../tavern-plugin/packages/dsh-dream-skin/', import.meta.url)
const manifest = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8'))
if (manifest.name !== 'dsh-dream-skin' || manifest.version !== '9.23.0') throw new Error('Expected dsh-dream-skin 9.23.0')
let client = readFileSync(path.join(source, 'lib/client.js'), 'utf8').replaceAll('\r\n', '\n')
const themes = JSON.parse(readFileSync(new URL('tavern-themes.json', root), 'utf8'))
function replace(pattern, value) {
  if (!client.match(pattern)) throw new Error(`Upstream shape changed: ${pattern}`)
  client = client.replace(pattern, value)
}
replace(/const SKINS = \[/, 'const SKINS = [\n' + themes.map(t => JSON.stringify(t, null, 2)).join(',\n') + ',')
replace(/children: t\(`skin\.\$\{skin.id\}`\)/, 'children: skin.label || t(`skin.${skin.id}`)')
replace(/\[STORAGE_KEY\]: "nebula",/, '[STORAGE_KEY]: "tavern-terracotta",')
replace(/\[WALLPAPER_KEY\]: "data:image[^\n]+/, '[WALLPAPER_KEY]: null,')
replace(/\[WALLPAPER_URL_KEY\]: "https:[^\n]+/, '[WALLPAPER_URL_KEY]: null,')
replace(/\[WALLPAPER_GRADIENT_KEY\]: "radial-gradient[^\n]+/, '[WALLPAPER_GRADIENT_KEY]: null,')
for (const file of ['lib/index.js', 'package.json', 'cordis.patch.yml', 'LICENSE']) copyFileSync(path.join(source, file), new URL(file, root))

replace(/function wallpapersSuggestionsFor\(activeId\) \{/, "function wallpapersSuggestionsFor(activeId) {\n            if (activeId === \"tavern-terracotta\") return \"radial-gradient(ellipse at top right, rgba(204,120,92,.16), transparent 65%), linear-gradient(160deg, #faf9f5, #f5f0e8)\";\n            if (activeId === \"tavern-terracotta-dark\") return \"radial-gradient(ellipse at top right, rgba(212,137,108,.14), transparent 65%), linear-gradient(160deg, #181715, #252320)\";")
writeFileSync(new URL('lib/client.js', root), client)
