// Reads `firebase … --json` output on stdin for the Deploy backend workflow.
//   app-id                the first web app's ID from `apps:list WEB` (empty if there's none)
//   created-id            the new app's ID from `apps:create WEB`
//   write <file>          writes the web config from `apps:sdkconfig WEB` into firebase-config.js
import fs from 'node:fs';

const [mode, file] = process.argv.slice(2);
const input = fs.readFileSync(0, 'utf8');
// Anything printed before the JSON (an update notice) is skipped.
const reply = JSON.parse(input.slice(input.indexOf('{')));
const result = reply.result ?? reply;

function sdkConfig(r) {
  if (r.sdkConfig) return r.sdkConfig;
  // Older CLIs only give the file contents: a JS or JSON snippet holding the config object.
  const text = r.fileContents || '';
  const body = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    return JSON.parse(body);
  } catch {
    return Function(`"use strict"; return (${body});`)();
  }
}

if (mode === 'app-id') {
  process.stdout.write((Array.isArray(result) ? result[0]?.appId : '') || '');
} else if (mode === 'created-id') {
  if (!result.appId) throw new Error(`No appId in: ${input.slice(0, 300)}`);
  process.stdout.write(result.appId);
} else if (mode === 'write') {
  const config = sdkConfig(result);
  const keep = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'];
  const clean = Object.fromEntries(keep.filter((k) => config[k]).map((k) => [k, config[k]]));
  if (!clean.apiKey || !clean.projectId || !clean.appId) throw new Error('The web config is missing apiKey, projectId or appId.');
  const source = fs.readFileSync(file, 'utf8');
  const next = source.replace('export const FIREBASE = null;', `export const FIREBASE = ${JSON.stringify(clean, null, 2)};`);
  if (next === source) throw new Error(`${file} has no "export const FIREBASE = null;" to replace.`);
  fs.writeFileSync(file, next);
  console.log(`Wrote the config for ${clean.projectId} into ${file}.`);
} else {
  throw new Error(`Unknown mode: ${mode}`);
}
