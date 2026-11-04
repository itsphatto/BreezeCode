/* Injected with -include (C and C++) or built into an object linked into the program (Rust) when Breeze debugs it.
   Breeze starts the program itself, so it owns the program's input and output, and GDB attaches a moment later.
   Attaching lets the program run on in between, so it waits here, before main, until GDB is attached and Breeze has
   set the breakpoints (it then creates the BREEZE_DEBUG_GO file). After 15 s it runs on regardless, and run without
   that variable (not by the debugger) it doesn't wait at all. */
#ifdef __cplusplus
extern "C" {
#endif
__declspec(dllimport) int __stdcall IsDebuggerPresent(void);
__declspec(dllimport) void __stdcall Sleep(unsigned long ms);
__declspec(dllimport) unsigned long long __stdcall GetTickCount64(void);
__declspec(dllimport) unsigned long __stdcall GetEnvironmentVariableW(const unsigned short *name, unsigned short *buf, unsigned long size);
__declspec(dllimport) unsigned long __stdcall GetFileAttributesW(const unsigned short *path);
#ifdef __cplusplus
}
#endif

static void __attribute__((constructor)) breeze_wait_for_debugger(void) {
  static const unsigned short name[] = { 'B', 'R', 'E', 'E', 'Z', 'E', '_', 'D', 'E', 'B', 'U', 'G', '_', 'G', 'O', 0 };
  unsigned short go[1024];
  unsigned long n = GetEnvironmentVariableW(name, go, 1024);
  if (n == 0 || n >= 1024) return;
  unsigned long long until = GetTickCount64() + 15000;
  while (GetTickCount64() < until && !(IsDebuggerPresent() && GetFileAttributesW(go) != 0xFFFFFFFFul)) Sleep(5);
}
