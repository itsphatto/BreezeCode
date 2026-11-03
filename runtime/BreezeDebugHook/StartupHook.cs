// Loaded into a C# program Breeze debugs (DOTNET_STARTUP_HOOKS), before its Main. Breeze starts the program itself,
// so it owns the program's input and output; this holds the program until netcoredbg has attached and Breeze has
// set the breakpoints (it then creates the BREEZE_DEBUG_GO file). After 15 s the program runs on regardless.
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

internal class StartupHook
{
    public static void Initialize()
    {
        var go = Environment.GetEnvironmentVariable("BREEZE_DEBUG_GO");
        if (string.IsNullOrEmpty(go)) return;
        var until = DateTime.UtcNow.AddSeconds(15);
        while (DateTime.UtcNow < until && !(Debugger.IsAttached && File.Exists(go))) Thread.Sleep(5);
    }
}
