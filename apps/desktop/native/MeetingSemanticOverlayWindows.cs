// Fixture-only Windows semantic overlay PoC. It is not linked from the product.
// A layered visual HWND and a no-redirection input HWND are committed as one epoch.
using System;
using System.Collections.Concurrent;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class MeetingSemanticOverlayWindows
{
    [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] private struct Msg { public IntPtr Hwnd; public uint Message; public UIntPtr WParam; public IntPtr LParam; public uint Time; public Point Pt; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct WindowClass
    {
        public uint Size, Style; public WindowProc Proc; public int ClassExtra, WindowExtra;
        public IntPtr Instance, Icon, Cursor, Background; public string MenuName, ClassName; public IntPtr SmallIcon;
    }
    [StructLayout(LayoutKind.Sequential)] private struct FileTime { public uint Low, High; }
    [StructLayout(LayoutKind.Sequential)] private struct Size { public int Width, Height; }
    [StructLayout(LayoutKind.Sequential)] private struct BlendFunction { public byte Operation, Flags, SourceAlpha, AlphaFormat; }
    [StructLayout(LayoutKind.Sequential)] private struct BitmapInfoHeader
    { public uint Size; public int Width, Height; public ushort Planes, BitCount; public uint Compression, SizeImage; public int XPelsPerMeter, YPelsPerMeter; public uint ClrUsed, ClrImportant; }
    [StructLayout(LayoutKind.Sequential)] private struct BitmapInfo { public BitmapInfoHeader Header; [MarshalAs(UnmanagedType.ByValArray, SizeConst = 256)] public uint[] Colors; }
    [StructLayout(LayoutKind.Sequential)] private struct D2DPoint { public float X, Y; }
    [StructLayout(LayoutKind.Sequential)] private struct D2DRect { public float Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct D2DEllipse { public D2DPoint Center; public float RadiusX, RadiusY; }
    [StructLayout(LayoutKind.Sequential)] private struct D2DColor { public float R, G, B, A; }
    [StructLayout(LayoutKind.Sequential)] private struct D2DPixelFormat { public int Format, AlphaMode; }
    [StructLayout(LayoutKind.Sequential)] private struct D2DRenderTargetProperties { public int Type; public D2DPixelFormat PixelFormat; public float DpiX, DpiY; public int Usage, MinLevel; }
    [StructLayout(LayoutKind.Sequential)] private struct Input { public uint Type; public MouseInput Mouse; }
    [StructLayout(LayoutKind.Sequential)] private struct MouseInput { public int X, Y; public uint MouseData, Flags, Time; public UIntPtr ExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] private struct PaintStruct
    {
        public IntPtr Dc;
        [MarshalAs(UnmanagedType.Bool)] public bool Erase;
        public Rect Paint;
        [MarshalAs(UnmanagedType.Bool)] public bool Restore;
        [MarshalAs(UnmanagedType.Bool)] public bool IncUpdate;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 32)] public byte[] Reserved;
    }
    private sealed class WindowSnapshot
    {
        public IntPtr Hwnd; public uint Pid, Thread; public Rect Frame; public int ExStyle, Cloaked, RegionType;
        public bool Visible, Minimized, Intersects;
    }
    private sealed class TrustedSnapshot
    {
        public Rect TargetFrame; public uint TargetDpi; public WindowSnapshot[] Above; public IntPtr InsertAfter; public int OccluderCount;
    }
    private sealed class ProbeIdentity
    {
        public string Role, Hwnd, Pid, Started;
    }
    private sealed class ScenePoint { public double X, Y; }
    private sealed class SceneElement
    {
        public string Type, Id, Kind, Color; public double Size, X1, Y1, X2, Y2; public bool Highlight; public List<ScenePoint> Points;
    }
    private sealed class LaserElement { public SceneElement Stroke; public double Opacity; }
    private sealed class OutboundLine { public string Value; public bool Priority; public bool Move; }
    private delegate IntPtr WindowProc(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
    private delegate void WinEventProc(IntPtr hook, uint eventType, IntPtr hwnd, int objectId, int childId, uint eventThread, uint eventTime);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate void D2DBeginDraw(IntPtr target);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate void D2DClear(IntPtr target, ref D2DColor color);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int D2DEndDraw(IntPtr target, out ulong first, out ulong second);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int D2DCreateBrush(IntPtr target, ref D2DColor color, IntPtr properties, out IntPtr brush);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate void D2DDrawLine(IntPtr target, D2DPoint first, D2DPoint second, IntPtr brush, float width, IntPtr style);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate void D2DDrawRectangle(IntPtr target, ref D2DRect rect, IntPtr brush, float width, IntPtr style);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate void D2DDrawEllipse(IntPtr target, ref D2DEllipse ellipse, IntPtr brush, float width, IntPtr style);

    [ComImport, Guid("06152247-6f50-465a-9245-118bfd3b6007"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ID2D1Factory
    {
        int ReloadSystemMetrics(); void GetDesktopDpi(out float x, out float y);
        int CreateRectangleGeometry(IntPtr a, out IntPtr b); int CreateRoundedRectangleGeometry(IntPtr a, out IntPtr b);
        int CreateEllipseGeometry(IntPtr a, out IntPtr b); int CreateGeometryGroup(int a, IntPtr b, uint c, out IntPtr d);
        int CreateTransformedGeometry(IntPtr a, IntPtr b, out IntPtr c); int CreatePathGeometry(out IntPtr a);
        int CreateStrokeStyle(IntPtr a, IntPtr b, uint c, out IntPtr d); int CreateDrawingStateBlock(IntPtr a, IntPtr b, out IntPtr c);
        int CreateWicBitmapRenderTarget(IntPtr a, IntPtr b, out IntPtr c); int CreateHwndRenderTarget(IntPtr a, IntPtr b, out IntPtr c);
        int CreateDxgiSurfaceRenderTarget(IntPtr a, IntPtr b, out IntPtr c);
        [PreserveSig] int CreateDCRenderTarget(ref D2DRenderTargetProperties properties, out ID2D1DCRenderTarget target);
    }

    [ComImport, Guid("1c51bc64-de61-46fd-9899-63a5d8f03950"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ID2D1DCRenderTarget
    {
        void GetFactory(out IntPtr a); int CreateBitmap(IntPtr a, IntPtr b, uint c, IntPtr d, out IntPtr e);
        int CreateBitmapFromWicBitmap(IntPtr a, IntPtr b, out IntPtr c); int CreateSharedBitmap(ref Guid a, IntPtr b, IntPtr c, out IntPtr d);
        int CreateBitmapBrush(IntPtr a, IntPtr b, IntPtr c, out IntPtr d);
        [PreserveSig] int CreateSolidColorBrush(ref D2DColor color, IntPtr properties, out IntPtr brush);
        int CreateGradientStopCollection(IntPtr a, uint b, int c, int d, out IntPtr e); int CreateLinearGradientBrush(IntPtr a, IntPtr b, IntPtr c, out IntPtr d);
        int CreateRadialGradientBrush(IntPtr a, IntPtr b, IntPtr c, out IntPtr d); int CreateCompatibleRenderTarget(IntPtr a, IntPtr b, IntPtr c, int d, out IntPtr e);
        int CreateLayer(IntPtr a, out IntPtr b); int CreateMesh(out IntPtr a);
        void DrawLine(D2DPoint a, D2DPoint b, IntPtr brush, float width, IntPtr style);
        void DrawRectangle(ref D2DRect a, IntPtr b, float c, IntPtr d); void FillRectangle(ref D2DRect a, IntPtr b);
        void DrawRoundedRectangle(IntPtr a, IntPtr b, float c, IntPtr d); void FillRoundedRectangle(IntPtr a, IntPtr b);
        void DrawEllipse(IntPtr a, IntPtr b, float c, IntPtr d); void FillEllipse(IntPtr a, IntPtr b);
        void DrawGeometry(IntPtr a, IntPtr b, float c, IntPtr d); void FillGeometry(IntPtr a, IntPtr b, IntPtr c);
        void FillMesh(IntPtr a, IntPtr b); void FillOpacityMask(IntPtr a, IntPtr b, int c, IntPtr d, IntPtr e);
        void DrawBitmap(IntPtr a, IntPtr b, float c, int d, IntPtr e); void DrawText(IntPtr a, uint b, IntPtr c, IntPtr d, IntPtr e, int f, int g);
        void DrawTextLayout(D2DPoint a, IntPtr b, IntPtr c, int d); void DrawGlyphRun(D2DPoint a, IntPtr b, IntPtr c, int d);
        void SetTransform(IntPtr a); void GetTransform(IntPtr a); void SetAntialiasMode(int a); int GetAntialiasMode();
        void SetTextAntialiasMode(int a); int GetTextAntialiasMode(); void SetTextRenderingParams(IntPtr a); void GetTextRenderingParams(out IntPtr a);
        void SetTags(ulong a, ulong b); void GetTags(out ulong a, out ulong b); void PushLayer(IntPtr a, IntPtr b); void PopLayer();
        [PreserveSig] int Flush(out ulong a, out ulong b); void SaveDrawingState(IntPtr a); void RestoreDrawingState(IntPtr a);
        void PushAxisAlignedClip(ref D2DRect a, int b); void PopAxisAlignedClip(); void Clear(ref D2DColor color);
        void BeginDraw(); [PreserveSig] int EndDraw(out ulong a, out ulong b); D2DPixelFormat GetPixelFormat(); void SetDpi(float a, float b);
        void GetDpi(out float a, out float b); long GetSize(); ulong GetPixelSize(); uint GetMaximumBitmapSize(); bool IsSupported(IntPtr a);
        [PreserveSig] int BindDC(IntPtr dc, ref Rect rect);
    }

    private const uint WS_POPUP = 0x80000000, WS_OVERLAPPEDWINDOW = 0x00CF0000;
    private const uint WS_EX_LAYERED = 0x00080000, WS_EX_TOOLWINDOW = 0x00000080, WS_EX_NOREDIRECTIONBITMAP = 0x00200000;
    private const uint WS_EX_NOACTIVATE = 0x08000000, WS_EX_TRANSPARENT = 0x00000020, WS_EX_TOPMOST = 0x00000008;
    private const uint SWP_NOSIZE = 1, SWP_NOMOVE = 2, SWP_NOZORDER = 4, SWP_NOACTIVATE = 0x10, SWP_SHOWWINDOW = 0x40;
    private const int GWL_EXSTYLE = -20, GW_HWNDNEXT = 2, GW_HWNDPREV = 3, GA_ROOT = 2;
    private const int WM_PAINT = 0x000F, WM_NCHITTEST = 0x0084, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202, WM_MOUSEMOVE = 0x0200, WM_DPICHANGED = 0x02E0;
    private const int WM_CAPTURECHANGED = 0x0215, WM_CANCELMODE = 0x001F, WM_CLOSE = 0x0010, WM_DESTROY = 0x0002, WM_QUIT = 0x0012;
    private const int HTCLIENT = 1, HTTRANSPARENT = -1, DWMWA_EXTENDED_FRAME_BOUNDS = 9, DWMWA_CLOAKED = 14;
    private const int RGN_DIFF = 4, ERROR = 0, ERROR_SUCCESS = 0;
    private const uint EVENT_OBJECT_DESTROY = 0x8001, WINEVENT_OUTOFCONTEXT = 0, OBJID_WINDOW = 0;
    private static readonly IntPtr HWND_TOP = IntPtr.Zero;
    private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1), HWND_NOTOPMOST = new IntPtr(-2);
    private static WindowProc callback = Dispatch;
    private static string role = "none", mode = "pointer", state = "starting";
    private static IntPtr window, visualWindow, inputWindow, target, targetProcess;
    private static uint targetPid, targetThread;
    private static ulong targetStarted;
    private static Rect baseline, current, resizeCandidate;
    private static int clicks, strokes, epoch, occluders, resizeCandidateSamples;
    private static uint currentDpi;
    private static bool inputEnabled, visible, terminalResize, lastTargetForeground, cleanupOk = true, shutdownRequested, recreating;
    private static int targetDestroyed;
    private static IntPtr destroyHook;
    private static WinEventProc destroyCallback = OnWinEvent;
    private static ConcurrentQueue<string> overlayQueue;
    private static string raceKind;
    private static string refreshFailure = "unknown";
    private static string simpleClassName, simpleKind;
    private static int[] simpleBox;
    private static bool protocolMode;
    private static string protocolSession;
    private static long protocolSeq;
    private static IntPtr parentProcess;
    private static readonly List<SceneElement> scene = new List<SceneElement>();
    private static readonly List<LaserElement> lasers = new List<LaserElement>();
    private static readonly HashSet<string> previewHiddenIds = new HashSet<string>(StringComparer.Ordinal);
    private static long previewRevision;
    private static long laserRevision;
    private static int previewEpoch = -1;
    private static List<ScenePoint> inputStroke;
    private static long inputSeq;
    private static bool protocolReady;
    private static long eventSeq;
    private static int announcedEpoch = -1;
    private static string announcedState;
    private static readonly object outputLock = new object();
    private static readonly Queue<OutboundLine> outputQueue = new Queue<OutboundLine>();
    private static readonly AutoResetEvent outputSignal = new AutoResetEvent(false);
    private static Thread outputThread;
    private static bool outputStopping, outputFailed, pointerBackpressure, pointerBackpressureLatched;
    private static ID2D1Factory d2dFactory;
    private static ID2D1DCRenderTarget d2dTarget;
    private static IntPtr d2dTargetPointer;
    private static IntPtr visualDc, visualBitmap, visualOldBitmap, visualBits;
    private static int visualWidth, visualHeight;
    private static bool injectDeviceLoss;
    private static bool deviceLossBlocked;
    private static bool fixtureInjection;
    private static uint fixtureTargetDpi;
    private static readonly List<ScenePoint> pendingMovePoints = new List<ScenePoint>();
    private static string draftColor = "#ef4444";
    private static double draftSize = 4;
    private static bool draftHighlight;
    private static string draftTool = "pen";
    private const int MaxOutputQueue = 256, ReservedPriorityOutput = 64;
    private const string EndOfInput = "\u0001eof", OversizedInput = "\u0001oversized";
    private const int ProtocolVersion = 1, MaxProtocolLine = 65536, MaxElements = 128, MaxLasers = 32, MaxPointsPerStroke = 256, MaxSceneComplexity = 4096;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = MaxProtocolLine, RecursionLimit = 8 };

    private static int Main(string[] args)
    {
        if (Environment.OSVersion.Platform != PlatformID.Win32NT || args.Length == 0) return 1;
        if (SetProcessDpiAwarenessContext(new IntPtr(-4)) == false) return 1;
        try
        {
            if (args[0] == "layout" && args.Length == 1)
            {
                Print("{\"type\":\"layout\",\"pointer\":" + IntPtr.Size + ",\"paintStruct\":" + Marshal.SizeOf(typeof(PaintStruct)) +
                    ",\"input\":" + Marshal.SizeOf(typeof(Input)) + "}");
                return IntPtr.Size == 8 && Marshal.SizeOf(typeof(PaintStruct)) == 72 && Marshal.SizeOf(typeof(Input)) == 40 ? 0 : 1;
            }
            if (args[0] == "target" && args.Length == 5) return RunSimple("target", "plain", Parse(args, 1, 4), IntPtr.Zero);
            if (args[0] == "target-system" && args.Length == 5) return RunSimpleAware("target", "plain", Parse(args, 1, 4), IntPtr.Zero, new IntPtr(-2));
            if (args[0] == "target-unaware" && args.Length == 5) return RunSimpleAware("target", "plain", Parse(args, 1, 4), IntPtr.Zero, new IntPtr(-1));
            if (args[0] == "occluder" && args.Length == 5) return RunSimple("occluder", "plain", Parse(args, 1, 4), IntPtr.Zero);
            if (args[0].StartsWith("occluder-", StringComparison.Ordinal) && args.Length == 8)
            {
                IntPtr owner, process; uint pid, thread; ulong started;
                if (!TryIdentity(args[5], args[6], args[7], out owner, out pid, out started, out thread, out process)) return 1;
                CloseHandle(process);
                return RunSimple("occluder", args[0].Substring(9), Parse(args, 1, 4), owner);
            }
            if (args[0] == "overlay" && args.Length == 7) return RunOverlay(args, true);
            if (args[0] == "overlay-fixture" && (args.Length == 4 || args.Length == 5)) return RunOverlay(args, false);
            if (args[0] == "process-fixture" && args.Length == 2) return RunProcessFixture(args[1]);
            if (args[0] == "pixel" && args.Length == 3) return RunPixel(args);
            if (args[0] == "resources" && args.Length == 2) return RunResources(args[1]);
            if (args[0] == "frame" && args.Length == 4) return RunFrame(args);
            if (args[0] == "probe" && (args.Length == 8 || args.Length == 9 || args.Length == 12 || args.Length == 13 || args.Length == 16 || args.Length == 17)) return RunProbe(args);
            if (args[0] == "gone" && args.Length == 4) return RunGone(args);
            return 1;
        }
        catch { return 1; }
    }

    private static int[] Parse(string[] args, int offset, int count)
    {
        var values = new int[count];
        for (int i = 0; i < count; i++) if (!int.TryParse(args[offset + i], NumberStyles.Integer, CultureInfo.InvariantCulture, out values[i])) throw new ArgumentException();
        if (values[2] <= 0 || values[3] <= 0) throw new ArgumentException();
        return values;
    }

    private static ushort Register(string name)
    {
        var cls = new WindowClass { Size = (uint)Marshal.SizeOf(typeof(WindowClass)), Proc = callback, Instance = GetModuleHandleW(null),
            Cursor = LoadCursorW(IntPtr.Zero, new IntPtr(32512)), Background = new IntPtr(6), ClassName = name };
        return RegisterClassExW(ref cls);
    }

    private static int RunSimple(string simpleRole, string kind, int[] box, IntPtr owner)
    {
        role = simpleRole;
        string name = "MeetingSemanticFixture" + Guid.NewGuid().ToString("N");
        simpleClassName = name; simpleKind = kind; simpleBox = box;
        if (Register(name) == 0) return 1;
        uint ex = WS_EX_TOOLWINDOW;
        if (kind == "layered") ex |= WS_EX_LAYERED;
        if (kind == "topmost") ex |= WS_EX_TOPMOST;
        uint style = simpleRole == "target" ? WS_OVERLAPPEDWINDOW : WS_POPUP;
        window = CreateWindowExW(ex, name, "", style, box[0], box[1], box[2], box[3], owner, IntPtr.Zero, GetModuleHandleW(null), IntPtr.Zero);
        IntPtr insertAfter = kind == "topmost" ? new IntPtr(-1) : HWND_TOP;
        uint positionFlags = SWP_SHOWWINDOW | (simpleRole == "target" ? SWP_NOACTIVATE : 0);
        if (window == IntPtr.Zero || !SetWindowPos(window, insertAfter, box[0], box[1], box[2], box[3], positionFlags)) return 1;
        if (kind == "layered" && !SetLayeredWindowAttributes(window, 0, 220, 2)) return SimpleStartupFailure(kind);
        if (kind == "region")
        {
            IntPtr custom = CreateEllipticRgn(0, 0, box[2], box[3]);
            if (custom == IntPtr.Zero || SetWindowRgn(window, custom, true) == 0) { if (custom != IntPtr.Zero) DeleteObject(custom); return SimpleStartupFailure(kind); }
        }
        if (kind == "cloaked")
        {
            int cloak = 1, observed;
            if (DwmSetWindowAttribute(window, 13 /* DWMWA_CLOAK */, ref cloak, 4) != 0 ||
                DwmGetWindowAttributeInt(window, DWMWA_CLOAKED, out observed, 4) != 0 || observed == 0)
                return SimpleUnsupported(kind);
        }
        if (kind != "plain" && kind != "topmost" && kind != "layered" && kind != "region" && kind != "cloaked") return SimpleStartupFailure("invalid");
        PrintReady(simpleRole, window);
        var queue = StartReader();
        bool done = false;
        var clock = Stopwatch.StartNew();
        while (!done && !shutdownRequested && clock.ElapsedMilliseconds < 45000)
        {
            Pump(); string command;
            while (queue.TryDequeue(out command))
            {
                bool ok = true;
                if (command == "exit") done = true;
                else if (command == "close") { ok = DestroyWindow(window); if (ok) window = IntPtr.Zero; done = true; }
                else if (command == "move" && role == "target") { box[0] += 40; box[1] += 30; ok = SetWindowPos(window, HWND_TOP, box[0], box[1], box[2], box[3], SWP_NOACTIVATE); }
                else if (command == "move-any") { box[0] += 31; box[1] += 23; ok = SetWindowPos(window, HWND_TOP, box[0], box[1], box[2], box[3], SWP_NOACTIVATE); }
                else if (command == "resize" && role == "target") { box[2] += 48; ok = SetWindowPos(window, HWND_TOP, box[0], box[1], box[2], box[3], SWP_NOACTIVATE); }
                else if (command == "minimize" && role == "target") ok = ShowWindow(window, 6);
                else if (command == "restore" && role == "target") { ShowWindow(window, 9 /* SW_RESTORE */); ok = !IsIconic(window); }
                else if (command == "elevate" && role == "occluder") ok = SetWindowPos(window, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                else if (command == "lower" && role == "occluder") ok = SetWindowPos(window, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                else if (command == "recreate" && role == "target")
                {
                    recreating = true; ok = DestroyWindow(window); window = IntPtr.Zero; Pump(); recreating = false;
                    if (ok)
                    {
                        window = CreateWindowExW(WS_EX_TOOLWINDOW, simpleClassName, "", WS_OVERLAPPEDWINDOW, box[0], box[1], box[2], box[3], IntPtr.Zero, IntPtr.Zero, GetModuleHandleW(null), IntPtr.Zero);
                        ok = window != IntPtr.Zero && SetWindowPos(window, HWND_TOP, box[0], box[1], box[2], box[3], SWP_SHOWWINDOW | SWP_NOACTIVATE);
                        if (ok) PrintReady(role, window);
                    }
                }
                else if (command == "query") Print("{\"type\":\"counts\",\"role\":\"" + role + "\",\"clicks\":" + clicks + ",\"active\":" + Bool(GetForegroundWindow() == window) + "}");
                else if (command == "crash") Environment.FailFast("fixture-requested");
                else ok = false;
                Print("{\"type\":\"ack\",\"action\":\"" + SafeCommand(command) + "\",\"ok\":" + Bool(ok) + "}");
            }
            Thread.Sleep(5);
        }
        if (window != IntPtr.Zero) cleanupOk = DestroyWindow(window);
        window = IntPtr.Zero;
        Print("{\"type\":\"cleanup\",\"role\":\"" + role + "\",\"destroyed\":" + Bool(cleanupOk) + "}");
        return (done || shutdownRequested) && cleanupOk ? 0 : 1;
    }

    private static int RunSimpleAware(string simpleRole, string kind, int[] box, IntPtr owner, IntPtr awareness)
    {
        IntPtr previous = SetThreadDpiAwarenessContext(awareness);
        if (previous == IntPtr.Zero) return 1;
        try { return RunSimple(simpleRole, kind, box, owner); }
        finally { SetThreadDpiAwarenessContext(previous); }
    }

    private static int SimpleStartupFailure(string reason)
    {
        bool destroyed = window == IntPtr.Zero || DestroyWindow(window); window = IntPtr.Zero;
        Print("{\"type\":\"startup-refused\",\"role\":\"" + role + "\",\"reason\":\"" + reason + "\"}");
        Print("{\"type\":\"cleanup\",\"role\":\"" + role + "\",\"destroyed\":" + Bool(destroyed) + "}");
        return 1;
    }

    private static int SimpleUnsupported(string reason)
    {
        bool destroyed = window == IntPtr.Zero || DestroyWindow(window); window = IntPtr.Zero;
        Print("{\"type\":\"unsupported\",\"role\":\"" + role + "\",\"reason\":\"" + reason + "\"}");
        Print("{\"type\":\"cleanup\",\"role\":\"" + role + "\",\"destroyed\":" + Bool(destroyed) + "}");
        return destroyed ? 2 : 1;
    }

    private static int RunOverlay(string[] args, bool useProtocol)
    {
        role = "overlay";
        if (!TryIdentity(args[1], args[2], args[3], out target, out targetPid, out targetStarted, out targetThread, out targetProcess)) return 1;
        protocolMode = useProtocol;
        fixtureInjection = String.Equals(Environment.GetEnvironmentVariable("MEETING_SEMANTIC_OVERLAY_FIXTURE_INJECTION"), "1", StringComparison.Ordinal);
        if (fixtureInjection) uint.TryParse(Environment.GetEnvironmentVariable("MEETING_SEMANTIC_OVERLAY_FIXTURE_TARGET_DPI"), out fixtureTargetDpi);
        if (protocolMode)
        {
            uint parentPid; ulong parentStarted;
            if (!uint.TryParse(args[4], out parentPid) || parentPid == 0 || !ulong.TryParse(args[5], out parentStarted) || parentStarted == 0 ||
                !ValidSession(args[6]) || !TryProcessIdentity(parentPid, parentStarted, out parentProcess)) return OverlayStartupFailure("parent");
            protocolSession = args[6];
        }
        string name = "MeetingSemanticOverlay" + Guid.NewGuid().ToString("N");
        string inputName = name + "Input";
        if (Register(name) == 0 || Register(inputName) == 0 || !InstallDestroyLatch() || !ReadTrustedTarget(out baseline, out state)) return OverlayStartupFailure("identity");
        current = baseline; currentDpi = TargetDpi();
        if (currentDpi != 96) return OverlayStartupFailure(currentDpi == 0 ? "target-dpi" : "unsupported-dpi");
        visualWindow = CreateWindowExW(WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT, name, "", WS_POPUP,
            baseline.Left, baseline.Top, Width(baseline), Height(baseline), IntPtr.Zero, IntPtr.Zero, GetModuleHandleW(null), IntPtr.Zero);
        inputWindow = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_NOREDIRECTIONBITMAP, inputName, "", WS_POPUP,
            baseline.Left, baseline.Top, Width(baseline), Height(baseline), IntPtr.Zero, IntPtr.Zero, GetModuleHandleW(null), IntPtr.Zero);
        window = inputWindow;
        if (visualWindow == IntPtr.Zero || inputWindow == IntPtr.Zero || !InitializeVisualSurface(Width(baseline), Height(baseline))) return OverlayStartupFailure("window");
        DisableInputAndHide();
        var startup = Stopwatch.StartNew(); bool started = false;
        while (!started && startup.ElapsedMilliseconds < 2000 && Volatile.Read(ref targetDestroyed) == 0) { started = Refresh(true); if (!started) Thread.Sleep(20); }
        if (!started) return OverlayStartupFailure("snapshot-" + refreshFailure);
        if (protocolMode) { StartProtocolWriter(); protocolReady = true; PrintProtocol(new Dictionary<string, object> { { "type", "hello" }, { "version", ProtocolVersion },
            { "sessionId", protocolSession }, { "epoch", epoch }, { "capabilities", new object[] { "mode", "scene", "preview", "lasers", "pointer", "state", "abort", "close" } } }); announcedEpoch = epoch; announcedState = state; }
        else
        {
            PrintReady(role, inputWindow);
            Print("{\"type\":\"fixture-layers\",\"visualHwnd\":\"" + HwndText(visualWindow) + "\",\"inputHwnd\":\"" + HwndText(inputWindow) + "\"}");
        }
        var queue = StartReader(); overlayQueue = queue; bool done = false; long nextRefresh = 0; var clock = Stopwatch.StartNew();
        long fixtureLifetime = protocolMode ? Int64.MaxValue : ParseFixtureLifetime(args);
        while (!done && clock.ElapsedMilliseconds < fixtureLifetime)
        {
            if (protocolMode && parentProcess != IntPtr.Zero && WaitForSingleObject(parentProcess, 0) == 0) { shutdownRequested = true; state = "closed"; }
            Pump(); FlushPointerMoves(); if (pointerBackpressure) { pointerBackpressure = false; pointerBackpressureLatched = true; DisableInputAndHide(); state = "unknown"; }
            string command;
            while (queue.TryDequeue(out command))
            {
                if (protocolMode) { if (command == EndOfInput) { shutdownRequested = true; state = "closed"; break; }
                    if (fixtureInjection && command == "fixture-device-loss") { injectDeviceLoss = true; deviceLossBlocked = true; RevokeAndHide(); if (Refresh(true)) deviceLossBlocked = false; continue; }
                    if (fixtureInjection && command == "fixture-device-recover") { deviceLossBlocked = false; Refresh(true); continue; }
                    if (fixtureInjection && command == "fixture-dpi-change") { TerminalUnsupportedDpi(); continue; }
                    ProcessProtocolCommand(command, ref done); continue; }
                bool ok = true;
                if (command == "exit") done = true;
                else if (command == "pointer" || command == "draw") { mode = command; DisableInputAndHide(); ok = Refresh(true); }
                else if (command == "refresh") { DisableInputAndHide(); ok = Refresh(true); }
                else if (command == "race-target" || command == "race-occluder") { raceKind = command.Substring(5); ok = Refresh(true); }
                else if (command == "race-commit") ok = false;
                else if (command == "device-loss") { injectDeviceLoss = true; RevokeAndHide(); ok = Refresh(true); }
                else if (command == "query") PrintState();
                else if (command == "crash") Environment.FailFast("fixture-requested");
                else ok = false;
                Print("{\"type\":\"ack\",\"action\":\"" + SafeCommand(command) + "\",\"ok\":" + Bool(ok) + "}");
            }
            if (clock.ElapsedMilliseconds >= nextRefresh) { if (!pointerBackpressureLatched) Refresh(false); nextRefresh = clock.ElapsedMilliseconds + 50; }
            EmitStateEventIfChanged();
            if (state == "closed" || shutdownRequested) done = true;
            Thread.Sleep(5);
        }
        DisableInputAndHide();
        ReleaseVisualSurface();
        if (inputWindow != IntPtr.Zero) cleanupOk = DestroyWindow(inputWindow) && cleanupOk;
        inputWindow = window = IntPtr.Zero;
        if (visualWindow != IntPtr.Zero) cleanupOk = DestroyWindow(visualWindow) && cleanupOk;
        visualWindow = IntPtr.Zero;
        if (targetProcess != IntPtr.Zero) CloseHandle(targetProcess);
        if (parentProcess != IntPtr.Zero) { CloseHandle(parentProcess); parentProcess = IntPtr.Zero; }
        if (destroyHook != IntPtr.Zero) { UnhookWinEvent(destroyHook); destroyHook = IntPtr.Zero; }
        if (protocolMode) StopProtocolWriter();
        if (!protocolMode) Print("{\"type\":\"cleanup\",\"role\":\"overlay\",\"destroyed\":" + Bool(cleanupOk) + "}");
        return (done || state == "closed") && cleanupOk ? 0 : 1;
    }

    private static void ProcessProtocolCommand(string line, ref bool done)
    {
        if (line == OversizedInput) { ProtocolError(null, "line-too-large"); return; }
        if (Encoding.UTF8.GetByteCount(line) > MaxProtocolLine) { ProtocolError(null, "line-too-large"); return; }
        Dictionary<string, object> value;
        try { value = Json.Deserialize<Dictionary<string, object>>(line); }
        catch { ProtocolError(null, "invalid-json"); return; }
        if (value == null || !ValidEnvelope(value)) { ProtocolError(ReadSeq(value), "invalid-envelope"); return; }
        long seq = Convert.ToInt64(value["seq"], CultureInfo.InvariantCulture);
        int expected = Convert.ToInt32(value["expectedEpoch"], CultureInfo.InvariantCulture);
        if (!String.Equals((string)value["sessionId"], protocolSession, StringComparison.Ordinal)) { ProtocolError(seq, "wrong-session"); return; }
        if (seq <= protocolSeq) { ProtocolError(seq, "stale-seq"); return; }
        if (expected != epoch) { ProtocolError(seq, "wrong-epoch"); return; }
        string command = (string)value["command"];
        bool accepted = false;
        if (command == "state" && ExactKeys(value, "version", "sessionId", "seq", "expectedEpoch", "command"))
        {
            protocolSeq = seq; PrintProtocolState(seq); return;
        }
        if (command == "close" && ExactKeys(value, "version", "sessionId", "seq", "expectedEpoch", "command"))
        {
            accepted = true; done = true;
        }
        else if (command == "mode")
        {
            ClearPreview(); ClearLasers();
            string next = value["mode"] as string;
            if (next == "pointer" && ExactKeys(value, "version", "sessionId", "seq", "expectedEpoch", "command", "mode"))
            { mode = next; DisableInputAndHide(); pointerBackpressureLatched = false; accepted = Refresh(true); }
            else if (next == "draw" && ExactKeys(value, "version", "sessionId", "seq", "expectedEpoch", "command", "mode", "tool", "color", "size", "highlight") &&
                ValidDrawTool(value["tool"] as string) && value["color"] is string && System.Text.RegularExpressions.Regex.IsMatch((string)value["color"], "^#[0-9a-fA-F]{6}$") && value["highlight"] is bool &&
                (bool)value["highlight"] == String.Equals(value["tool"] as string, "highlighter", StringComparison.Ordinal))
            {
                double size; if (TryFiniteDouble(value["size"], out size) && size > 0 && size <= 32) {
                    draftTool = (string)value["tool"]; draftColor = (string)value["color"]; draftSize = size; draftHighlight = (bool)value["highlight"];
                    mode = next; DisableInputAndHide(); pointerBackpressureLatched = false; accepted = Refresh(true);
                }
            }
        }
        else if (command == "scene") accepted = TryScene(value);
        else if (command == "preview") accepted = TryPreview(value);
        else if (command == "lasers")
        {
            string error; accepted = TryLasers(value, out error);
            if (!accepted && error != null) { ProtocolError(seq, error); return; }
        }
        else if (command == "abort" && ExactKeys(value, "version", "sessionId", "seq", "expectedEpoch", "command")) { CancelInputStroke(); ClearPreview(); ClearLasers(); accepted = RenderVisual(); }
        if (!accepted) { ProtocolError(seq, "invalid-command"); return; }
        protocolSeq = seq;
        PrintProtocol(new Dictionary<string, object> { { "type", "ack" }, { "version", ProtocolVersion }, { "sessionId", protocolSession },
            { "seq", seq }, { "epoch", epoch }, { "command", command } });
    }

    private static bool TryScene(Dictionary<string, object> value)
    {
        if (!ExactKeys(value, "version", "sessionId", "seq", "expectedEpoch", "command", "elements")) return false;
        IList values = value["elements"] as IList;
        if (values == null || values.Count > MaxElements) return false;
        var next = new List<SceneElement>(values.Count); var ids = new HashSet<string>(StringComparer.Ordinal); int total = 0;
        foreach (object item in values)
        {
            Dictionary<string, object> source = item as Dictionary<string, object>;
            if (source == null || !(source.ContainsKey("type") && source["type"] is string) || !(source.ContainsKey("id") && source["id"] is string) ||
                !ValidId((string)source["id"]) || !ids.Add((string)source["id"]) || !(source.ContainsKey("color") && source["color"] is string) ||
                !System.Text.RegularExpressions.Regex.IsMatch((string)source["color"], "^#[0-9a-fA-F]{6}$") || !source.ContainsKey("size")) return false;
            double size; if (!TryFiniteDouble(source["size"], out size) || size <= 0 || size > 32) return false;
            if (String.Equals((string)source["type"], "stroke", StringComparison.Ordinal))
            {
                if (!ExactKeys(source, "type", "id", "color", "size", "highlight", "points") || !(source["highlight"] is bool)) return false;
                IList points = source["points"] as IList;
                if (points == null || points.Count < 2 || points.Count > MaxPointsPerStroke || total + points.Count > MaxSceneComplexity) return false;
                var parsed = new List<ScenePoint>(points.Count);
                foreach (object point in points)
                {
                    IList pair = point as IList; double x, y;
                    if (pair == null || pair.Count != 2 || !TryNormalized(pair[0], out x) || !TryNormalized(pair[1], out y)) return false;
                    parsed.Add(new ScenePoint { X = x, Y = y });
                }
                total += points.Count;
                next.Add(new SceneElement { Type = "stroke", Id = (string)source["id"], Color = (string)source["color"], Size = size,
                    Highlight = (bool)source["highlight"], Points = parsed });
            }
            else if (String.Equals((string)source["type"], "shape", StringComparison.Ordinal))
            {
                if (!ExactKeys(source, "type", "id", "kind", "color", "size", "x1", "y1", "x2", "y2") || !ValidShape(source["kind"] as string)) return false;
                double x1, y1, x2, y2;
                if (!TryNormalized(source["x1"], out x1) || !TryNormalized(source["y1"], out y1) || !TryNormalized(source["x2"], out x2) || !TryNormalized(source["y2"], out y2) || total + 2 > MaxSceneComplexity) return false;
                total += 2;
                next.Add(new SceneElement { Type = "shape", Id = (string)source["id"], Kind = (string)source["kind"], Color = (string)source["color"], Size = size,
                    X1 = x1, Y1 = y1, X2 = x2, Y2 = y2 });
            }
            else return false;
        }
        scene.Clear(); scene.AddRange(next); strokes = scene.Count;
        ClearPreview();
        if (state == "active" && !RenderVisual()) { RevokeAndHide(); state = "unknown"; return false; }
        return true;
    }

    private static bool TryPreview(Dictionary<string, object> value)
    {
        if (!ExactKeys(value, "version", "sessionId", "seq", "expectedEpoch", "command", "previewRevision", "epoch", "hiddenElementIds")) return false;
        long revision; int requestedEpoch;
        if (!TryLong(value["previewRevision"], out revision) || !TryInt(value["epoch"], out requestedEpoch) || requestedEpoch != epoch || revision <= previewRevision) return false;
        IList values = value["hiddenElementIds"] as IList;
        if (values == null || values.Count > MaxElements) return false;
        var next = new HashSet<string>(StringComparer.Ordinal);
        var retained = new HashSet<string>(StringComparer.Ordinal);
        foreach (SceneElement element in scene) retained.Add(element.Id);
        foreach (object item in values) if (!(item is string) || !ValidId((string)item) || !retained.Contains((string)item) || !next.Add((string)item)) return false;
        previewHiddenIds.Clear(); foreach (string id in next) previewHiddenIds.Add(id);
        previewRevision = revision; previewEpoch = requestedEpoch;
        return state != "active" || RenderVisual();
    }

    private static bool TryLasers(Dictionary<string, object> value, out string error)
    {
        error = null;
        if (!ExactKeys(value, "version", "sessionId", "seq", "expectedEpoch", "command", "laserRevision", "epoch", "lasers")) return false;
        long revision; int requestedEpoch;
        if (!TryLong(value["laserRevision"], out revision) || revision <= laserRevision) { error = "stale-laser-revision"; return false; }
        if (!TryInt(value["epoch"], out requestedEpoch) || requestedEpoch != epoch) { error = "wrong-epoch"; return false; }
        IList values = value["lasers"] as IList;
        if (values == null || values.Count > MaxLasers) return false;
        var next = new List<LaserElement>(values.Count); var ids = new HashSet<string>(StringComparer.Ordinal); int total = 0;
        foreach (object item in values)
        {
            Dictionary<string, object> source = item as Dictionary<string, object>;
            if (source == null || !ExactKeys(source, "stroke", "opacity")) return false;
            double opacity; if (!TryFiniteDouble(source["opacity"], out opacity) || opacity < 0 || opacity > 1) return false;
            Dictionary<string, object> stroke = source["stroke"] as Dictionary<string, object>;
            if (stroke == null || !ExactKeys(stroke, "id", "color", "size", "highlight", "points") || !(stroke["id"] is string) ||
                !ValidId((string)stroke["id"]) || !ids.Add((string)stroke["id"]) || !(stroke["color"] is string) ||
                !System.Text.RegularExpressions.Regex.IsMatch((string)stroke["color"], "^#[0-9a-fA-F]{6}$") || !(stroke["highlight"] is bool) || (bool)stroke["highlight"]) return false;
            double size; if (!TryFiniteDouble(stroke["size"], out size) || size <= 0 || size > 32) return false;
            IList points = stroke["points"] as IList;
            if (points == null || points.Count < 1 || points.Count > MaxPointsPerStroke || total + points.Count > MaxSceneComplexity) return false;
            var parsed = new List<ScenePoint>(points.Count);
            foreach (object point in points)
            {
                IList pair = point as IList; double x, y;
                if (pair == null || pair.Count != 2 || !TryNormalized(pair[0], out x) || !TryNormalized(pair[1], out y)) return false;
                parsed.Add(new ScenePoint { X = x, Y = y });
            }
            total += points.Count;
            next.Add(new LaserElement { Opacity = opacity, Stroke = new SceneElement { Type = "stroke", Id = (string)stroke["id"], Color = (string)stroke["color"], Size = size, Highlight = false, Points = parsed } });
        }
        lasers.Clear(); lasers.AddRange(next); laserRevision = revision;
        if (state == "active" && !RenderVisual()) { ClearLasers(); RevokeAndHide(); state = "unknown"; return false; }
        return true;
    }

    private static void ClearPreview() { previewHiddenIds.Clear(); previewEpoch = -1; }
    private static void ClearLasers() { lasers.Clear(); }

    private static bool ValidEnvelope(Dictionary<string, object> value)
    {
        long seq; int expected;
        return value.ContainsKey("version") && value["version"] is int && (int)value["version"] == ProtocolVersion &&
            value.ContainsKey("sessionId") && value["sessionId"] is string && value.ContainsKey("command") && value["command"] is string &&
            value.ContainsKey("seq") && TryLong(value["seq"], out seq) && value.ContainsKey("expectedEpoch") && TryInt(value["expectedEpoch"], out expected);
    }
    private static bool ExactKeys(Dictionary<string, object> value, params string[] keys)
    { if (value.Count != keys.Length) return false; foreach (string key in keys) if (!value.ContainsKey(key)) return false; return true; }
    private static long? ReadSeq(Dictionary<string, object> value) { long parsed; return value != null && value.ContainsKey("seq") && TryLong(value["seq"], out parsed) ? (long?)parsed : null; }
    private static bool TryLong(object value, out long parsed) { parsed = 0; return value is int ? (parsed = (int)value) > 0 : value is long && (parsed = (long)value) > 0; }
    private static bool TryInt(object value, out int parsed) { parsed = 0; return value is int && (parsed = (int)value) >= 0; }
    private static bool TryFiniteDouble(object value, out double parsed)
    { parsed = 0; if (!(value is int || value is long || value is decimal || value is double)) return false; try { parsed = Convert.ToDouble(value, CultureInfo.InvariantCulture); } catch { return false; } return !Double.IsNaN(parsed) && !Double.IsInfinity(parsed); }
    private static bool TryNormalized(object value, out double parsed) { return TryFiniteDouble(value, out parsed) && parsed >= 0 && parsed <= 1; }
    private static bool ValidId(string value) { return value != null && value.Length >= 1 && value.Length <= 128 && System.Text.RegularExpressions.Regex.IsMatch(value, "^[A-Za-z0-9_-]+$"); }
    private static bool ValidShape(string value) { return value == "rectangle" || value == "ellipse" || value == "arrow"; }
    private static bool ValidDrawTool(string value) { return value == "laser" || value == "pen" || value == "highlighter" || value == "eraser" || ValidShape(value); }
    private static int ScenePointCount() { int count = 0; foreach (SceneElement element in scene) count += element.Type == "stroke" ? element.Points.Count : 2; return count; }
    private static bool ValidSession(string value) { return value != null && value.Length >= 16 && value.Length <= 64 && System.Text.RegularExpressions.Regex.IsMatch(value, "^[A-Za-z0-9_-]+$"); }
    private static void ProtocolError(long? seq, string code) { PrintProtocol(new Dictionary<string, object> { { "type", "error" }, { "version", ProtocolVersion },
        { "sessionId", protocolSession }, { "seq", seq.HasValue ? (object)seq.Value : null }, { "epoch", epoch }, { "code", code } }); }
    private static void PrintProtocolState(long seq) { PrintProtocol(new Dictionary<string, object> { { "type", "state" }, { "version", ProtocolVersion },
        { "sessionId", protocolSession }, { "seq", seq }, { "epoch", epoch }, { "state", state }, { "mode", mode }, { "input", inputEnabled },
        { "visible", visible }, { "strokeCount", scene.Count }, { "pointCount", ScenePointCount() } }); }
    private static void PrintProtocol(Dictionary<string, object> value) { QueueProtocol(Json.Serialize(value), true, false); }
    private static void EmitStateEventIfChanged()
    {
        if (!protocolMode || !protocolReady || (announcedEpoch == epoch && announcedState == state)) return;
        announcedEpoch = epoch; announcedState = state;
        QueueProtocol(Json.Serialize(new Dictionary<string, object> { { "type", "state" }, { "version", ProtocolVersion }, { "sessionId", protocolSession },
            { "eventSeq", ++eventSeq }, { "epoch", epoch }, { "state", state }, { "mode", mode }, { "input", inputEnabled }, { "visible", visible },
            { "strokeCount", scene.Count }, { "pointCount", ScenePointCount() } }), true, false);
    }

    private static bool Refresh(bool explicitRefresh)
    {
        if (deviceLossBlocked && !injectDeviceLoss) { RevokeAndHide(); state = "unknown"; return false; }
        if (terminalResize) return true;
        Rect frame; string observed;
        if (!ReadTrustedTarget(out frame, out observed)) { bool revoked = state == "active"; DisableInputAndHide(); state = observed; if (revoked) epoch++; return observed == "minimized" || observed == "closed"; }
        uint frameDpi = TargetDpi();
        if (frameDpi != 96) { TerminalUnsupportedDpi(); return true; }
        if (Width(frame) != Width(baseline) || Height(frame) != Height(baseline))
        {
            bool revoked = state == "active";
            DisableInputAndHide(); state = "unknown"; if (revoked) epoch++;
            if (Width(frame) == Width(resizeCandidate) && Height(frame) == Height(resizeCandidate)) resizeCandidateSamples++;
            else { resizeCandidate = frame; resizeCandidateSamples = 1; }
            // Restore animations can briefly expose a different DWM frame. Keep
            // input withdrawn until a changed size is stable across three polls.
            if (resizeCandidateSamples < 3) return false;
            terminalResize = true; state = "resized"; epoch++; return true;
        }
        resizeCandidateSamples = 0;
        TrustedSnapshot snapshot;
        IntPtr region;
        if (!BuildTrustedSnapshot(frame, out snapshot, out region)) { bool revoked = state == "active"; DisableInputAndHide(); state = "unknown"; if (revoked) epoch++; FixtureDiagnostic("{\"type\":\"refused\",\"stage\":\"" + refreshFailure + "\"}"); return false; }
        if (region == IntPtr.Zero) { bool revoked = state == "active"; DisableInputAndHide(); state = "unknown"; if (revoked) epoch++; return false; }
        bool targetForeground = GetForegroundWindow() == target;
        bool sameRegion = false; IntPtr existing = CreateRectRgn(0, 0, 0, 0);
        if (existing != IntPtr.Zero)
        {
            sameRegion = GetWindowRgn(visualWindow, existing) != ERROR && EqualRgn(region, existing);
            DeleteObject(existing);
        }
        bool changed = !Same(frame, current) || state != "active" || explicitRefresh || !OverlayIsAboveTarget() ||
            targetForeground != lastTargetForeground || !sameRegion;
        if (!changed) { DeleteObject(region); return true; }
        RevokeAndHide(); // Never leave either layer from an older snapshot visible or interactive.
        if (raceKind != null)
        {
            FixtureDiagnostic("{\"type\":\"race-barrier\",\"kind\":\"" + raceKind + "\",\"input\":false,\"visible\":false}");
            var wait = Stopwatch.StartNew(); string command = null;
            while (wait.ElapsedMilliseconds < 4000 && !shutdownRequested)
            {
                Pump();
                if (overlayQueue != null && overlayQueue.TryDequeue(out command) && command == "race-commit") break;
                Thread.Sleep(2);
            }
            raceKind = null;
            if (command != "race-commit") { DeleteObject(region); state = "unknown"; return false; }
        }
        TrustedSnapshot confirmed; IntPtr confirmedRegion = IntPtr.Zero;
        if (!ReadTrustedTarget(out frame, out observed) || !BuildTrustedSnapshot(frame, out confirmed, out confirmedRegion) || !SameSnapshot(snapshot, confirmed))
        {
            DeleteObject(region); if (confirmedRegion != IntPtr.Zero) DeleteObject(confirmedRegion); DisableInputAndHide(); state = observed == "closed" ? "closed" : "unknown"; FixtureDiagnostic("{\"type\":\"refused\",\"stage\":\"precommit\"}"); return false;
        }
        DeleteObject(confirmedRegion);
        IntPtr inputRegion = CreateRectRgn(0, 0, 0, 0);
        if (inputRegion == IntPtr.Zero || CombineRgn(inputRegion, region, IntPtr.Zero, 5 /* RGN_COPY */) == ERROR)
        { if (inputRegion != IntPtr.Zero) DeleteObject(inputRegion); DeleteObject(region); state = "unknown"; return false; }
        uint hiddenFlags = SWP_NOACTIVATE;
        if (!SetWindowPos(visualWindow, snapshot.InsertAfter, frame.Left, frame.Top, Width(frame), Height(frame), hiddenFlags) ||
            !SetWindowPos(inputWindow, snapshot.InsertAfter, frame.Left, frame.Top, Width(frame), Height(frame), hiddenFlags))
        { DeleteObject(inputRegion); DeleteObject(region); RevokeAndHide(); state = "unknown"; return false; }
        if (SetWindowRgn(visualWindow, region, false) == 0) { DeleteObject(region); DeleteObject(inputRegion); RevokeAndHide(); state = "unknown"; return false; }
        if (SetWindowRgn(inputWindow, inputRegion, false) == 0) { DeleteObject(inputRegion); RevokeAndHide(); state = "unknown"; return false; }
        current = frame; occluders = snapshot.OccluderCount;
        if (!RenderVisual() || !SetWindowPos(visualWindow, snapshot.InsertAfter, frame.Left, frame.Top, Width(frame), Height(frame), SWP_NOACTIVATE | SWP_SHOWWINDOW))
        { RevokeAndHide(); state = "unknown"; return false; }
        uint inputFlags = SWP_NOACTIVATE | (mode == "draw" ? SWP_SHOWWINDOW : 0);
        if (!SetWindowPos(inputWindow, snapshot.InsertAfter, frame.Left, frame.Top, Width(frame), Height(frame), inputFlags))
        { RevokeAndHide(); state = "unknown"; return false; }
        epoch++; state = "active"; visible = true; lastTargetForeground = targetForeground;
        inputEnabled = mode == "draw";
        if (!ConfirmCommittedSnapshot(snapshot) || !ConfirmLayerStylesAndOrder()) { RevokeAndHide(); state = "unknown"; FixtureDiagnostic("{\"type\":\"refused\",\"stage\":\"" + refreshFailure + "\"}"); return false; }
        return true;
    }

    private static bool OverlayIsAboveTarget()
    {
        IntPtr cursor = GetWindow(target, GW_HWNDPREV);
        for (int steps = 0; cursor != IntPtr.Zero && steps < 512; steps++, cursor = GetWindow(cursor, GW_HWNDPREV))
            if (cursor == visualWindow || cursor == inputWindow) return true;
        return false;
    }

    private static bool BuildTrustedSnapshot(Rect frame, out TrustedSnapshot snapshot, out IntPtr region)
    {
        refreshFailure = "region-create"; snapshot = null; region = CreateRectRgn(0, 0, Width(frame), Height(frame));
        if (region == IntPtr.Zero) return false;
        var windows = new System.Collections.Generic.List<WindowSnapshot>();
        int count = 0; IntPtr cursor = GetTopWindow(IntPtr.Zero), nearest = IntPtr.Zero;
        for (int steps = 0; cursor != IntPtr.Zero && cursor != target && steps < 512; steps++, cursor = GetWindow(cursor, GW_HWNDNEXT))
        {
            if (cursor == visualWindow || cursor == inputWindow) continue;
            nearest = cursor;
            WindowSnapshot value;
            if (!ReadWindowSnapshot(cursor, frame, out value)) { DeleteObject(region); region = IntPtr.Zero; return false; }
            if (!value.Visible || value.Minimized || !value.Intersects) continue;
            windows.Add(value);
            if ((value.ExStyle & ((int)WS_EX_TOPMOST | (int)WS_EX_LAYERED)) != 0 || value.Cloaked != 0 || value.RegionType != ERROR)
            { refreshFailure = "occluder-unsupported"; DeleteObject(region); region = IntPtr.Zero; return false; }
            Rect intersection = Intersection(frame, value.Frame); int localLeft, localTop, localRight, localBottom;
            if (!TrySubtract(intersection.Left, frame.Left, out localLeft) || !TrySubtract(intersection.Top, frame.Top, out localTop) ||
                !TrySubtract(intersection.Right, frame.Left, out localRight) || !TrySubtract(intersection.Bottom, frame.Top, out localBottom))
            { refreshFailure = "region-overflow"; DeleteObject(region); region = IntPtr.Zero; return false; }
            IntPtr cut = CreateRectRgn(localLeft, localTop, localRight, localBottom);
            if (cut == IntPtr.Zero || CombineRgn(region, region, cut, RGN_DIFF) == ERROR) { if (cut != IntPtr.Zero) DeleteObject(cut); DeleteObject(region); region = IntPtr.Zero; return false; }
            DeleteObject(cut); count++;
        }
        if (cursor != target || Volatile.Read(ref targetDestroyed) != 0) { refreshFailure = "target-order"; DeleteObject(region); region = IntPtr.Zero; return false; }
        snapshot = new TrustedSnapshot { TargetFrame = frame, TargetDpi = TargetDpi(), Above = windows.ToArray(),
            InsertAfter = nearest == IntPtr.Zero ? HWND_TOP : nearest, OccluderCount = count };
        if (snapshot.TargetDpi == 0) { refreshFailure = "target-dpi"; DeleteObject(region); region = IntPtr.Zero; snapshot = null; return false; }
        return true;
    }

    private static bool ReadWindowSnapshot(IntPtr hwnd, Rect targetFrame, out WindowSnapshot value)
    {
        value = null; uint pid; uint thread = GetWindowThreadProcessId(hwnd, out pid);
        if (thread == 0 || !IsWindow(hwnd)) { refreshFailure = "occluder-identity"; return false; }
        bool visible = IsWindowVisible(hwnd), minimized = IsIconic(hwnd); Rect frame = new Rect();
        Rect coarse = new Rect();
        if (visible && !minimized && !GetWindowRect(hwnd, out coarse)) { refreshFailure = "occluder-rect"; return false; }
        bool intersects = visible && !minimized && Width(coarse) > 0 && Height(coarse) > 0 && Intersects(targetFrame, coarse);
        if (!intersects)
        {
            value = new WindowSnapshot { Hwnd = hwnd, Pid = pid, Thread = thread, Frame = coarse, Visible = visible, Minimized = minimized, Intersects = false };
            bool stable = IsWindow(hwnd) && GetWindowThreadProcessId(hwnd, out pid) == thread; if (!stable) refreshFailure = "occluder-race"; return stable;
        }
        if (!TryFrame(hwnd, out frame)) { refreshFailure = "occluder-frame"; return false; }
        int ex; if (!TryGetWindowLong(hwnd, GWL_EXSTYLE, out ex)) { refreshFailure = "occluder-style"; return false; }
        int cloaked; if (DwmGetWindowAttributeInt(hwnd, DWMWA_CLOAKED, out cloaked, 4) != 0) { refreshFailure = "occluder-cloak"; return false; }
        int regionType; if (!TryGetWindowRegionType(hwnd, out regionType)) { refreshFailure = "occluder-region"; return false; }
        value = new WindowSnapshot { Hwnd = hwnd, Pid = pid, Thread = thread, Frame = frame, ExStyle = ex, Cloaked = cloaked,
            RegionType = regionType, Visible = visible, Minimized = minimized, Intersects = true };
        return true;
    }

    private static bool SameSnapshot(TrustedSnapshot first, TrustedSnapshot second)
    {
        if (first == null || second == null || !Same(first.TargetFrame, second.TargetFrame) || first.TargetDpi != second.TargetDpi ||
            first.Above.Length != second.Above.Length || first.OccluderCount != second.OccluderCount) return false;
        for (int i = 0; i < first.Above.Length; i++)
        {
            WindowSnapshot a = first.Above[i], b = second.Above[i];
            if (a.Hwnd != b.Hwnd || a.Pid != b.Pid || a.Thread != b.Thread || !Same(a.Frame, b.Frame) || a.ExStyle != b.ExStyle ||
                a.Cloaked != b.Cloaked || a.RegionType != b.RegionType || a.Visible != b.Visible || a.Minimized != b.Minimized || a.Intersects != b.Intersects) return false;
        }
        return true;
    }

    private static bool ConfirmCommittedSnapshot(TrustedSnapshot committed)
    {
        Rect frame; string observed; TrustedSnapshot confirmed; IntPtr region;
        if (!ReadTrustedTarget(out frame, out observed) || !BuildTrustedSnapshot(frame, out confirmed, out region)) { refreshFailure = "postcommit-read"; return false; }
        DeleteObject(region);
        if (!SameSnapshot(committed, confirmed)) { refreshFailure = "postcommit-snapshot"; return false; }
        if (!OverlayIsAboveTarget()) { refreshFailure = "postcommit-order"; return false; }
        return true;
    }

    private static bool ReadTrustedTarget(out Rect frame, out string observed)
    {
        frame = new Rect(); observed = "unknown";
        if (Volatile.Read(ref targetDestroyed) != 0 || WaitForSingleObject(targetProcess, 0) == 0) { observed = "closed"; return false; }
        uint pid;
        if (!IsWindow(target) || GetWindowThreadProcessId(target, out pid) != targetThread || pid != targetPid || GetAncestor(target, GA_ROOT) != target) return false;
        if (IsIconic(target) || !IsWindowVisible(target)) { observed = "minimized"; return false; }
        int cloaked, regionType, ex;
        if (!TryGetWindowRegionType(target, out regionType) || !TryGetWindowLong(target, GWL_EXSTYLE, out ex)) return false;
        if ((ex & ((int)WS_EX_TOPMOST | (int)WS_EX_LAYERED)) != 0 || regionType != ERROR ||
            DwmGetWindowAttributeInt(target, DWMWA_CLOAKED, out cloaked, 4) != 0 || cloaked != 0 || !TryFrame(target, out frame)) return false;
        Rect checkedFrame; uint checkedPid;
        if (!TryFrame(target, out checkedFrame) || !Same(frame, checkedFrame) || GetWindowThreadProcessId(target, out checkedPid) != targetThread || checkedPid != targetPid) return false;
        observed = "active"; return true;
    }

    private static bool InstallDestroyLatch()
    {
        destroyHook = SetWinEventHook(EVENT_OBJECT_DESTROY, EVENT_OBJECT_DESTROY, IntPtr.Zero, destroyCallback, targetPid, targetThread, WINEVENT_OUTOFCONTEXT);
        return destroyHook != IntPtr.Zero;
    }

    private static void OnWinEvent(IntPtr hook, uint eventType, IntPtr hwnd, int objectId, int childId, uint eventThread, uint eventTime)
    {
        if (eventType == EVENT_OBJECT_DESTROY && hwnd == target && objectId == OBJID_WINDOW && childId == 0)
        {
            Interlocked.Exchange(ref targetDestroyed, 1);
            inputEnabled = false; visible = false; state = "closed"; Interlocked.Increment(ref epoch); shutdownRequested = true;
        }
    }

    private static bool TryGetWindowLong(IntPtr hwnd, int index, out int value)
    {
        SetLastError(ERROR_SUCCESS); value = GetWindowLongW(hwnd, index);
        return value != 0 || Marshal.GetLastWin32Error() == ERROR_SUCCESS;
    }

    private static bool TryGetWindowRegionType(IntPtr hwnd, out int regionType)
    {
        regionType = ERROR; IntPtr test = CreateRectRgn(0, 0, 0, 0); if (test == IntPtr.Zero) return false;
        SetLastError(ERROR_SUCCESS); regionType = GetWindowRgn(hwnd, test); int error = Marshal.GetLastWin32Error(); DeleteObject(test);
        // GetWindowRgn documents ERROR as the normal "no region" result as well as
        // failure. A nonzero LastError is a hard failure; bracket the no-error case
        // with identity checks so a disappearing/reused HWND is not accepted.
        uint pid; bool stable = IsWindow(hwnd) && GetWindowThreadProcessId(hwnd, out pid) != 0;
        return stable && (regionType != ERROR || error == ERROR_SUCCESS);
    }

    private static void DisableInputAndHide()
    {
        RevokeAndHide();
    }

    private static uint TargetDpi()
    { return fixtureInjection && fixtureTargetDpi != 0 ? fixtureTargetDpi : GetDpiForWindow(target); }

    private static void TerminalUnsupportedDpi()
    {
        RevokeAndHide(); ClearPreview(); ClearLasers(); state = "unsupported-dpi"; refreshFailure = "unsupported-dpi"; Interlocked.Increment(ref epoch);
        if (protocolMode && protocolReady)
        {
            announcedEpoch = epoch; announcedState = state;
            PrintProtocol(new Dictionary<string, object> { { "type", "state" }, { "version", ProtocolVersion }, { "sessionId", protocolSession },
                { "eventSeq", ++eventSeq }, { "epoch", epoch }, { "state", state }, { "mode", mode }, { "input", false }, { "visible", false },
                { "strokeCount", scene.Count }, { "pointCount", ScenePointCount() } });
        }
        shutdownRequested = true;
    }

    private static void RevokeInput()
    {
        CancelInputStroke(); inputEnabled = false;
        if (inputWindow != IntPtr.Zero) { IntPtr empty = CreateRectRgn(0, 0, 0, 0); if (empty != IntPtr.Zero && SetWindowRgn(inputWindow, empty, false) == 0) DeleteObject(empty); ShowWindow(inputWindow, 0); }
    }

    private static void RevokeAndHide()
    {
        RevokeInput(); ClearPreview(); ClearLasers(); visible = false;
        if (visualWindow != IntPtr.Zero) { IntPtr empty = CreateRectRgn(0, 0, 0, 0); if (empty != IntPtr.Zero && SetWindowRgn(visualWindow, empty, false) == 0) DeleteObject(empty); ShowWindow(visualWindow, 0); }
    }

    private static int OverlayStartupFailure(string reason)
    {
        DisableInputAndHide();
        ReleaseVisualSurface();
        bool destroyed = inputWindow == IntPtr.Zero || DestroyWindow(inputWindow); inputWindow = window = IntPtr.Zero;
        destroyed = (visualWindow == IntPtr.Zero || DestroyWindow(visualWindow)) && destroyed; visualWindow = IntPtr.Zero;
        if (targetProcess != IntPtr.Zero) { CloseHandle(targetProcess); targetProcess = IntPtr.Zero; }
        if (parentProcess != IntPtr.Zero) { CloseHandle(parentProcess); parentProcess = IntPtr.Zero; }
        if (protocolMode) { Console.Error.WriteLine("startup-refused:" + reason); Console.Error.Flush(); }
        else { Print("{\"type\":\"startup-refused\",\"role\":\"overlay\",\"reason\":\"" + reason + "\"}");
            Print("{\"type\":\"cleanup\",\"role\":\"overlay\",\"destroyed\":" + Bool(destroyed) + "}"); }
        return 1;
    }

    private static bool ConfirmLayerStylesAndOrder()
    {
        int visualStyle, inputStyle;
        if (!TryGetWindowLong(visualWindow, GWL_EXSTYLE, out visualStyle) || !TryGetWindowLong(inputWindow, GWL_EXSTYLE, out inputStyle) ||
            (visualStyle & ((int)WS_EX_LAYERED | (int)WS_EX_TRANSPARENT | (int)WS_EX_NOACTIVATE)) != ((int)WS_EX_LAYERED | (int)WS_EX_TRANSPARENT | (int)WS_EX_NOACTIVATE) ||
            (inputStyle & ((int)WS_EX_LAYERED | (int)WS_EX_TRANSPARENT | (int)WS_EX_NOACTIVATE | (int)WS_EX_NOREDIRECTIONBITMAP)) != ((int)WS_EX_NOACTIVATE | (int)WS_EX_NOREDIRECTIONBITMAP))
        { refreshFailure = "layer-style"; return false; }
        if (GetWindow(target, GW_HWNDPREV) != visualWindow) { refreshFailure = "visual-not-directly-above-target"; return false; }
        if (GetWindow(visualWindow, GW_HWNDPREV) != inputWindow) { refreshFailure = "input-not-directly-above-visual"; return false; }
        if (mode == "draw" && (!IsWindowVisible(inputWindow) || !inputEnabled)) { refreshFailure = "input-not-visible"; return false; }
        if (mode == "pointer" && IsWindowVisible(inputWindow)) { refreshFailure = "input-visible-pointer"; return false; }
        return IsWindowVisible(visualWindow);
    }

    private static bool InitializeVisualSurface(int width, int height)
    {
        ReleaseVisualSurface();
        if (injectDeviceLoss) { injectDeviceLoss = false; refreshFailure = "device-loss-injected"; return false; }
        IntPtr screen = GetDC(IntPtr.Zero);
        if (screen == IntPtr.Zero) return false;
        visualDc = CreateCompatibleDC(screen); ReleaseDC(IntPtr.Zero, screen);
        var info = new BitmapInfo { Header = new BitmapInfoHeader { Size = (uint)Marshal.SizeOf(typeof(BitmapInfoHeader)), Width = width,
            Height = -height, Planes = 1, BitCount = 32, Compression = 0 }, Colors = new uint[256] };
        visualBitmap = CreateDIBSection(visualDc, ref info, 0, out visualBits, IntPtr.Zero, 0);
        if (visualDc == IntPtr.Zero || visualBitmap == IntPtr.Zero || visualBits == IntPtr.Zero) { ReleaseVisualSurface(); return false; }
        visualOldBitmap = SelectObject(visualDc, visualBitmap); visualWidth = width; visualHeight = height;
        try
        {
            Guid factoryId = typeof(ID2D1Factory).GUID;
            if (D2D1CreateFactory(0, ref factoryId, IntPtr.Zero, out d2dFactory) != 0 || d2dFactory == null) { ReleaseVisualSurface(); return false; }
            var properties = new D2DRenderTargetProperties { Type = 0, PixelFormat = new D2DPixelFormat { Format = 87, AlphaMode = 1 }, DpiX = 96, DpiY = 96 };
            if (d2dFactory.CreateDCRenderTarget(ref properties, out d2dTarget) != 0 || d2dTarget == null) { ReleaseVisualSurface(); return false; }
            d2dTargetPointer = Marshal.GetIUnknownForObject(d2dTarget);
            Rect bounds = new Rect { Right = width, Bottom = height };
            if (d2dTarget.BindDC(visualDc, ref bounds) != 0) { ReleaseVisualSurface(); return false; }
            return true;
        }
        catch { ReleaseVisualSurface(); return false; }
    }

    private static void ReleaseVisualSurface()
    {
        if (d2dTarget != null) { Marshal.FinalReleaseComObject(d2dTarget); d2dTarget = null; }
        if (d2dTargetPointer != IntPtr.Zero) { Marshal.Release(d2dTargetPointer); d2dTargetPointer = IntPtr.Zero; }
        if (d2dFactory != null) { Marshal.FinalReleaseComObject(d2dFactory); d2dFactory = null; }
        if (visualDc != IntPtr.Zero && visualOldBitmap != IntPtr.Zero) SelectObject(visualDc, visualOldBitmap);
        visualOldBitmap = IntPtr.Zero;
        if (visualBitmap != IntPtr.Zero) DeleteObject(visualBitmap);
        if (visualDc != IntPtr.Zero) DeleteDC(visualDc);
        visualBitmap = visualDc = visualBits = IntPtr.Zero; visualWidth = visualHeight = 0;
    }

    private static bool RenderVisual()
    {
        if (injectDeviceLoss || d2dTarget == null || visualDc == IntPtr.Zero)
        {
            bool injected = injectDeviceLoss; ReleaseVisualSurface();
            if (injected) { injectDeviceLoss = false; refreshFailure = "device-loss-injected"; return false; }
            if (!InitializeVisualSurface(Width(current), Height(current))) { refreshFailure = "visual-rebuild"; return false; }
        }
        try
        {
            refreshFailure = "visual-begin"; ComMethod<D2DBeginDraw>(d2dTargetPointer, 48)(d2dTargetPointer); var clear = new D2DColor();
            refreshFailure = "visual-clear"; ComMethod<D2DClear>(d2dTargetPointer, 47)(d2dTargetPointer, ref clear);
            foreach (SceneElement element in scene) if (previewEpoch != epoch || !previewHiddenIds.Contains(element.Id)) DrawD2DElement(element);
            foreach (LaserElement laser in lasers) DrawD2DLaser(laser);
            if (inputStroke != null && draftTool != "eraser")
            {
                if (ValidShape(draftTool) && inputStroke.Count > 1) DrawD2DShape(draftTool, inputStroke[0], inputStroke[inputStroke.Count - 1], draftColor, draftSize);
                else if (draftTool == "laser" && lasers.Count == 0) DrawD2DLaser(new LaserElement { Stroke = new SceneElement { Points = inputStroke, Size = draftSize }, Opacity = 1 });
                else DrawD2DStroke(inputStroke, draftColor, draftSize * (draftHighlight ? 4 : 1), draftHighlight ? 0.35f : 1f);
            }
            refreshFailure = "visual-end"; ulong first, second; if (ComMethod<D2DEndDraw>(d2dTargetPointer, 49)(d2dTargetPointer, out first, out second) != 0) { ReleaseVisualSurface(); refreshFailure = "d2d-enddraw"; return false; }
            var source = new Point(); var size = new Size { Width = visualWidth, Height = visualHeight };
            var destination = new Point { X = current.Left, Y = current.Top };
            var blend = new BlendFunction { Operation = 0, SourceAlpha = 255, AlphaFormat = 1 };
            IntPtr screen = GetDC(IntPtr.Zero); bool ok = screen != IntPtr.Zero && UpdateLayeredWindow(visualWindow, screen, ref destination, ref size, visualDc, ref source, 0, ref blend, 2);
            if (screen != IntPtr.Zero) ReleaseDC(IntPtr.Zero, screen);
            if (!ok) refreshFailure = "update-layered";
            return ok;
        }
        catch (Exception error) { string stage = refreshFailure; ReleaseVisualSurface(); refreshFailure = stage + "-" + error.GetType().Name; return false; }
    }

    private static void DrawD2DStroke(List<ScenePoint> points, string color, double width, float alpha)
    {
        if (points == null || points.Count == 0) return;
        var value = new D2DColor { R = Convert.ToInt32(color.Substring(1, 2), 16) / 255f, G = Convert.ToInt32(color.Substring(3, 2), 16) / 255f,
            B = Convert.ToInt32(color.Substring(5, 2), 16) / 255f, A = alpha };
        IntPtr brush; if (ComMethod<D2DCreateBrush>(d2dTargetPointer, 8)(d2dTargetPointer, ref value, IntPtr.Zero, out brush) != 0 || brush == IntPtr.Zero) throw new InvalidOperationException();
        try
        {
            if (points.Count == 1) { D2DPoint a = D2DPointFor(points[0]), b = a; b.X += 0.01f; ComMethod<D2DDrawLine>(d2dTargetPointer, 15)(d2dTargetPointer, a, b, brush, (float)width, IntPtr.Zero); }
            else for (int i = 1; i < points.Count; i++) ComMethod<D2DDrawLine>(d2dTargetPointer, 15)(d2dTargetPointer, D2DPointFor(points[i - 1]), D2DPointFor(points[i]), brush, (float)width, IntPtr.Zero);
        }
        finally { Marshal.Release(brush); }
    }

    private static void DrawD2DElement(SceneElement element)
    {
        if (element.Type == "stroke") DrawD2DStroke(element.Points, element.Color, element.Size * (element.Highlight ? 4 : 1), element.Highlight ? 0.35f : 1f);
        else DrawD2DShape(element.Kind, new ScenePoint { X = element.X1, Y = element.Y1 }, new ScenePoint { X = element.X2, Y = element.Y2 }, element.Color, element.Size);
    }

    private static void DrawD2DLaser(LaserElement laser)
    {
        if (laser == null || laser.Stroke == null || laser.Opacity <= 0) return;
        float opacity = (float)Math.Max(0, Math.Min(1, laser.Opacity));
        DrawD2DStroke(laser.Stroke.Points, "#ff3b30", Math.Max(3, laser.Stroke.Size) + 10, opacity * 0.16f);
        DrawD2DStroke(laser.Stroke.Points, "#ff3b30", Math.Max(3, laser.Stroke.Size) + 4, opacity * 0.32f);
        DrawD2DStroke(laser.Stroke.Points, "#ff3b30", Math.Max(3, laser.Stroke.Size), opacity);
    }

    private static void DrawD2DShape(string kind, ScenePoint first, ScenePoint second, string color, double width)
    {
        var value = new D2DColor { R = Convert.ToInt32(color.Substring(1, 2), 16) / 255f, G = Convert.ToInt32(color.Substring(3, 2), 16) / 255f,
            B = Convert.ToInt32(color.Substring(5, 2), 16) / 255f, A = 1f };
        IntPtr brush; if (ComMethod<D2DCreateBrush>(d2dTargetPointer, 8)(d2dTargetPointer, ref value, IntPtr.Zero, out brush) != 0 || brush == IntPtr.Zero) throw new InvalidOperationException();
        try
        {
            D2DPoint a = D2DPointFor(first), b = D2DPointFor(second);
            if (kind == "rectangle")
            {
                var rect = new D2DRect { Left = Math.Min(a.X, b.X), Top = Math.Min(a.Y, b.Y), Right = Math.Max(a.X, b.X), Bottom = Math.Max(a.Y, b.Y) };
                ComMethod<D2DDrawRectangle>(d2dTargetPointer, 16)(d2dTargetPointer, ref rect, brush, (float)width, IntPtr.Zero);
            }
            else if (kind == "ellipse")
            {
                var ellipse = new D2DEllipse { Center = new D2DPoint { X = (a.X + b.X) / 2, Y = (a.Y + b.Y) / 2 }, RadiusX = Math.Abs(b.X - a.X) / 2, RadiusY = Math.Abs(b.Y - a.Y) / 2 };
                ComMethod<D2DDrawEllipse>(d2dTargetPointer, 20)(d2dTargetPointer, ref ellipse, brush, (float)width, IntPtr.Zero);
            }
            else
            {
                D2DDrawLine drawLine = ComMethod<D2DDrawLine>(d2dTargetPointer, 15);
                drawLine(d2dTargetPointer, a, b, brush, (float)width, IntPtr.Zero);
                double angle = Math.Atan2(b.Y - a.Y, b.X - a.X), head = Math.Max(12, width * 3.5), half = head / 2;
                D2DPoint left = new D2DPoint { X = b.X + (float)(-head * Math.Cos(angle) - half * Math.Sin(angle)), Y = b.Y + (float)(-head * Math.Sin(angle) + half * Math.Cos(angle)) };
                D2DPoint right = new D2DPoint { X = b.X + (float)(-head * Math.Cos(angle) + half * Math.Sin(angle)), Y = b.Y + (float)(-head * Math.Sin(angle) - half * Math.Cos(angle)) };
                drawLine(d2dTargetPointer, b, left, brush, (float)width, IntPtr.Zero); drawLine(d2dTargetPointer, b, right, brush, (float)width, IntPtr.Zero);
            }
        }
        finally { Marshal.Release(brush); }
    }

    private static D2DPoint D2DPointFor(ScenePoint point)
    { return new D2DPoint { X = (float)(point.X * Math.Max(1, visualWidth - 1)), Y = (float)(point.Y * Math.Max(1, visualHeight - 1)) }; }
    private static T ComMethod<T>(IntPtr value, int slot) where T : class
    { IntPtr table = Marshal.ReadIntPtr(value); return Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(table, slot * IntPtr.Size), typeof(T)) as T; }


    private static IntPtr Dispatch(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam)
    {
        if (message == WM_DPICHANGED)
        {
            if (role == "overlay") { TerminalUnsupportedDpi(); return IntPtr.Zero; }
            Rect suggested = (Rect)Marshal.PtrToStructure(lparam, typeof(Rect));
            if (Width(suggested) > 0 && Height(suggested) > 0) SetWindowPos(hwnd, IntPtr.Zero, suggested.Left, suggested.Top, Width(suggested), Height(suggested), SWP_NOACTIVATE | SWP_NOZORDER);
            return IntPtr.Zero;
        }
        if (message == WM_NCHITTEST && role == "overlay") return new IntPtr(hwnd == inputWindow && inputEnabled ? HTCLIENT : HTTRANSPARENT);
        if (message == WM_LBUTTONDOWN) {
            if (role == "overlay" && hwnd == inputWindow && inputEnabled && protocolMode) BeginInputStroke(hwnd, lparam);
            else if (role == "overlay" && inputEnabled) { strokes++; InvalidateRect(hwnd, IntPtr.Zero, false); }
            else if (role == "target" || role == "occluder") clicks++;
        }
        if (message == WM_MOUSEMOVE && hwnd == inputWindow && role == "overlay" && inputEnabled && protocolMode && inputStroke != null && (wparam.ToInt64() & 1) != 0) AppendInputPoint(lparam, "move");
        if (message == WM_LBUTTONUP && hwnd == inputWindow && role == "overlay" && protocolMode && inputStroke != null) EndInputStroke(lparam);
        if ((message == WM_CAPTURECHANGED || message == WM_CANCELMODE) && role == "overlay" && protocolMode) CancelInputStroke();
        if (message == WM_PAINT)
        {
            var paint = new PaintStruct { Reserved = new byte[32] }; IntPtr dc = BeginPaint(hwnd, ref paint);
            if (dc != IntPtr.Zero)
            {
                Rect client; GetClientRect(hwnd, out client);
                if (role != "overlay")
                {
                    IntPtr brush = CreateSolidBrush(role == "target" ? 0x00A05020u : 0x002060E0u);
                    FillRect(dc, ref client, brush); DeleteObject(brush);
                }
            }
            EndPaint(hwnd, ref paint); return IntPtr.Zero;
        }
        if (message == WM_CLOSE) { DestroyWindow(hwnd); return IntPtr.Zero; }
        if (message == WM_DESTROY && !recreating) { if (hwnd == inputWindow) inputWindow = window = IntPtr.Zero; if (hwnd == visualWindow) visualWindow = IntPtr.Zero; if (inputWindow == IntPtr.Zero && visualWindow == IntPtr.Zero) { shutdownRequested = true; PostQuitMessage(0); } return IntPtr.Zero; }
        return DefWindowProcW(hwnd, message, wparam, lparam);
    }

    private static ScenePoint InputPoint(IntPtr lparam)
    {
        Rect client; GetClientRect(inputWindow, out client);
        int packed = unchecked((int)lparam.ToInt64()), x = (short)(packed & 0xffff), y = (short)((packed >> 16) & 0xffff);
        return new ScenePoint { X = Math.Max(0, Math.Min(1, x / (double)Math.Max(1, client.Right - 1))), Y = Math.Max(0, Math.Min(1, y / (double)Math.Max(1, client.Bottom - 1))) };
    }
    private static void BeginInputStroke(IntPtr hwnd, IntPtr lparam)
    {
        CancelInputStroke(); inputStroke = new List<ScenePoint> { InputPoint(lparam) }; SetCapture(hwnd); EmitPointer("down", inputStroke);
        if (draftTool != "eraser") RenderVisual();
    }
    private static void AppendInputPoint(IntPtr lparam, string phase)
    {
        if (draftTool != "eraser" && inputStroke.Count >= MaxPointsPerStroke) { CancelInputStroke(); return; }
        ScenePoint point = InputPoint(lparam);
        if (ValidShape(draftTool) || draftTool == "eraser") { if (inputStroke.Count == 1) inputStroke.Add(point); else inputStroke[1] = point; }
        else inputStroke.Add(point);
        if (phase == "move") { lock (outputLock) { pendingMovePoints.Add(point); } }
        else EmitPointer(phase, new List<ScenePoint> { point });
        if (draftTool != "eraser") RenderVisual();
    }
    private static void EndInputStroke(IntPtr lparam)
    {
        ScenePoint point = InputPoint(lparam), last = inputStroke[inputStroke.Count - 1];
        if (point.X != last.X || point.Y != last.Y) {
            if (ValidShape(draftTool) || draftTool == "eraser") { if (inputStroke.Count == 1) inputStroke.Add(point); else inputStroke[1] = point; }
            else { if (inputStroke.Count >= MaxPointsPerStroke) { CancelInputStroke(); return; } inputStroke.Add(point); }
        }
        FlushPointerMoves(); EmitPointer("up", point.X == last.X && point.Y == last.Y ? new List<ScenePoint> { last } : new List<ScenePoint> { point }, true);
        inputStroke = null; if (GetCapture() == inputWindow) ReleaseCapture(); if (draftTool != "eraser") RenderVisual();
    }
    private static void CancelInputStroke()
    {
        if (inputStroke == null) return; inputStroke = null; lock (outputLock) { pendingMovePoints.Clear(); } EmitPointer("cancel", new List<ScenePoint>(), true);
        if (GetCapture() == inputWindow) ReleaseCapture(); if (visualWindow != IntPtr.Zero) RenderVisual();
    }
    private static void EmitPointer(string phase, List<ScenePoint> points, bool priority = false)
    {
        if (!protocolMode || !protocolReady) return;
        var output = new List<object>(points.Count); foreach (ScenePoint point in points) output.Add(new object[] { point.X, point.Y });
        string line = Json.Serialize(new Dictionary<string, object> { { "type", "pointer" }, { "version", ProtocolVersion }, { "sessionId", protocolSession },
            { "epoch", epoch }, { "inputSeq", ++inputSeq }, { "phase", phase }, { "points", output.ToArray() } });
        if (!QueueProtocol(line, priority, phase == "move")) { inputSeq--; pointerBackpressure = true; }
    }
    private static void DrawStroke(IntPtr dc, Rect client, List<ScenePoint> points, string color, double size)
    {
        if (points == null || points.Count == 0) return;
        uint rgb = Convert.ToUInt32(color.Substring(1, 2), 16) | (Convert.ToUInt32(color.Substring(3, 2), 16) << 8) | (Convert.ToUInt32(color.Substring(5, 2), 16) << 16);
        IntPtr pen = CreatePen(0, Math.Max(1, (int)Math.Round(size)), rgb), old = SelectObject(dc, pen);
        MoveToEx(dc, (int)(points[0].X * Math.Max(1, client.Right - 1)), (int)(points[0].Y * Math.Max(1, client.Bottom - 1)), IntPtr.Zero);
        for (int i = 1; i < points.Count; i++) LineTo(dc, (int)(points[i].X * Math.Max(1, client.Right - 1)), (int)(points[i].Y * Math.Max(1, client.Bottom - 1)));
        SelectObject(dc, old); DeleteObject(pen);
    }

    private static int RunProbe(string[] args)
    {
        int x, y, identityOffset = 4, burstCount = 0;
        if (!int.TryParse(args[1], out x) || !int.TryParse(args[2], out y) ||
            (args[3] != "click" && args[3] != "drag" && args[3] != "hit" && args[3] != "burst")) return 1;
        if (args[3] == "burst")
        {
            identityOffset = 5;
            if (!int.TryParse(args[4], out burstCount) || burstCount < 1 || burstCount > 1024) return 1;
        }
        string[] names = { "target", "overlay", "occluder" }; int groups = (args.Length - 4) / 4;
        groups = (args.Length - identityOffset) / 4;
        var identities = new ProbeIdentity[groups];
        for (int i = 0; i < groups; i++)
        {
            int at = identityOffset + i * 4;
            if ((i == 0 && args[at] != "target") || (i > 0 && args[at] != names[i] && args[at] != "occluder")) return 1;
            identities[i] = new ProbeIdentity { Role = args[at], Hwnd = args[at + 1], Pid = args[at + 2], Started = args[at + 3] };
        }
        string hitRole;
        if (!AuthenticateProbeHit(x, y, identities, out hitRole)) { Print("{\"type\":\"probe\",\"role\":\"other\",\"sent\":false,\"released\":true}"); return 2; }
        if (args[3] == "hit") { Print("{\"type\":\"probe\",\"role\":\"" + hitRole + "\",\"sent\":false,\"released\":true}"); return 0; }
        if (!SetCursorPos(x, y) || !AuthenticateProbeHit(x, y, identities, out hitRole)) { Print("{\"type\":\"probe\",\"role\":\"other\",\"sent\":false,\"released\":true}"); return 2; }
        if (args[3] == "burst")
        {
            if (hitRole != "overlay" || !AuthenticateProbeHit(x, y, identities, out hitRole) || hitRole != "overlay")
            { Print("{\"type\":\"probe\",\"role\":\"" + hitRole + "\",\"sent\":false,\"released\":true}"); return 2; }
            var burst = new Input[burstCount * 2];
            for (int i = 0; i < burstCount; i++) { burst[i * 2].Type = 0; burst[i * 2].Mouse.Flags = 0x0002; burst[i * 2 + 1].Type = 0; burst[i * 2 + 1].Mouse.Flags = 0x0004; }
            uint sent = SendInput((uint)burst.Length, burst, Marshal.SizeOf(typeof(Input)));
            var finalUp = new Input[1]; finalUp[0].Type = 0; finalUp[0].Mouse.Flags = 0x0004;
            bool burstReleased = (sent % 2) == 0 || SendInput(1, finalUp, Marshal.SizeOf(typeof(Input))) == 1;
            Print("{\"type\":\"probe\",\"role\":\"overlay\",\"sent\":" + Bool(sent == burst.Length) + ",\"released\":" + Bool(burstReleased) + ",\"count\":" + sent + "}");
            return sent == (uint)burst.Length && burstReleased ? 0 : 1;
        }
        var down = new Input[1]; down[0].Type = 0; down[0].Mouse.Flags = 0x0002;
        var up = new Input[1]; up[0].Type = 0; up[0].Mouse.Flags = 0x0004;
        if (!AuthenticateProbeHit(x, y, identities, out hitRole)) { Print("{\"type\":\"probe\",\"role\":\"other\",\"sent\":false,\"released\":true}"); return 2; }
        bool pressed = SendInput(1, down, Marshal.SizeOf(typeof(Input))) == 1;
        bool released = false;
        if (pressed && args[3] == "drag") { Thread.Sleep(20); SetCursorPos(x + 40, y + 30); Thread.Sleep(20); }
        bool stillTrusted = AuthenticateProbeHit(x, y, identities, out hitRole);
        if (args[3] == "drag") stillTrusted = AuthenticateProbeHit(x + 40, y + 30, identities, out hitRole);
        if (pressed) for (int attempt = 0; attempt < 3 && !released; attempt++) released = SendInput(1, up, Marshal.SizeOf(typeof(Input))) == 1;
        Print("{\"type\":\"probe\",\"role\":\"" + (stillTrusted ? hitRole : "other") + "\",\"sent\":" + Bool(pressed && released && stillTrusted) + ",\"released\":" + Bool(!pressed || released) + "}");
        return pressed && released && stillTrusted ? 0 : 1;
    }

    private static bool AuthenticateProbeHit(int x, int y, ProbeIdentity[] identities, out string hitRole)
    {
        hitRole = "other"; IntPtr hit = WindowFromPoint(new Point { X = x, Y = y });
        for (int i = 0; i < identities.Length; i++)
        {
            ProbeIdentity identity = identities[i]; IntPtr candidate, process; uint pid, thread; ulong started;
            string hwnd = identity.Hwnd == "hit" && identity.Role == "overlay" ? unchecked((ulong)hit.ToInt64()).ToString(CultureInfo.InvariantCulture) : identity.Hwnd;
            if (!TryIdentity(hwnd, identity.Pid, identity.Started, out candidate, out pid, out started, out thread, out process)) return false;
            CloseHandle(process); if (candidate == hit) hitRole = identity.Role;
        }
        return hitRole != "other";
    }

    private static int RunGone(string[] args)
    {
        ulong bits; uint pid; ulong started;
        if (!ulong.TryParse(args[1], out bits) || !uint.TryParse(args[2], out pid) || !ulong.TryParse(args[3], out started)) return 1;
        IntPtr hwnd = new IntPtr(unchecked((long)bits));
        bool windowGone = !IsWindow(hwnd), processGone = true;
        IntPtr process = OpenProcess(0x101000, false, pid);
        if (process != IntPtr.Zero)
        {
            FileTime created, exited, kernel, user;
            bool same = GetProcessTimes(process, out created, out exited, out kernel, out user) && (((ulong)created.High << 32) | created.Low) == started;
            processGone = !same || WaitForSingleObject(process, 0) == 0;
            CloseHandle(process);
        }
        Print("{\"type\":\"gone\",\"window\":" + Bool(windowGone) + ",\"process\":" + Bool(processGone) + "}");
        return windowGone && processGone ? 0 : 1;
    }


    private static bool TryIdentity(string hwndText, string pidText, string startedText, out IntPtr hwnd, out uint pid, out ulong started, out uint thread, out IntPtr process)
    {
        hwnd = process = IntPtr.Zero; pid = thread = 0; started = 0; ulong bits;
        if (!ulong.TryParse(hwndText, out bits) || bits == 0 || !uint.TryParse(pidText, out pid) || pid == 0 || !ulong.TryParse(startedText, out started) || started == 0) return false;
        hwnd = new IntPtr(unchecked((long)bits)); uint actualPid; thread = GetWindowThreadProcessId(hwnd, out actualPid);
        if (thread == 0 || actualPid != pid || GetAncestor(hwnd, GA_ROOT) != hwnd) return false;
        process = OpenProcess(0x101000, false, pid); if (process == IntPtr.Zero) return false;
        FileTime created, exited, kernel, user;
        ulong actualStarted;
        if (!GetProcessTimes(process, out created, out exited, out kernel, out user) || WaitForSingleObject(process, 0) != 258) { CloseHandle(process); process = IntPtr.Zero; return false; }
        actualStarted = ((ulong)created.High << 32) | created.Low;
        if (actualStarted != started) { CloseHandle(process); process = IntPtr.Zero; return false; }
        return true;
    }

    private static void PrintReady(string readyRole, IntPtr hwnd)
    {
        using (Process process = Process.GetCurrentProcess())
        {
            ulong started = process.StartTime.ToFileTimeUtc() > 0 ? (ulong)process.StartTime.ToFileTimeUtc() : 0;
            uint pid; GetWindowThreadProcessId(hwnd, out pid);
            Print("{\"type\":\"ready\",\"role\":\"" + readyRole + "\",\"hwnd\":\"" + unchecked((ulong)hwnd.ToInt64()).ToString(CultureInfo.InvariantCulture) +
                "\",\"pid\":\"" + pid + "\",\"started\":\"" + started + "\"}");
        }
    }
    private static void PrintState() { int visualEx = visualWindow == IntPtr.Zero ? 0 : GetWindowLongW(visualWindow, GWL_EXSTYLE); int inputEx = inputWindow == IntPtr.Zero ? 0 : GetWindowLongW(inputWindow, GWL_EXSTYLE); IntPtr hit = WindowFromPoint(new Point { X = current.Left + Width(current) / 2, Y = current.Top + Height(current) / 2 });
        string hitRole = hit == inputWindow ? "overlay" : hit == target ? "target" : "other";
        Print("{\"type\":\"state\",\"state\":\"" + state + "\",\"mode\":\"" + mode + "\",\"epoch\":" + epoch +
        ",\"input\":" + Bool(inputEnabled) + ",\"visible\":" + Bool(visible) + ",\"occluders\":" + occluders + ",\"strokes\":" + strokes +
        ",\"hitRole\":\"" + hitRole + "\",\"overlayAboveTarget\":" + Bool(OverlayIsAboveTarget()) + ",\"targetActive\":" + Bool(GetForegroundWindow() == target) + ",\"transparentStyle\":" + Bool((visualEx & (int)WS_EX_TRANSPARENT) != 0) +
        ",\"noActivate\":" + Bool((visualEx & (int)WS_EX_NOACTIVATE) != 0 && (inputEx & (int)WS_EX_NOACTIVATE) != 0) + ",\"topmost\":" + Bool(((visualEx | inputEx) & (int)WS_EX_TOPMOST) != 0) +
        ",\"bounds\":{\"x\":" + current.Left + ",\"y\":" + current.Top + ",\"width\":" + Width(current) + ",\"height\":" + Height(current) + "}}"); }
    private static ConcurrentQueue<string> StartReader()
    {
        var queue = new ConcurrentQueue<string>();
        var thread = new Thread(delegate()
        {
            var input = Console.OpenStandardInput(); var bytes = new List<byte>(256); bool oversized = false;
            try
            {
                while (true)
                {
                    int value = input.ReadByte();
                    if (value < 0) break;
                    if (value == 10)
                    {
                        if (oversized) queue.Enqueue(OversizedInput);
                        else
                        {
                            if (bytes.Count > 0 && bytes[bytes.Count - 1] == 13) bytes.RemoveAt(bytes.Count - 1);
                            try { queue.Enqueue(new UTF8Encoding(false, true).GetString(bytes.ToArray())); }
                            catch { queue.Enqueue("{"); }
                        }
                        bytes.Clear(); oversized = false; continue;
                    }
                    if (!oversized)
                    {
                        if (bytes.Count < MaxProtocolLine) bytes.Add((byte)value);
                        else { bytes.Clear(); oversized = true; }
                    }
                }
            }
            catch { }
            if (bytes.Count > 0 || oversized) queue.Enqueue(oversized ? OversizedInput : new UTF8Encoding(false, false).GetString(bytes.ToArray()));
            queue.Enqueue(protocolMode ? EndOfInput : "exit");
        });
        thread.IsBackground = true; thread.Start(); return queue;
    }
    private static long ParseFixtureLifetime(string[] args)
    {
        int value;
        if (args.Length == 5 && int.TryParse(args[4], NumberStyles.Integer, CultureInfo.InvariantCulture, out value) && value >= 100 && value <= 120000) return value;
        return 45000;
    }
    private static void FixtureDiagnostic(string value)
    {
        if (protocolMode) { Console.Error.WriteLine(value); Console.Error.Flush(); }
        else Print(value);
    }
    private static void StartProtocolWriter()
    {
        outputStopping = false; outputFailed = false;
        outputThread = new Thread(delegate()
        {
            while (true)
            {
                OutboundLine line = null;
                lock (outputLock)
                {
                    if (outputQueue.Count > 0) line = outputQueue.Dequeue();
                    else if (outputStopping) break;
                }
                if (line == null) { outputSignal.WaitOne(100); continue; }
                try { Console.WriteLine(line.Value); Console.Out.Flush(); }
                catch { outputFailed = true; shutdownRequested = true; break; }
            }
        });
        outputThread.IsBackground = true; outputThread.Start();
    }
    private static bool QueueProtocol(string value, bool priority, bool move)
    {
        if (!protocolMode || outputFailed || outputStopping) return false;
        lock (outputLock)
        {
            int limit = priority ? MaxOutputQueue : MaxOutputQueue - ReservedPriorityOutput;
            if (outputQueue.Count >= limit) return false;
            outputQueue.Enqueue(new OutboundLine { Value = value, Priority = priority, Move = move });
        }
        outputSignal.Set(); return true;
    }
    private static void FlushPointerMoves()
    {
        while (true)
        {
            List<ScenePoint> batch;
            lock (outputLock)
            {
                if (pendingMovePoints.Count == 0) return;
                int count = Math.Min(64, pendingMovePoints.Count); batch = pendingMovePoints.GetRange(0, count); pendingMovePoints.RemoveRange(0, count);
            }
            EmitPointer("move", batch);
            if (pointerBackpressure) { lock (outputLock) { pendingMovePoints.Clear(); } return; }
        }
    }
    private static void StopProtocolWriter()
    {
        lock (outputLock) outputStopping = true; outputSignal.Set();
        if (outputThread != null) outputThread.Join(1000);
    }
    private static void Pump() { Msg msg; for (int i = 0; i < 64 && PeekMessageW(out msg, IntPtr.Zero, 0, 0, 1); i++) { if (msg.Message == WM_QUIT) { shutdownRequested = true; break; } TranslateMessage(ref msg); DispatchMessageW(ref msg); } }
    private static void Print(string value) { Console.WriteLine(value); Console.Out.Flush(); }
    private static string SafeCommand(string value) { return value == "pointer" || value == "draw" || value == "refresh" || value == "query" || value == "move" || value == "move-any" || value == "resize" || value == "minimize" || value == "restore" || value == "elevate" || value == "lower" || value == "recreate" || value == "race-target" || value == "race-occluder" || value == "race-commit" || value == "device-loss" || value == "close" || value == "crash" || value == "exit" ? value : "invalid"; }
    private static string HwndText(IntPtr hwnd) { return unchecked((ulong)hwnd.ToInt64()).ToString(CultureInfo.InvariantCulture); }
    private static bool TryFrame(IntPtr hwnd, out Rect value) { return DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out value, Marshal.SizeOf(typeof(Rect))) == 0 && Width(value) > 0 && Height(value) > 0; }
    private static int Width(Rect value) { long size = (long)value.Right - value.Left; return size > 0 && size <= Int32.MaxValue ? (int)size : 0; }
    private static int Height(Rect value) { long size = (long)value.Bottom - value.Top; return size > 0 && size <= Int32.MaxValue ? (int)size : 0; }
    private static bool TrySubtract(int value, int origin, out int result) { long local = (long)value - origin; result = local >= Int32.MinValue && local <= Int32.MaxValue ? (int)local : 0; return local >= Int32.MinValue && local <= Int32.MaxValue; }
    private static bool Same(Rect a, Rect b) { return a.Left == b.Left && a.Top == b.Top && a.Right == b.Right && a.Bottom == b.Bottom; }
    private static bool Intersects(Rect a, Rect b) { return Math.Max(a.Left, b.Left) < Math.Min(a.Right, b.Right) && Math.Max(a.Top, b.Top) < Math.Min(a.Bottom, b.Bottom); }
    private static Rect Intersection(Rect a, Rect b) { return new Rect { Left = Math.Max(a.Left, b.Left), Top = Math.Max(a.Top, b.Top), Right = Math.Min(a.Right, b.Right), Bottom = Math.Min(a.Bottom, b.Bottom) }; }
    private static string Bool(bool value) { return value ? "true" : "false"; }

    private static int RunProcessFixture(string pidText)
    {
        uint pid; if (!uint.TryParse(pidText, out pid) || pid == 0) return 1;
        IntPtr process = OpenProcess(0x101000, false, pid); if (process == IntPtr.Zero) return 1;
        FileTime created, exited, kernel, user; bool ok = GetProcessTimes(process, out created, out exited, out kernel, out user) && WaitForSingleObject(process, 0) == 258;
        CloseHandle(process); if (!ok) return 1;
        ulong started = ((ulong)created.High << 32) | created.Low;
        Print("{\"type\":\"process-fixture\",\"pid\":\"" + pid + "\",\"started\":\"" + started + "\"}"); return 0;
    }

    private static int RunPixel(string[] args)
    {
        int x, y; if (!int.TryParse(args[1], out x) || !int.TryParse(args[2], out y)) return 1;
        IntPtr dc = GetDC(IntPtr.Zero); if (dc == IntPtr.Zero) return 1;
        uint color = GetPixel(dc, x, y); ReleaseDC(IntPtr.Zero, dc);
        if (color == 0xffffffff) return 1;
        Print("{\"type\":\"pixel\",\"r\":" + (color & 255) + ",\"g\":" + ((color >> 8) & 255) + ",\"b\":" + ((color >> 16) & 255) + "}"); return 0;
    }

    private static int RunResources(string pidText)
    {
        uint pid; if (!uint.TryParse(pidText, out pid) || pid == 0) return 1;
        IntPtr process = OpenProcess(0x1000, false, pid); if (process == IntPtr.Zero) return 1;
        uint gdi = GetGuiResources(process, 0), user = GetGuiResources(process, 1); CloseHandle(process);
        Print("{\"type\":\"resources\",\"gdi\":" + gdi + ",\"user\":" + user + "}"); return 0;
    }

    private static int RunFrame(string[] args)
    {
        IntPtr hwnd, process; uint pid, thread; ulong started; Rect frame, outer;
        if (!TryIdentity(args[1], args[2], args[3], out hwnd, out pid, out started, out thread, out process)) return 1;
        CloseHandle(process);
        if (!TryFrame(hwnd, out frame) || !GetWindowRect(hwnd, out outer)) return 1;
        uint dpi = GetDpiForWindow(hwnd);
        Print("{\"type\":\"frame\",\"dwm\":{\"x\":" + frame.Left + ",\"y\":" + frame.Top + ",\"width\":" + Width(frame) + ",\"height\":" + Height(frame) +
            "},\"outer\":{\"x\":" + outer.Left + ",\"y\":" + outer.Top + ",\"width\":" + Width(outer) + ",\"height\":" + Height(outer) + "},\"dpi\":" + dpi + "}");
        return dpi > 0 ? 0 : 1;
    }

    private static bool TryProcessIdentity(uint pid, ulong started, out IntPtr process)
    {
        process = OpenProcess(0x101000, false, pid); if (process == IntPtr.Zero) return false;
        FileTime created, exited, kernel, user; ulong actual;
        if (!GetProcessTimes(process, out created, out exited, out kernel, out user) || WaitForSingleObject(process, 0) != 258) { CloseHandle(process); process = IntPtr.Zero; return false; }
        actual = ((ulong)created.High << 32) | created.Low;
        if (actual != started) { CloseHandle(process); process = IntPtr.Zero; return false; }
        return true;
    }

    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandleW(string name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern ushort RegisterClassExW(ref WindowClass cls);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr CreateWindowExW(uint ex, string cls, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr DefWindowProcW(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")] private static extern bool PeekMessageW(out Msg msg, IntPtr hwnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Msg msg);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessageW(ref Msg msg);
    [DllImport("user32.dll")] private static extern bool DestroyWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] private static extern IntPtr GetTopWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", SetLastError = true)] private static extern int GetWindowLongW(IntPtr hwnd, int index);
    [DllImport("user32.dll", SetLastError = true)] private static extern int SetWindowLongW(IntPtr hwnd, int index, int value);
    [DllImport("user32.dll")] private static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint key, byte alpha, uint flags);
    [DllImport("user32.dll")] private static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr screenDc, ref Point destination, ref Size size, IntPtr sourceDc, ref Point source, uint colorKey, ref BlendFunction blend, uint flags);
    [DllImport("user32.dll")] private static extern int SetWindowRgn(IntPtr hwnd, IntPtr region, bool redraw);
    [DllImport("user32.dll", SetLastError = true)] private static extern int GetWindowRgn(IntPtr hwnd, IntPtr region);
    [DllImport("user32.dll")] private static extern bool InvalidateRect(IntPtr hwnd, IntPtr rect, bool erase);
    [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] private static extern IntPtr SetCapture(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern IntPtr GetCapture();
    [DllImport("user32.dll")] private static extern bool ReleaseCapture();
    [DllImport("user32.dll", SetLastError = true)] private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll")] private static extern IntPtr LoadCursorW(IntPtr instance, IntPtr name);
    [DllImport("user32.dll")] private static extern IntPtr BeginPaint(IntPtr hwnd, ref PaintStruct paint);
    [DllImport("user32.dll")] private static extern bool EndPaint(IntPtr hwnd, ref PaintStruct paint);
    [DllImport("user32.dll")] private static extern int FillRect(IntPtr dc, ref Rect rect, IntPtr brush);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateSolidBrush(uint color);
    [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr dc, IntPtr value);
    [DllImport("gdi32.dll")] private static extern IntPtr CreatePen(int style, int width, uint color);
    [DllImport("gdi32.dll")] private static extern bool MoveToEx(IntPtr dc, int x, int y, IntPtr old);
    [DllImport("gdi32.dll")] private static extern bool LineTo(IntPtr dc, int x, int y);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateEllipticRgn(int left, int top, int right, int bottom);
    [DllImport("gdi32.dll")] private static extern int CombineRgn(IntPtr dest, IntPtr first, IntPtr second, int mode);
    [DllImport("gdi32.dll")] private static extern bool EqualRgn(IntPtr first, IntPtr second);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr value);
    [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateDIBSection(IntPtr dc, ref BitmapInfo info, uint usage, out IntPtr bits, IntPtr section, uint offset);
    [DllImport("gdi32.dll")] private static extern uint GetPixel(IntPtr dc, int x, int y);
    [DllImport("user32.dll")] private static extern uint GetGuiResources(IntPtr process, uint flags);
    [DllImport("d2d1.dll")] private static extern int D2D1CreateFactory(int factoryType, [In] ref Guid iid, IntPtr options, [MarshalAs(UnmanagedType.Interface)] out ID2D1Factory factory);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out Rect value, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] private static extern int DwmGetWindowAttributeInt(IntPtr hwnd, int attribute, out int value, int size);
    [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
    [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] private static extern bool GetProcessTimes(IntPtr process, out FileTime created, out FileTime exited, out FileTime kernel, out FileTime user);
    [DllImport("kernel32.dll")] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] private static extern void SetLastError(int error);
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr module, WinEventProc callback, uint processId, uint threadId, uint flags);
    [DllImport("user32.dll")] private static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] private static extern void PostQuitMessage(int exitCode);
}
