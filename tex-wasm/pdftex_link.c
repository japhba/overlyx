/* What a module of pdfTeX alone lacks from BusyTeX's objects, made for one module of all engines:
   - the file-name buffer, which BusyTeX declares extern in pdftexd.h so that pdfTeX shares XeTeX's
     (lib/texmfmp.c uses one of them);
   - pdftex_fail for pdftoepdf.cc, the one C++ file BusyTeX's renaming (busypdftex_*) leaves out. */
#include <stdarg.h>
#include <stdio.h>

unsigned char *nameoffile;
int namelength;

extern void busypdftex_pdftex_fail(const char *fmt, ...);

void pdftex_fail(const char *fmt, ...)
{
    char msg[1024];
    va_list args;
    va_start(args, fmt);
    vsnprintf(msg, sizeof msg, fmt, args);
    va_end(args);
    busypdftex_pdftex_fail("%s", msg);
}
