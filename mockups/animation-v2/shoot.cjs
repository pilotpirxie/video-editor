const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const VIEWS = ['episode', 'draw', 'fill', 'frames', 'mouths', 'reuse']
const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice(7)

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1680, height: 980, useContentSize: true, show: false, backgroundColor: '#14171d' })
  const output = path.join(__dirname, 'screens')
  fs.mkdirSync(output, { recursive: true })
  window.webContents.on('console-message', (event) => console.log(`[page] ${event.message}`))
  for (const [index, view] of VIEWS.entries()) {
    if (only && only !== view) continue
    await window.loadFile(path.join(__dirname, 'index.html'), { query: { view } })
    await new Promise((resolve) => setTimeout(resolve, 400))
    const image = await window.webContents.capturePage(undefined, { stayHidden: true })
    const file = path.join(output, `${String(index + 1).padStart(2, '0')}-${view}.png`)
    fs.writeFileSync(file, image.toPNG())
    console.log(file, image.getSize())
  }
  app.quit()
})
