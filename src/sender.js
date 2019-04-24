'use strict'

const fs = require('graceful-fs')
const parseUrl = require('url').parse
const FormData = require('form-data')
const StringDecoder = require('string_decoder').StringDecoder
const request = require('request')
const log = require('./log')

const PACKMGR_PATH_AEM = '/crx/packmgr/service.jsp'
const PACKMGR_PATH_SLING = '/bin/cpm/package.service.html'
const SYSTEM_CONSOLE_BUNDLES = '/system/console/bundles.json'
const RE_STATUS = /code="([0-9]+)">(.*)</

class Sender {
  constructor ({targets, packmgrPath, checkBundles}) {
    this.targets = targets
    this.checkBundles = checkBundles || false
    this.packmgrPath = packmgrPath || PACKMGR_PATH_AEM
    if(this.packmgrPath === 'SLING') {
      this.packmgrPath = PACKMGR_PATH_SLING;
    } else if(this.packmgrPath === 'AEM') {
      this.packmgrPath = PACKMGR_PATH_AEM;
    }
  }

  /** Submits the package manager form. */
  send (zipPath, callback) {
    log.debug('Posting...')
    for (let i = 0; i < this.targets.length; ++i) {
      if(checkBundles) {
        this.checkBundleStatusAndSendFormToTarget(zipPath, this.targets[i], callback)
      } else {
        this.sendFormToTarget(zipPath, this.targets[i], callback)
      }
    }
  }

  checkBundleStatusAndSendFormToTarget (zipPath, target, callback, retries = 1) {
    log.debug('check if system is fully up and running...');
    const host = target.substring(target.indexOf('@') + 1)
    const timestamp = Date.now()
    const that = this;

    request(target + SYSTEM_CONSOLE_BUNDLES, function(err, res, body) {
      if (!res) {
        const delta = Date.now() - timestamp
        const time = new Date().toISOString()
        return callback(err.code, host, delta, time)
      }
      if(res.statusCode === 200) {
        try {
          const data = JSON.parse(body);
          log.debug(data.s)
          if(data.s.length === 5 && data.s[3] === 0 && data.s[4] === 0) {
            that.sendFormToTarget (zipPath, target, callback)
          } else {
            if(retries === 11) {
              const delta = Date.now() - timestamp
              const time = new Date().toISOString()
              return callback('exhausted all retries, system not ready', host, delta, time)
            }
            log.info(`not all services started, will wait with deployment (${retries}/10)`)
            setTimeout(function() { that.checkBundleStatusAndSendFormToTarget (zipPath, target, callback, retries+1) }, 1000);
          }
        } catch(error) {
          const delta = Date.now() - timestamp
          const time = new Date().toISOString()
          return callback(`not able to parse response from ${SYSTEM_CONSOLE_BUNDLES}`, host, delta, time)
        }
      } else {
        const delta = Date.now() - timestamp
        const time = new Date().toISOString()
        return callback(res.statusCode, host, delta, time)
    }
    })
  }

  sendFormToTarget (zipPath, target, callback) {
    const params = parseUrl(target)
    const auth = Buffer.from(params.auth).toString('base64')
    const timestamp = Date.now()

    const options = {}
    options.path = this.packmgrPath
    options.port = params.port
    options.host = params.hostname
    options.headers = {
      'Authorization': 'Basic ' + auth
    }

    const form = new FormData()
    form.append('file', fs.createReadStream(zipPath))
    form.append('force', 'true')
    form.append('install', 'true')
    form.submit(options, (err, res) => {
      this.onSubmit(err, res, zipPath, target, timestamp, callback)
    })
  }

  /** Package install submit callback */
  onSubmit (err, res, zipPath, target, timestamp, callback) {
    const host = target.substring(target.indexOf('@') + 1)
    let errorMessage = 'Invalid response; is the packmgr path valid?'

    // Server error.
    if (!res) {
      const delta = Date.now() - timestamp
      const time = new Date().toISOString()
      return callback(err.code, host, delta, time)
    }

    const decoder = new StringDecoder('utf8')
    const output = [`Output from ${host}:`]

    res.on('data', (chunk) => {
      // Get message and remove new line.
      let textChunk = decoder.write(chunk)
      textChunk = textChunk.replace(/\r/g, '').substring(0, textChunk.length - 1)
      output.push(textChunk)

      // Parse message.
      const match = RE_STATUS.exec(textChunk)
      if (match === null || match.length !== 3) {
        return
      }

      const code = match[1]
      const msg = match[2]
      errorMessage = code === '200' ? '' : msg

      log.group()
      output.forEach(line => {
        log.debug(line)
        if (line.startsWith('E ')) {
          errorMessage += `\n${line.substr(2)}`
        }
      })

      log.groupEnd()
    })

    res.on('end', () => {
      let delta = Date.now() - timestamp
      let time = new Date().toISOString()
      callback(errorMessage, host, delta, time)
    })
  }
}

module.exports = Sender
