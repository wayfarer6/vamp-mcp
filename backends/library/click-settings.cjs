'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');

const defaultPercent = 90;
function validate(percent) {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100)
    throw Error('Choose a whole percentage from 1 to 100, or 0 to disable click verification.');
  return percent;
}
function filename(registry) {
  if (!registry) throw Error('An RPA catalog is required to save click settings.');
  return path.join(registry, '.vamp-click-settings.json');
}
async function read(registry) {
  if (!registry) return defaultPercent;
  try {
    return validate(JSON.parse(await fs.readFile(filename(registry), 'utf8')).minimum_percent);
  } catch (error) {
    if (error.code === 'ENOENT') return defaultPercent;
    throw error;
  }
}
async function save(registry, percent) {
  validate(percent);
  const destination = filename(registry);
  await fs.mkdir(registry, {recursive: true, mode: 0o700});
  const temporary = destination + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temporary, JSON.stringify({minimum_percent: percent}) + '\n', {mode: 0o600, flag: 'wx'});
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, {force: true});
  }
  return percent;
}
async function forRun(registry, override, requested) {
  if (override === undefined) return read(registry);
  if (requested !== true) throw Error('Ask the user before overriding click verification for this run.');
  return validate(override);
}
module.exports = {defaultPercent, read, save, forRun};
