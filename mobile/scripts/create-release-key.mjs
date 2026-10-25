// Create a persistent key outside the checkout. Never print passwords/private key data.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const directory = path.resolve(process.argv[2] || '');
assert(process.argv[2], 'Usage: node mobile/scripts/create-release-key.mjs /absolute/private/directory');
const parent = realpathSync(path.dirname(directory));
const canonical = path.join(parent, path.basename(directory));
assert(!canonical.startsWith(root + path.sep) && canonical !== root, 'Signing files must be outside the checkout');
mkdirSync(canonical, {recursive: true, mode: 0o700});
const configFile = path.join(canonical, 'signing.json');
const storeFile = path.join(canonical, 'beatmaker-android-release.jks');
assert(!existsSync(configFile) && !existsSync(storeFile), 'Existing key/config will not be overwritten');
const password = randomBytes(32).toString('base64url');
const keyAlias = 'beatmaker-release';
const keytool = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin/keytool') : 'keytool';
execFileSync(keytool, ['-genkeypair', '-keystore', storeFile, '-storetype', 'JKS', '-alias', keyAlias,
  '-keyalg', 'RSA', '-keysize', '4096', '-sigalg', 'SHA256withRSA', '-validity', '10950',
  '-dname', 'CN=Beatmaker Cues, O=Beatmaker Cues', '-storepass:env', 'BEATMAKER_KEY_PASSWORD', '-keypass:env', 'BEATMAKER_KEY_PASSWORD'],
  {env: {...process.env, BEATMAKER_KEY_PASSWORD: password}, stdio: ['ignore', 'pipe', 'pipe']});
writeFileSync(configFile, JSON.stringify({storeFile, storePassword: password, keyAlias, keyPassword: password}, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
console.log(`Created persistent signing key and private config in ${canonical}. Back up this private directory securely.`);
