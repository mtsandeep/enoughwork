import './style.css'

const REPO = 'mtsandeep/enoughwork'
const API = `https://api.github.com/repos/${REPO}/releases/latest`

async function getDownloads() {
  try {
    const res = await fetch(API, { headers: { 'Accept': 'application/vnd.github+json' } })
    if (!res.ok) return null
    const data = await res.json()
    return data.assets.map(a => ({ name: a.name, url: a.browser_download_url }))
  } catch {
    return null
  }
}

function matchAssets(assets, patterns) {
  if (!assets) return []
  return assets.filter(a => patterns.some(p => p.test(a.name)))
}

const warnings = {
  'downloads-windows': '<details class="mt-3"><summary class="text-xs text-neutral-400 cursor-pointer hover:text-neutral-600 transition-colors text-center select-none">Installation notes</summary><p class="text-xs text-neutral-500 text-center mt-2">EnoughWork is open source but not code-signed. Windows SmartScreen may warn about an "unrecognized app" — click <em>More info</em> → <em>Run anyway</em> to proceed.</p></details>',
  'downloads-mac': '<details class="mt-3"><summary class="text-xs text-neutral-400 cursor-pointer hover:text-neutral-600 transition-colors text-center select-none">Installation notes</summary><div class="text-center mt-2"><p class="text-xs text-neutral-500">EnoughWork is open source but not notarized with Apple. To bypass Gatekeeper, run this in Terminal after installing:</p><div class="mt-2 relative"><code class="block bg-neutral-100 rounded-lg px-4 py-2 pr-16 text-xs text-neutral-600 text-left font-mono">xattr -cr /Applications/EnoughWork.app</code><button onclick="copyCmd(this)" class="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-neutral-500 hover:text-neutral-700 transition-colors cursor-pointer">Copy</button></div></div></details>',
}

function renderPanel(containerId, assets) {
  const el = document.getElementById(containerId)
  if (!el) return
  const warning = warnings[containerId] || ''
  if (assets.length === 0) {
    el.innerHTML = '<p class="text-sm text-neutral-400 py-4 text-center">Coming soon</p>'
    return
  }
  el.innerHTML = `<div class="flex flex-col gap-3">${assets.map(a => `
    <a href="${a.url}" class="flex items-center justify-center gap-3 px-6 py-3 rounded-xl border border-neutral-200 text-neutral-700 text-sm font-medium hover:border-neutral-400 hover:bg-neutral-50 transition-colors">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      ${a.name}
    </a>
  `).join('')}</div>${warning}`
}

const assets = await getDownloads()

if (!assets) {
  const msg = '<p class="text-sm text-neutral-400 py-4 text-center">Could not load downloads. Please visit the <a href="https://github.com/mtsandeep/enoughwork/releases/latest" class="underline hover:text-neutral-600">releases page</a>.</p>'
  const ids = ['downloads-windows', 'downloads-mac', 'downloads-linux']
  ids.forEach(id => {
    const el = document.getElementById(id)
    if (el) el.innerHTML = msg
  })
} else {
  renderPanel('downloads-windows', matchAssets(assets, [/\.exe$/, /\.msi$/]))
  renderPanel('downloads-mac', matchAssets(assets, [/\.dmg$/]))
  renderPanel('downloads-linux', matchAssets(assets, [/\.AppImage$/, /\.deb$/]))
}

// Tab switching
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.tab
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.remove('border-neutral-900', 'text-neutral-900')
      b.classList.add('border-transparent', 'text-neutral-400')
    })
    btn.classList.remove('border-transparent', 'text-neutral-400')
    btn.classList.add('border-neutral-900', 'text-neutral-900')
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'))
    document.querySelector(`[data-panel="${key}"]`).classList.remove('hidden')
  })
})
