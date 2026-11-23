# Fixture-only placement helper. Moves exactly one caller-owned window and
# nothing else: SetWindowPos(own, target, 0,0,0,0, NOMOVE|NOSIZE|NOACTIVATE).
# stdin: one JSON line { "ink": "<decimal>", "target": "<decimal>" }
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { exit 1 }
try {
    Add-Type -ReferencedAssemblies System,System.Web.Extensions -TypeDefinition @'
using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

public static class P0Place {
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    static IntPtr Handle(string value) {
        ulong bits;
        if (value == null || !Regex.IsMatch(value, @"\A[1-9][0-9]*\z") ||
            !ulong.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out bits) ||
            (IntPtr.Size == 4 && bits > uint.MaxValue)) throw new ArgumentException("hwnd");
        return IntPtr.Size == 8 ? new IntPtr(unchecked((long)bits)) : new IntPtr(unchecked((int)bits));
    }

    public static int Run(string input) {
        IntPtr previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (previous == IntPtr.Zero) return 1;
        try {
            var request = Json.Deserialize<Request>(input);
            if (request == null) throw new ArgumentException("input");
            IntPtr ink = Handle(request.ink), target = Handle(request.target);
            Rect inkRect, targetRect;
            if (!IsWindow(ink) || !IsWindow(target) || !GetWindowRect(ink, out inkRect) || !GetWindowRect(target, out targetRect))
                throw new InvalidOperationException();
            // hWndInsertAfter precedes the moved window, so inserting after the
            // window currently above the target puts our ink directly above the
            // target. HWND_TOP covers a target that is already topmost in band.
            IntPtr above = GetWindow(target, 3 /* GW_HWNDPREV */);
            // SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER: only Z insertion.
            bool placed = SetWindowPos(ink, above, 0, 0, 0, 0, 0x0013);
            bool adjacent = placed && GetWindow(ink, 2 /* GW_HWNDNEXT */) == target;
            Console.WriteLine(Json.Serialize(new { placed, adjacent }));
            Console.Out.Flush();
            return placed && adjacent ? 0 : 2;
        } finally { SetThreadDpiAwarenessContext(previous); }
    }
    public sealed class Request { public string ink { get; set; } public string target { get; set; } }
}
'@
    exit ([P0Place]::Run([Console]::ReadLine()))
} catch { [Console]::WriteLine('{"placed":false,"adjacent":false}'); exit 1 }
