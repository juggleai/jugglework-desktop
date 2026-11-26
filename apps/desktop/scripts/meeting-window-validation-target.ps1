# Dedicated self-controlled target; never accepts an external HWND or input command.
param([int]$InitialX = 64, [int]$InitialY = 64)
$ErrorActionPreference = 'Stop'
try {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Threading;
public class ValidationTarget {
 [StructLayout(LayoutKind.Sequential)] struct Msg { public IntPtr h; public uint m; public UIntPtr w; public IntPtr l; public uint t; public int x,y; public uint p; }
 delegate IntPtr Proc(IntPtr h,uint m,IntPtr w,IntPtr l);
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Cls { public uint s; public Proc p; public int a,b; public IntPtr i,icon,cursor,bg; public string menu,name; }
 static Proc callback = Dispatch;
 static IntPtr targetWindow;
 static IntPtr sampledCanvas;
 static IntPtr cover;
 static int coverClicks;
 static bool resizeObserve;
 static int sizeEnter, sizeExit, sizeRight, sizeBottomRight;
 static bool coverGuide;
 static int sampleBoth, sampleOne, sampleNeither;
 static int sampleChanging;
 static bool suppressSampleOrder;
 static int clicks, mouseActivate, active, clickActive, inactive, zOrder;
 static bool observeActivation;
 static string guidance = "";
 static IntPtr Dispatch(IntPtr h,uint m,IntPtr w,IntPtr l) {
  if(h==targetWindow && resizeObserve) {
   if(m==0x0231) sizeEnter++;
   if(m==0x0214 && w.ToInt64()==2) sizeRight++; // WM_SIZING, WMSZ_RIGHT
   if(m==0x0214 && w.ToInt64()==8) sizeBottomRight++; // WMSZ_BOTTOMRIGHT
   if(m==0x0232) sizeExit++;
  }
  if(h==sampledCanvas && m==0x0046) {
   sampleChanging++;
   // Deliberate negative control on this process's own disposable sample.
   // WINDOWPOS is writable during WM_WINDOWPOSCHANGING, not after return.
   if(suppressSampleOrder && l!=IntPtr.Zero) {
    int offset=IntPtr.Size*2+16;
    Marshal.WriteInt32(l,offset,Marshal.ReadInt32(l,offset)|4); // SWP_NOZORDER
   }
  }
  if(h==sampledCanvas && m==0x0047) {
   bool next=GetWindow(h,2)==targetWindow, previous=GetWindow(targetWindow,3)==h;
   if(next && previous) sampleBoth++; else if(next || previous) sampleOne++; else sampleNeither++;
  }
   if(h==targetWindow && m==0x0201) clicks++;
   if(h==cover && m==0x0201) coverClicks++;
   if(h==cover && m==0x000f && coverGuide) {
    IntPtr result=DefWindowProcW(h,m,w,l), dc=GetDC(h);
    string label="\u906e\u6321\u7a97\uff1a\u70b9\u8fd9\u91cc 3 \u6b21";
    if(dc!=IntPtr.Zero) { try { TextOutW(dc,8,24,label,label.Length); } finally { ReleaseDC(h,dc); } }
    return result;
   }
  if(h==targetWindow && observeActivation) {
   if(m==0x0021) mouseActivate++; // WM_MOUSEACTIVATE, not a click count.
   if(m==0x0006) {
    long kind=w.ToInt64() & 0xffff;
    if(kind==0) inactive++;
    else if(kind==1 || kind==2) { active++; if(kind==2) clickActive++; }
   }
   // WINDOWPOS.flags follows two pointers and four integers on x64 and x86.
   if(m==0x0047 && l!=IntPtr.Zero && (Marshal.ReadInt32(l, IntPtr.Size*2+16) & 4)==0) zOrder++;
  }
  if(h==targetWindow && m==0x000f && guidance.Length!=0) {
   // Let the default procedure paint/validate first; draw on the target's own
   // client area without an extra HWND that could change hit testing or Z order.
   IntPtr result=DefWindowProcW(h,m,w,l), dc=GetDC(h);
   if(dc!=IntPtr.Zero) { try { TextOutW(dc,56,64,guidance,guidance.Length); } finally { ReleaseDC(h,dc); } }
   return result;
  }
  return DefWindowProcW(h,m,w,l);
 }
 static void Print(string s) { Console.WriteLine(s); Console.Out.Flush(); }
  public static int Run(int initialX, int initialY) {
   IntPtr old=SetThreadDpiAwarenessContext(new IntPtr(-4)), hwnd=IntPtr.Zero, boundary=IntPtr.Zero, sampler=IntPtr.Zero;
  if(old==IntPtr.Zero) return 1;
  var q=new ConcurrentQueue<string>(); bool eof=false;
  var reader=new Thread(()=>{try{string s;while((s=Console.ReadLine())!=null)q.Enqueue(s);}finally{Volatile.Write(ref eof,true);}});reader.IsBackground=true;reader.Start();
   int x=initialX,y=initialY,w=656,h=439,motion=0,moveInterval=20; bool cleanupFailed=false,fastMotion=false;
  try {
   ImmDisableIME(uint.MaxValue); // This fixture process only, never the Electron host.
   string nonce=Guid.NewGuid().ToString("N"); var cls=new Cls{p=callback,i=GetModuleHandleW(null),name="Validation"+nonce,bg=new IntPtr(6)};
   if(RegisterClassW(ref cls)==0)return 1;
    hwnd=CreateWindowExW(0,cls.name,"Synthetic validation "+nonce,0x00cf0000, x,y,w,h,IntPtr.Zero,IntPtr.Zero,cls.i,IntPtr.Zero);
    targetWindow=hwnd;
   if(hwnd==IntPtr.Zero || !SetWindowPos(hwnd,IntPtr.Zero,x,y,w,h,0x0057))return 1;
   // Private protocol: only the parent retains this identity, never forward it as diagnostics.
   Print("{\"type\":\"ready\",\"hwnd\":\""+hwnd.ToInt64().ToString()+"\"}");
   var clock=System.Diagnostics.Stopwatch.StartNew(); bool done=false; long nextMove=0;
   while(!done && !Volatile.Read(ref eof) && clock.ElapsedMilliseconds<30000) {
    Msg msg;for(int n=0;n<64 && PeekMessageW(out msg,IntPtr.Zero,0,0,1);n++)DispatchMessageW(ref msg);
    string cmd;while(q.TryDequeue(out cmd)) {
     bool ok=true;
     if(cmd=="process-exit" || cmd=="exit") done=true;
     else if(cmd=="close-window") { ok=hwnd!=IntPtr.Zero && DestroyWindow(hwnd);if(ok)hwnd=IntPtr.Zero;else cleanupFailed=true; }
      else if(cmd=="ping") { }
      else if(cmd=="input-count") Print("{\"type\":\"input-count\",\"clicks\":"+clicks+"}");
       else if(hwnd==IntPtr.Zero)ok=false;
       else if(cmd=="activation-observe-start") { mouseActivate=active=clickActive=inactive=zOrder=0;observeActivation=true; }
       else if(cmd=="activation-observe-stop") {
        observeActivation=false;
        Print("{\"type\":\"activation-observed\",\"mouseActivate\":"+mouseActivate+",\"active\":"+active+",\"clickActive\":"+clickActive+",\"inactive\":"+inactive+",\"zOrder\":"+zOrder+"}");
       }
      else if(cmd=="pointer-guide" || cmd=="no-input-guide" || cmd=="clear-guide") {
       guidance=cmd=="pointer-guide" ? "\u6307\u9488\uff1a\u5728\u8fd9\u91cc\u70b9\u51fb 3 \u6b21" : cmd=="no-input-guide" ? "\u7a7a\u8dd1\uff1a\u8bf7\u52ff\u70b9\u51fb" : "";
       ok=InvalidateRect(hwnd,IntPtr.Zero,true);
      }
      else if(cmd=="activate") ok=SetForegroundWindow(hwnd);
       else if(cmd=="foreground-check") ok=GetForegroundWindow()==hwnd;
       else if(cmd=="resize-observe" || cmd=="resize-guide" || cmd=="corner-guide") {
        sizeEnter=sizeExit=sizeRight=sizeBottomRight=0;resizeObserve=true;
        guidance=cmd=="resize-guide" ? "\u62d6\u52a8\u53f3\u8fb9\u6846\uff1a\u5411\u53f3\u62d6\u4e00\u6bb5\u540e\u677e\u624b" : cmd=="corner-guide" ? "\u62d6\u52a8\u53f3\u4e0b\u89d2\uff1a\u5411\u53f3\u4e0b\u62d6\u4e00\u6bb5\u540e\u677e\u624b" : "";
        ok=InvalidateRect(hwnd,IntPtr.Zero,true);
       }
       else if(cmd=="resize-state") {
        resizeObserve=false; guidance=""; InvalidateRect(hwnd,IntPtr.Zero,true);
        Rect box;ok=GetWindowRect(hwnd,out box);
        if(ok) { x=box.left;y=box.top;w=box.right-x;h=box.bottom-y;
         Print("{\"type\":\"resize-state\",\"enter\":"+sizeEnter+",\"exit\":"+sizeExit+",\"right\":"+sizeRight+",\"bottomRight\":"+sizeBottomRight+",\"width\":"+w+",\"height\":"+h+"}"); }
       }
       else if(cmd=="cover-start" && cover==IntPtr.Zero) {
        coverClicks=0;coverGuide=false;
        cover=CreateWindowExW(0x80,cls.name,"",0x80000000,x+64,y+112,160,80,IntPtr.Zero,IntPtr.Zero,cls.i,IntPtr.Zero);
        ok=cover!=IntPtr.Zero && SetWindowPos(cover,IntPtr.Zero,0,0,0,0,0x0053);
       }
       else if(cmd=="cover-hide" && cover!=IntPtr.Zero) { ShowWindow(cover,0);ok=!IsWindowVisible(cover); }
       else if(cmd=="cover-identity" && cover!=IntPtr.Zero) { Print("{\"type\":\"cover-identity\",\"hwnd\":\""+unchecked((ulong)cover.ToInt64())+"\"}"); }
       else if(cmd=="cover-guide" && cover!=IntPtr.Zero) { coverGuide=true;ok=InvalidateRect(cover,IntPtr.Zero,true); }
       else if(cmd=="cover-check" && cover!=IntPtr.Zero) {
        IntPtr covered=WindowFromPoint(new Pt{x=x+110,y=y+150}), clear=WindowFromPoint(new Pt{x=x+270,y=y+150});
        Print("{\"type\":\"cover-state\",\"ordinary\":"+Bool((GetWindowLongW(cover,-20)&8)==0)+
         ",\"coveredHitsCover\":"+Bool(covered==cover)+",\"coveredHitsTarget\":"+Bool(covered==hwnd)+
         ",\"clearHitsTarget\":"+Bool(clear==hwnd)+",\"coverClicks\":"+coverClicks+",\"targetClicks\":"+clicks+"}");
       }
       else if(cmd=="cover-stop" && cover!=IntPtr.Zero) { ok=DestroyWindow(cover); if(ok)cover=IntPtr.Zero;else cleanupFailed=true; }
       else if(cmd=="sync-sample" && sampler==IntPtr.Zero) {
        // Independent Win32 baseline. No Electron hook, external HWND or pointer decoding.
        sampler=CreateWindowExW(0x08000080,cls.name,"",0x80000000,0,0,1,1,IntPtr.Zero,IntPtr.Zero,cls.i,IntPtr.Zero);
        sampledCanvas=sampler;
        bool knownBelow=sampler!=IntPtr.Zero && SetWindowPos(sampler,hwnd,0,0,0,0,0x0213) && GetWindow(hwnd,2)==sampler;
        int below=sampleNeither;
        sampleBoth=sampleOne=sampleNeither=0;
        IntPtr predecessor=GetWindow(hwnd,3);
        IntPtr anchor=predecessor!=IntPtr.Zero && (GetWindowLongW(predecessor,-20)&8)!=0 ? IntPtr.Zero : predecessor;
        sampleChanging=0;
        bool suppressedCall;
        suppressSampleOrder=true;
        try { suppressedCall=knownBelow && SetWindowPos(sampler,anchor,0,0,0,0,0x0213); }
        finally { suppressSampleOrder=false; }
        bool suppressedStillBelow=GetWindow(hwnd,2)==sampler && GetWindow(sampler,3)==hwnd;
        int suppressedChanging=sampleChanging, suppressedChanged=sampleBoth+sampleOne+sampleNeither;
        sampleBoth=sampleOne=sampleNeither=0;
        bool adjacent=knownBelow && SetWindowPos(sampler,anchor,0,0,0,0,0x0213) && GetWindow(sampler,2)==hwnd && GetWindow(hwnd,3)==sampler;
        int both=sampleBoth, one=sampleOne, neither=sampleNeither;
        sampleBoth=sampleOne=sampleNeither=0;
        bool unchanged=adjacent && GetWindow(sampler,2)==hwnd && GetWindow(hwnd,3)==sampler;
        int noWriteMessages=sampleBoth+sampleOne+sampleNeither;
        // Deliberate second write to our own window: confirm that the message
        // evidence distinguishes a sampled adjacency from a later displacement.
         bool displaced=unchanged && SetWindowPos(sampler,hwnd,0,0,0,0,0x0213) && GetWindow(hwnd,2)==sampler;
         int displacedNeither=sampleNeither;
         // Distinguish this deliberately injected cancellation from an ordinary
         // write. This flag combination is exercised only on the native sample.
         sampleChanging=sampleBoth=sampleOne=sampleNeither=0;
         bool bypassAdjacent;
         suppressSampleOrder=true;
         try {
          bypassAdjacent=displaced && GetWindow(hwnd,3)==predecessor &&
           SetWindowPos(sampler,anchor,0,0,0,0,0x0613) && // NOSENDCHANGING plus the regular flags
           GetWindow(sampler,2)==hwnd && GetWindow(hwnd,3)==sampler;
         } finally { suppressSampleOrder=false; }
         Print("{\"type\":\"sync-sample-result\",\"knownBelow\":"+(knownBelow?"true":"false")+",\"belowNeither\":"+below+
         ",\"adjacent\":"+(adjacent?"true":"false")+",\"both\":"+both+",\"one\":"+one+",\"neither\":"+neither+
         ",\"unchanged\":"+(unchanged?"true":"false")+",\"noWriteMessages\":"+noWriteMessages+
         ",\"displaced\":"+(displaced?"true":"false")+",\"displacedNeither\":"+displacedNeither+
         ",\"suppressedCall\":"+(suppressedCall?"true":"false")+",\"suppressedStillBelow\":"+(suppressedStillBelow?"true":"false")+
          ",\"suppressedChanging\":"+suppressedChanging+",\"suppressedChanged\":"+suppressedChanged+
          ",\"bypassAdjacent\":"+(bypassAdjacent?"true":"false")+",\"bypassChanging\":"+sampleChanging+",\"bypassBoth\":"+sampleBoth+"}");
        sampledCanvas=IntPtr.Zero;
        ok=sampler!=IntPtr.Zero && DestroyWindow(sampler); if(ok)sampler=IntPtr.Zero;else cleanupFailed=true;
       }
       else if(cmd=="boundary-start" && boundary==IntPtr.Zero) {
        // An off-target, non-activating sentinel only. Never promote the target or canvas.
        boundary=CreateWindowExW(0x08000088,cls.name,"",0x80000000,0,0,1,1,IntPtr.Zero,IntPtr.Zero,cls.i,IntPtr.Zero);
        ok=boundary!=IntPtr.Zero && SetForegroundWindow(hwnd) && SetWindowPos(boundary,new IntPtr(-1),0,0,0,0,0x0053);
       }
       else if(cmd=="boundary-check") {
        IntPtr above=GetWindow(hwnd,3);
        bool topmostAbove=above!=IntPtr.Zero && (GetWindowLongW(above,-20)&8)!=0;
        Print("{\"type\":\"boundary-state\",\"topmostAbove\":"+(topmostAbove?"true":"false")+
         ",\"sentinelAbove\":"+(above==boundary && boundary!=IntPtr.Zero?"true":"false")+"}");
       }
       else if(cmd=="boundary-stop") { ok=boundary!=IntPtr.Zero && DestroyWindow(boundary);if(ok)boundary=IntPtr.Zero;else cleanupFailed=true; }
      else if(cmd=="raise-own") ok=SetWindowPos(hwnd,IntPtr.Zero,0,0,0,0,0x0013); // ordinary HWND_TOP, no activation or geometry change
     else if(cmd=="minimize") ShowWindowAsync(hwnd,6);
     else if(cmd=="restore") ShowWindowAsync(hwnd,4);
     else if(cmd=="motion" || cmd=="motion-fast") { fastMotion=cmd=="motion-fast";motion=fastMotion?200:50;moveInterval=fastMotion?2:20;nextMove=clock.ElapsedMilliseconds; }
      else { if(cmd=="move"){x+=24;y+=16;}else if(cmd=="width")w+=48;else if(cmd=="height")h+=32;else if(cmd=="both-axes"){w+=48;h+=32;}else ok=false;
      if(ok)ok=SetWindowPos(hwnd,IntPtr.Zero,x,y,w,h,0x0014); }
     Print("{\"type\":\"ack\",\"action\":\""+cmd+"\",\"ok\":"+(ok?"true":"false")+"}");
    }
    if(motion>0 && hwnd!=IntPtr.Zero && clock.ElapsedMilliseconds>=nextMove) {
     x+=fastMotion?(motion%2==0?1:-1):1; if(!SetWindowPos(hwnd,IntPtr.Zero,x,y,w,h,0x0014))return 1;
     motion--;nextMove=clock.ElapsedMilliseconds+moveInterval;
     if(motion==0)Print("{\"type\":\"motion-done\"}");
    }
    Thread.Sleep(5);
   }
   return clock.ElapsedMilliseconds<30000 && !cleanupFailed?0:1;
    } finally { sampledCanvas=IntPtr.Zero;bool coverClean=cover==IntPtr.Zero || DestroyWindow(cover);bool sampleClean=sampler==IntPtr.Zero || DestroyWindow(sampler);bool auxiliary=boundary==IntPtr.Zero || DestroyWindow(boundary);bool ok=(hwnd==IntPtr.Zero || DestroyWindow(hwnd)) && auxiliary && sampleClean && coverClean;SetThreadDpiAwarenessContext(old);Print("{\"type\":\"cleanup\",\"destroyed\":"+(ok?"true":"false")+"}");if(!ok)throw new InvalidOperationException(); }
 }
 [DllImport("user32.dll")]static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
 [DllImport("imm32.dll")]static extern bool ImmDisableIME(uint t);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern IntPtr GetModuleHandleW(string s);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern ushort RegisterClassW(ref Cls c);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern IntPtr CreateWindowExW(uint e,string c,string t,uint s,int x,int y,int w,int h,IntPtr p,IntPtr m,IntPtr i,IntPtr a);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern IntPtr DefWindowProcW(IntPtr h,uint m,IntPtr w,IntPtr l);
 [DllImport("user32.dll")]static extern bool PeekMessageW(out Msg m,IntPtr h,uint a,uint b,uint f);
 [DllImport("user32.dll")]static extern IntPtr DispatchMessageW(ref Msg m);
 [DllImport("user32.dll")]static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int w,int z,uint f);
 [DllImport("user32.dll")]static extern bool DestroyWindow(IntPtr h);
 [DllImport("user32.dll")]static extern bool ShowWindowAsync(IntPtr h,int c);
 [DllImport("user32.dll")]static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
 static string Bool(bool value) { return value?"true":"false"; }
 [StructLayout(LayoutKind.Sequential)] struct Pt {public int x,y;}
 [StructLayout(LayoutKind.Sequential)] struct Rect {public int left,top,right,bottom;}
 [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr h,out Rect rect);
 [DllImport("user32.dll")]static extern IntPtr WindowFromPoint(Pt pt);
 [DllImport("user32.dll")]static extern bool ShowWindow(IntPtr h,int mode);
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")]static extern IntPtr GetWindow(IntPtr h,uint command);
 [DllImport("user32.dll")]static extern int GetWindowLongW(IntPtr h,int index);
 [DllImport("user32.dll")]static extern bool InvalidateRect(IntPtr h,IntPtr rect,bool erase);
 [DllImport("user32.dll")]static extern IntPtr GetDC(IntPtr h);
 [DllImport("user32.dll")]static extern int ReleaseDC(IntPtr h,IntPtr dc);
 [DllImport("gdi32.dll",CharSet=CharSet.Unicode)]static extern bool TextOutW(IntPtr dc,int x,int y,string text,int length);
}
'@
exit ([ValidationTarget]::Run($InitialX, $InitialY))
} catch { exit 1 }
