/*
 * TeX Live's files for a TeX engine running as WebAssembly, one at a time, as the engine asks for
 * them. Linked with -Wl,--wrap=kpse_find_file,--wrap=kpathsea_find_file: kpathsea looks first where
 * it always does (the working directory with the project's files, files fetched before); what it
 * does not find there is handed to the JavaScript side (kpse_fetch.js), which gets the file from
 * whoever runs the engine and writes it into the engine's file system.
 *
 * Part of OverLyX, GPL-3.0-or-later.
 */
#include <stddef.h>

typedef struct kpathsea_instance *kpathsea;

extern char *__real_kpse_find_file(const char *name, int format, int must_exist);
extern char *__real_kpathsea_find_file(kpathsea kpse, const char *name, int format, int must_exist);
/* kpse_fetch.js: the path of the fetched file (malloc'ed), or NULL */
extern char *overlyx_kpse_fetch(const char *name, int format);

char *__wrap_kpse_find_file(const char *name, int format, int must_exist)
{
    char *found = __real_kpse_find_file(name, format, must_exist);
    return found != NULL ? found : overlyx_kpse_fetch(name, format);
}

/* LuaTeX's kpse.new() instances look up through the reentrant API */
char *__wrap_kpathsea_find_file(kpathsea kpse, const char *name, int format, int must_exist)
{
    char *found = __real_kpathsea_find_file(kpse, name, format, must_exist);
    return found != NULL ? found : overlyx_kpse_fetch(name, format);
}
