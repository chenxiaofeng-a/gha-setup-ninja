const core = require('@actions/core')
const process = require('process')
const spawn = require('child_process').spawnSync
const path = require('path')
const fs = require('fs')
const URL = require('url').URL
const { https } = require('follow-redirects')
const AdmZip = require('adm-zip')
const HttpsProxyAgent = require('https-proxy-agent')

function selectPlatform(platform, version) {
  if (platform) {
    return [null, platform]
  }

  let major, minor, patch = version.split('.').map((s) => parseInt(s))
  if (process.platform === 'win32') {
    if (process.arch === 'arm64') {
      if (major < 1 || major == 1 && minor < 12) {
        return [new Error(`Windows ARM builds are only available for 1.12.0 and later`), '']
      } else {
        return [null, 'winarm64']
      }
    } else if (process.arch === 'x64') {
      return [null, 'win']
    } else {
      return [new Error(`Unsupported architecture '${process.arch}'`), '']
    }
  } else if (process.platform === 'linux') {
    if (process.arch === 'arm64') {
      if (major < 1 || major == 1 && minor < 12) {
        return [new Error(`Linux ARM builds are only available for 1.12.0 and later`), '']
      } else {
        return [null, 'linux-aarch64']
      }
    } else if (process.arch === 'x64') {
      return [null, 'linux']
    } else {
      return [new Error(`Unsupported architecture '${process.arch}'`), '']
    }
  } else if (process.platform === 'darwin') {
    return [null, 'mac']
  } else {
    return [new Error(`Unsupported platform '${process.platform}'`), '']
  }
}

function download(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { followAllRedirects: true, timeout: timeoutMs }, result => {
      const data = []
      result.on('data', chunk => data.push(chunk))
      result.on('end', () => {
        const length = data.reduce((len, chunk) => len + chunk.length, 0)
        const buffer = Buffer.alloc(length)
        data.reduce((pos, chunk) => {
          chunk.copy(buffer, pos)
          return pos + chunk.length
        }, 0)
        resolve(buffer)
      })
      result.on('error', reject)
    })
    request.on('timeout', () => {
      request.destroy()
      reject(new Error(`Download timed out after ${timeoutMs}ms`))
    })
    request.on('error', reject)
  })
}

async function downloadWithRetry(url, timeoutMs, retries) {
  let lastError
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`Download attempt ${attempt}/${retries} (timeout: ${timeoutMs}ms)`)
      const buffer = await download(url, timeoutMs)
      console.log(`Download succeeded on attempt ${attempt}`)
      return buffer
    } catch (error) {
      lastError = error
      console.log(`Attempt ${attempt} failed: ${error.message}`)
      if (attempt < retries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000)
        console.log(`Retrying in ${delay}ms...`)
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }
  throw new Error(`All ${retries} download attempts failed. Last error: ${lastError.message}`)
}

async function run() {
  const version = core.getInput('version', { required: true })
  const destDir = core.getInput('destination') || 'ninja-build'
  const proxyServer = core.getInput('http_proxy')
  const timeoutMs = parseInt(core.getInput('timeout') || '300000', 10)
  const retries = parseInt(core.getInput('retries') || '3', 10)

  const [error, platform] = selectPlatform(core.getInput('platform'), version)
  if (error) throw error

  const url = new URL(`https://github.com/ninja-build/ninja/releases/download/v${version}/ninja-${platform}.zip`)

  if (proxyServer) {
    console.log(`using proxy ${proxyServer}`)
    url.agent = new HttpsProxyAgent(proxyServer)
  }

  console.log(`downloading ${url}`)
  const buffer = await downloadWithRetry(url, timeoutMs, retries)

  const zip = new AdmZip(buffer)
  const entry = zip.getEntries()[0]
  const ninjaName = entry.entryName

  const fullDestDir = path.resolve(process.cwd(), destDir)
  if (!fs.existsSync(fullDestDir)) fs.mkdirSync(fullDestDir, { recursive: true })

  zip.extractEntryTo(ninjaName, fullDestDir, false, true)

  const fullFileDir = path.join(fullDestDir, ninjaName)
  if (!fs.existsSync(fullFileDir)) throw new Error(`failed to extract to '${fullFileDir}'`)

  fs.chmodSync(fullFileDir, '755')
  console.log(`extracted '${ninjaName}' to '${fullFileDir}'`)

  core.addPath(fullDestDir)
  console.log(`added '${fullDestDir}' to PATH`)

  const result = spawn(ninjaName, ['--version'], { encoding: 'utf8' })
  if (result.error) throw result.error

  const installedVersion = result.stdout.trim()
  console.log(`$ ${ninjaName} --version`)
  console.log(installedVersion)

  if (installedVersion != version) {
    throw new Error('incorrect version detected (bad PATH configuration?)')
  }
}

run().catch(error => core.setFailed(error.message))