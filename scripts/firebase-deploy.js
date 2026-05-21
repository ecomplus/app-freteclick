require('dotenv').config()

const { execSync } = require('child_process')

const {
  FIREBASE_TOKEN,
  SERVER_OPERATOR_TOKEN,
  SERVER_BASE_URI
} = process.env

require('./scripts-minification')

const { name, version } = require('../package.json')
const { project, baseUri } = require('./_constants')

const firebase = './node_modules/.bin/firebase'

const configValues = [
  `pkg.version=${version}`,
  `pkg.name=${name}`,
  `server.operator_token=${SERVER_OPERATOR_TOKEN}`
]
if (SERVER_BASE_URI) {
  configValues.push(`server.base_uri=${SERVER_BASE_URI}`)
}

console.log(`Deploying to Firebase project: '${project}'`)

try {
  execSync(`${firebase} experiments:enable legacyRuntimeConfigCommands`, { stdio: 'inherit' })
  execSync(`${firebase} functions:config:set ${configValues.join(' ')} --project ${project}`, { stdio: 'inherit' })
  execSync(`${firebase} deploy --project ${project} --force`, { stdio: 'inherit' })
  console.log('\x1b[32m%s\x1b[0m', `\nDeployed with success to Firebase project '${project}'`)
  console.log('\x1b[35m%s\x1b[0m', `\nBase URI: ${baseUri}`)
  console.log()
} catch (err) {
  console.error(err)
  process.exit(1)
}
