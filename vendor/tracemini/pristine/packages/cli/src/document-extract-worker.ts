import {extractDocument} from './document-inspection.js';

const [file, displayName] = process.argv.slice(2);
extractDocument(file, displayName).then(result => process.stdout.write(JSON.stringify(result))).catch(error => {
  process.stderr.write(String(error?.message || error));
  process.exitCode = 1;
});
