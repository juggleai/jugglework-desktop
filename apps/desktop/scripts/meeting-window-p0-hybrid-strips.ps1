# Fixture-only native edge strips around an existing fixture target.
# stdin: one JSON line { target, x, y, width, height, thickness }
# Creates only its own click-through popup windows, prints their handles, then
# holds until stdin EOF and destroys them.
$ErrorActionPreference = 'Stop'
try {
    Add-Type -ReferencedAssemblies System,System.Drawing,System.Web.Extensions -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

public static class P0Strips {
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; public bool Valid { get { return Right > Left && Bottom > Top; } } }
    [StructLayout(LayoutKind.Sequential)] struct Paint { public IntPtr Dc; public int Erase; public Rect Bounds; public int Restore, Update, R0, R1, R2, R3, R4, R5, R6, R7; }
    [StructLayout(LayoutKind.Sequential)] struct Message { public IntPtr Window; public uint Id; public UIntPtr WParam; public IntPtr LParam; public uint Time; public int X, Y; public uint Reserved; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct WindowClass {
        public uint Style; public IntPtr Proc; public int ExtraClass, ExtraWindow;
        public IntPtr Instance, Icon, Cursor, Background; public string Menu, Name;
    }
    delegate IntPtr Procedure(IntPtr wnd, uint msg, IntPtr wp, IntPtr lp);
    static readonly Procedure Proc = Dispatch;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly List<IntPtr> windows = new List<IntPtr>();
    static readonly Dictionary<IntPtr, string> roleOf = new Dictionary<IntPtr, string>();
    static readonly Dictionary<string, int> clickCount = new Dictionary<string, int>();

    static IntPtr Dispatch(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp) {
        if (msg == 0x0201) {
            string role;
            if (roleOf.TryGetValue(hwnd, out role)) {
                clickCount[role] = clickCount[role] + 1;
                Console.WriteLine(Json.Serialize(new { type = "strip-mouse", role, clicks = clickCount[role] }));
                Console.Out.Flush();
            }
            return IntPtr.Zero;
        }
        if (msg != 0x0f) return DefWindowProcW(hwnd, msg, wp, lp);
        Paint paint;
        IntPtr dc = BeginPaint(hwnd, out paint);
        try {
            Rect client;
            if (dc != IntPtr.Zero && GetClientRect(hwnd, out client)) {
                using (var g = Graphics.FromHdc(dc))
                using (var brush = new SolidBrush(Color.FromArgb(0, 200, 200))) g.FillRectangle(brush, 0, 0, client.Right, client.Bottom);
            }
        } finally { if (dc != IntPtr.Zero) EndPaint(hwnd, ref paint); }
        return IntPtr.Zero;
    }

    public static int Run(string input) {
        IntPtr previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (previous == IntPtr.Zero) return 1;
        var stop = new ManualResetEvent(false);
        bool failed = false;
        try {
            var request = Json.Deserialize<Request>(input);
            if (request == null || request.thickness < 1 || request.thickness > 32 || request.width < 16 || request.height < 16)
                throw new ArgumentException("input");
            var reader = new Thread(() => { try { while (Console.ReadLine() != null) {} } catch {} finally { stop.Set(); } });
            reader.IsBackground = true; reader.Start();
            string nonce = Guid.NewGuid().ToString("N");
            var cls = new WindowClass { Proc = Marshal.GetFunctionPointerForDelegate(Proc), Instance = GetModuleHandleW(null), Name = "P0Strip" + nonce };
            if (RegisterClassW(ref cls) == 0) throw new InvalidOperationException("class");
            int t = request.thickness, x = request.x, y = request.y, w = request.width, h = request.height;
            var specs = new[] {
                new { role = "top", x = x, y = y - t, w = w, h = t },
                new { role = "bottom", x = x, y = y + h, w = w, h = t },
                new { role = "left", x = x - t, y = y, w = t, h = h },
                new { role = "right", x = x + w, y = y, w = t, h = h },
            };
            var handles = new Dictionary<string, string>();
            foreach (var spec in specs) {
                IntPtr handle = CreateWindowExW(request.input ? 0x08080080u /* LAYERED|TOOLWINDOW|NOACTIVATE */ : 0x080800A0u /* +TRANSPARENT */, cls.Name, "",
                    0x80000000 /* WS_POPUP */, spec.x, spec.y, spec.w, spec.h, IntPtr.Zero, IntPtr.Zero, cls.Instance, IntPtr.Zero);
                if (handle == IntPtr.Zero) throw new InvalidOperationException("window");
                windows.Add(handle);
                if (!SetLayeredWindowAttributes(handle, 0, 255, 0x00000002 /* LWA_ALPHA */)) throw new InvalidOperationException("layered");
                roleOf[handle] = spec.role;
                clickCount[spec.role] = 0;
                if (!SetWindowPos(handle, IntPtr.Zero, 0, 0, 0, 0, 0x0053 /* SHOWWINDOW|NOMOVE|NOSIZE|NOACTIVATE|top */)) throw new InvalidOperationException("show");
                handles[spec.role] = (IntPtr.Size == 8 ? unchecked((ulong)handle.ToInt64()) : unchecked((uint)handle.ToInt32())).ToString(CultureInfo.InvariantCulture);
            }
            Console.WriteLine(Json.Serialize(new { type = "strips", pid = Process.GetCurrentProcess().Id, handles }));
            Console.Out.Flush();
            var time = Stopwatch.StartNew();
            while (!stop.WaitOne(0) && time.ElapsedMilliseconds < 180000) {
                Message msg;
                for (int i = 0; i < 32 && PeekMessageW(out msg, IntPtr.Zero, 0, 0, 1); i++) {
                    if (msg.Id == 0x12) throw new InvalidOperationException("quit");
                    DispatchMessageW(ref msg);
                }
                stop.WaitOne(15);
            }
            if (!stop.WaitOne(0)) failed = true;
        } catch { failed = true; }
        finally {
            foreach (IntPtr handle in windows) if (!DestroyWindow(handle)) failed = true;
            if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous);
            Console.WriteLine("{\"type\":\"closed\"}");
            Console.Out.Flush();
        }
        return failed ? 1 : 0;
    }

    public sealed class Request { public string target { get; set; } public int x { get; set; } public int y { get; set; } public int width { get; set; } public int height { get; set; } public int thickness { get; set; } public bool input { get; set; } }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] static extern IntPtr GetModuleHandleW(string name);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] static extern ushort RegisterClassW(ref WindowClass cls);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] static extern IntPtr CreateWindowExW(uint ex, string cls, string title, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr data);
    [DllImport("user32.dll", ExactSpelling = true)] static extern IntPtr DefWindowProcW(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern IntPtr BeginPaint(IntPtr hwnd, out Paint paint);
    [DllImport("user32.dll")] static extern bool EndPaint(IntPtr hwnd, ref Paint paint);
    [DllImport("user32.dll", ExactSpelling = true)] static extern bool PeekMessageW(out Message msg, IntPtr hwnd, uint min, uint max, uint remove);
    [DllImport("user32.dll", ExactSpelling = true)] static extern IntPtr DispatchMessageW(ref Message msg);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint colorKey, byte alpha, uint flags);
}
'@
    exit ([P0Strips]::Run([Console]::ReadLine()))
} catch { [Console]::WriteLine('{"type":"error"}'); exit 1 }
