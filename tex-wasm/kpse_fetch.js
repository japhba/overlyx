// The JavaScript half of kpse_fetch.c (an Emscripten --js-library). A file kpathsea did not find is
// asked of Module.texliveFile(name, format): whoever runs the engine sets it (the browser's worker
// fetches from the server, a script on the server reads its own TeX Live) and returns
// { name, data } — the file's real name, as a request without an extension finds `name.otf` — or
// null. The file goes to /texlive/<format>/<name> in the engine's memory file system, where later
// requests for it find it without asking again.
//
// Part of OverLyX, GPL-3.0-or-later.
addToLibrary({
  $KPSE_FETCH: { found: {} },
  overlyx_kpse_fetch__deps: ['$KPSE_FETCH', '$UTF8ToString', '$stringToNewUTF8', '$FS'],
  overlyx_kpse_fetch: function (namePtr, format) {
    var name = UTF8ToString(namePtr);
    // a path /texlive/<format>/<name> is a file an earlier run fetched, asked for again by its name:
    // XeTeX writes its fonts' paths into the .xdv for xdvipdfmx, which runs in an instance of its own
    var earlier = /^\/texlive\/(\d{1,2})\/([A-Za-z0-9][A-Za-z0-9._+-]*)$/.exec(name);
    if (earlier) { format = Number(earlier[1]); name = earlier[2]; }
    var key = format + '/' + name;
    var known = KPSE_FETCH.found[key];
    if (known !== undefined) return known === null ? 0 : stringToNewUTF8(known);
    var file = null;
    // only a plain file name: any other path names the project's own files, which are all there already
    if (name && name.length < 256 && name.indexOf('/') < 0 && name.charAt(0) !== '.' && typeof Module['texliveFile'] === 'function') {
      try { file = Module['texliveFile'](name, format); } catch (e) { file = null; }
    }
    var path = null;
    if (file && file.data && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(file.name)) {
      var dir = '/texlive/' + format;
      try { FS.mkdirTree(dir); } catch (e) { /* there */ }
      path = dir + '/' + file.name;
      FS.writeFile(path, file.data);
    }
    KPSE_FETCH.found[key] = path;
    return path === null ? 0 : stringToNewUTF8(path);
  },
});
