// Kaimono Check scan server: phone-friendly loader. Paste only this into Apps Script.
// It downloads the real server code (server/Code.gs) from the app's GitHub repo and runs it,
// re-checking every 10 minutes, so updates arrive without editing or redeploying anything here.
const SOURCE = 'https://raw.githubusercontent.com/SpidyLoke/shopping/main/server/Code.gs';

function loadServer() {
  const cache = CacheService.getScriptCache();
  let code = cache.get('server-code');
  if (!code) {
    code = UrlFetchApp.fetch(SOURCE).getContentText();
    cache.put('server-code', code, 600);
  }
  return new Function(`${code}\nreturn { doPost };`)();
}

function doPost(e) {
  return loadServer().doPost(e);
}

// Run once from the editor to grant permission to make web requests.
function authorise() {
  UrlFetchApp.fetch(SOURCE);
}
