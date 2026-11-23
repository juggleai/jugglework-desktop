# Fixture-only alternate target. No WinForms, external handles, or input commands.
param([int]$MinimizeMs = 0, [int]$ResizeMs = 0, [int]$OccludeMs = 0, [int]$Width = 656, [int]$Height = 439, [switch]$Motion, [switch]$Fixed)
$ErrorActionPreference = 'Stop'
try {
    Add-Type -ReferencedAssemblies System,System.Drawing,System.Web.Extensions -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;

public static class P0HybridTarget {
    [StructLayout(LayoutKind.Sequential)] struct Rect {
        public int Left, Top, Right, Bottom;
        public object Box() { return new { x = Left, y = Top, width = Right - Left, height = Bottom - Top }; }
    }
    [StructLayout(LayoutKind.Sequential)] struct Paint {
        public IntPtr Dc;
        public int Erase;
        public Rect Bounds;
        public int Restore, Update, R0, R1, R2, R3, R4, R5, R6, R7;
    }
    [StructLayout(LayoutKind.Sequential)] struct Message {
        public IntPtr Window;
        public uint Id;
        public UIntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public int X, Y;
        public uint Reserved;
    }
    delegate IntPtr Procedure(IntPtr wnd, uint msg, IntPtr wp, IntPtr lp);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct WindowClass {
        public uint Style;
        public Procedure Proc;
        public int ExtraClass, ExtraWindow;
        public IntPtr Instance, Icon, Cursor, Background;
        public string Menu, Name;
    }
    static readonly Procedure Proc = Dispatch;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static int phase;
    static bool motionMode;
    static bool close, paintFailed;
    static int clicks, drags, occluderClicks, anchorX, anchorY, travel;
    static IntPtr occluderWindow;
    static bool dragging;
    static void Write(object value) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); }

    static IntPtr Dispatch(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp) {
        if (msg == 0x10) { close = true; return IntPtr.Zero; } // close on owning thread in finally
        // Real mouse telemetry only. No synthesis and no other window receives these.
        if (msg == 0x0201) {
            long bits = lp.ToInt64();
            anchorX = unchecked((short)(bits & 0xffff)); anchorY = unchecked((short)((bits >> 16) & 0xffff));
            travel = 0; dragging = true;
            if (hwnd == occluderWindow) occluderClicks++; else clicks++;
            Write(new { type = "mouse", clicks, drags, occluderClicks });
            return IntPtr.Zero;
        }
        if (msg == 0x0200 && dragging) {
            long bits = lp.ToInt64();
            int x = unchecked((short)(bits & 0xffff)), y = unchecked((short)((bits >> 16) & 0xffff));
            travel = Math.Max(travel, Math.Abs(x - anchorX) + Math.Abs(y - anchorY));
            return IntPtr.Zero;
        }
        if (msg == 0x0202) {
            if (dragging && travel > 4) { drags++; Write(new { type = "mouse", clicks, drags, occluderClicks }); }
            dragging = false;
            return IntPtr.Zero;
        }
        if (msg != 0x0f) return DefWindowProcW(hwnd, msg, wp, lp);
        Paint paint;
        IntPtr dc = BeginPaint(hwnd, out paint);
        try {
            Rect client;
            if (dc == IntPtr.Zero || !GetClientRect(hwnd, out client)) throw new InvalidOperationException();
            using (var graphics = Graphics.FromHdc(dc)) {
                int w = client.Right, h = client.Bottom;
                using (var bg = new SolidBrush(hwnd == occluderWindow ? Color.FromArgb(210, 120, 30) : Color.FromArgb(22, 30, 45)))
                    graphics.FillRectangle(bg, 0, 0, w, h);
                graphics.FillEllipse(Brushes.Tomato, 15, 15, 18, 18);
                graphics.FillEllipse(Brushes.Gold, w - 33, 15, 18, 18);
                graphics.FillEllipse(Brushes.LimeGreen, 15, h - 33, 18, 18);
                graphics.FillEllipse(Brushes.DeepSkyBlue, w - 33, h - 33, 18, 18);
                if (motionMode) {
                    using (var band = new SolidBrush(Color.FromArgb(90, 160, 220))) graphics.FillRectangle(band, (phase * (w / 4)) % w, 0, w / 4, h);
                } else {
                    graphics.FillRectangle(Brushes.WhiteSmoke, w / 4 + phase * 8, h / 2, 8, 16);
                }
            }
        } catch { paintFailed = true; }
        finally { if (dc != IntPtr.Zero) EndPaint(hwnd, ref paint); }
        return IntPtr.Zero;
    }

    public static int Run(int minimizeMs, int resizeMs, int occludeMs, int width, int height, bool motion, bool fixedSize) {
        var context = SetThreadDpiAwarenessContext(new IntPtr(-4));
        IntPtr window = IntPtr.Zero, occluder = IntPtr.Zero;
        bool failed = false, minimized = false, resized = false, occluded = false;
        if (context == IntPtr.Zero) return 1;
        try {
            // Only this dedicated, input-free native target process.
            ImmDisableIME(unchecked((uint)-1));
            var stop = new ManualResetEvent(false);
            var reader = new Thread(() => { try { while (Console.ReadLine() != null) {} } catch {} finally { stop.Set(); } });
            reader.IsBackground = true; reader.Start();
            motionMode = motion;
            string nonce = Guid.NewGuid().ToString("N");
            string title = "Meeting Window P0 " + nonce;
            var cls = new WindowClass { Proc = Proc, Instance = GetModuleHandleW(null), Name = "P0HybridNative" + nonce };
            if (RegisterClassW(ref cls) == 0) throw new InvalidOperationException();
            // Overlapped sizable window. SWP_NOACTIVATE when showing; keep the existing Z band.
            window = CreateWindowExW(0, cls.Name, title, fixedSize ? 0x00ca0000u : 0x00cf0000u, 40, 40, width, height,
                IntPtr.Zero, IntPtr.Zero, cls.Instance, IntPtr.Zero);
            if (window == IntPtr.Zero || GetDpiForWindow(window) != 96 || stop.WaitOne(0) ||
                !SetWindowPos(window, IntPtr.Zero, 0, 0, 0, 0, motion ? 0x0053u : 0x0057u) || !IsWindowVisible(window)) throw new InvalidOperationException();
            ulong hwnd = IntPtr.Size == 8 ? unchecked((ulong)window.ToInt64()) : unchecked((uint)window.ToInt32());
            Write(new { type = "identity", hwnd = hwnd.ToString(CultureInfo.InvariantCulture), title });
            var time = Stopwatch.StartNew();
            long lastPaint = -100;
            string lastGeometry = null;
            while (!close && !stop.WaitOne(0) && time.ElapsedMilliseconds < 180000) {
                if (paintFailed) throw new InvalidOperationException();
                Message msg;
                for (int i = 0; i < 64 && PeekMessageW(out msg, IntPtr.Zero, 0, 0, 1); i++) {
                    if (msg.Id == 0x12) throw new InvalidOperationException(); // unexpected WM_QUIT
                    DispatchMessageW(ref msg);
                }
                if (time.ElapsedMilliseconds - lastPaint >= 100) {
                    phase = (phase + 1) % 4;
                    lastPaint = time.ElapsedMilliseconds;
                    InvalidateRect(window, IntPtr.Zero, motionMode);
                    long elapsed = time.ElapsedMilliseconds;
                    if (occludeMs > 0 && !occluded && elapsed >= occludeMs) {
                        occluded = true;
                        Rect anchor;
                        if (!GetWindowRect(window, out anchor)) throw new InvalidOperationException();
                        // A second visible fixture window above the ink: it must
                        // obscure part of the layer without stealing focus.
                        occluder = CreateWindowExW(0, cls.Name, title + " Occluder", 0x90000000,
                            anchor.Left + 180, anchor.Top + 200, 240, 160, IntPtr.Zero, IntPtr.Zero, cls.Instance, IntPtr.Zero);
                        occluderWindow = occluder;
                        if (occluder == IntPtr.Zero || !SetWindowPos(occluder, IntPtr.Zero, 0, 0, 0, 0, 0x0057))
                            throw new InvalidOperationException();
                        Write(new { type = "action", action = "occlude" });
                    }
                    if (occluderWindow != IntPtr.Zero && !SetWindowPos(occluderWindow, IntPtr.Zero, 0, 0, 0, 0, 0x0053))
                        throw new InvalidOperationException();
                    if (resizeMs > 0 && !resized && elapsed >= resizeMs) {
                        resized = true;
                        Rect current;
                        if (!GetWindowRect(window, out current) ||
                            !SetWindowPos(window, IntPtr.Zero, 0, 0, current.Right - current.Left + 48, current.Bottom - current.Top, 0x0016))
                            throw new InvalidOperationException();
                        Write(new { type = "action", action = "resize" });
                    }
                    if (minimizeMs > 0 && !minimized && elapsed >= minimizeMs) {
                        minimized = true;
                        ShowWindowAsync(window, 6 /* SW_MINIMIZE */);
                        Write(new { type = "action", action = "minimize" });
                    }
                    Rect outer, dwm;
                    if (!GetWindowRect(window, out outer) || DwmGetWindowAttribute(window, 9, out dwm, Marshal.SizeOf(typeof(Rect))) != 0)
                        throw new InvalidOperationException();
                    string state = IsIconic(window) ? "minimized" : IsZoomed(window) ? "maximized" : "normal";
                    string geometry = Json.Serialize(new { type = "geometry", visible = IsWindowVisible(window), state,
                        dpi = GetDpiForWindow(window), outerPx = outer.Box(), dwmPx = dwm.Box() });
                    if (geometry != lastGeometry) { Console.WriteLine(geometry); Console.Out.Flush(); lastGeometry = geometry; }
                }
                stop.WaitOne(15);
            }
            if (!close && !stop.WaitOne(0)) failed = true;
        } catch (Exception error) {
            failed = true;
            try { Write(new { type = "target-error", kind = error.GetType().Name }); } catch {}
        }
        finally {
            bool destroyed = window != IntPtr.Zero && DestroyWindow(window);
            bool occluderGone = occluder == IntPtr.Zero || DestroyWindow(occluder);
            if (SetThreadDpiAwarenessContext(context) == IntPtr.Zero || !destroyed || !occluderGone) failed = true;
            if (destroyed) Write(new { type = "closed" });
        }
        return failed ? 1 : 0;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] static extern IntPtr GetModuleHandleW(string name);
    [DllImport("imm32.dll")] static extern bool ImmDisableIME(uint thread);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] static extern ushort RegisterClassW(ref WindowClass cls);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] static extern IntPtr CreateWindowExW(uint ex, string cls, string title, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr data);
    [DllImport("user32.dll", ExactSpelling = true)] static extern IntPtr DefWindowProcW(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hwnd);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, uint attribute, out Rect rect, int size);
    [DllImport("user32.dll")] static extern IntPtr BeginPaint(IntPtr hwnd, out Paint paint);
    [DllImport("user32.dll")] static extern bool EndPaint(IntPtr hwnd, ref Paint paint);
    [DllImport("user32.dll")] static extern bool InvalidateRect(IntPtr hwnd, IntPtr rect, bool erase);
    [DllImport("user32.dll", ExactSpelling = true)] static extern bool PeekMessageW(out Message msg, IntPtr hwnd, uint min, uint max, uint remove);
    [DllImport("user32.dll", ExactSpelling = true)] static extern IntPtr DispatchMessageW(ref Message msg);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr hwnd, int command);
}
'@
    exit ([P0HybridTarget]::Run($MinimizeMs, $ResizeMs, $OccludeMs, $Width, $Height, $Motion.IsPresent, $Fixed.IsPresent))
} catch { exit 1 }
