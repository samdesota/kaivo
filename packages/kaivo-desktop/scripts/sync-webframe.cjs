const fs = require('node:fs')
const path = require('node:path')

const source = path.resolve(__dirname, '..', '..', 'webframe')
const target = path.resolve(__dirname, '..', 'node_modules', '@samdesota', 'webframe')

if (!fs.existsSync(target)) {
  throw new Error('WebFrame is not installed; run npm install in packages/kaivo-desktop')
}

for (const relativePath of ['dist', path.join('sqlite', 'dist')]) {
  const sourcePath = path.join(source, relativePath)
  const targetPath = path.join(target, relativePath)
  fs.rmSync(targetPath, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  fs.cpSync(sourcePath, targetPath, { recursive: true })
}

for (const file of ['package.json', 'README.md']) {
  fs.copyFileSync(path.join(source, file), path.join(target, file))
}
