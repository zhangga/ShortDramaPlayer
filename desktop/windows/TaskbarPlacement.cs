// SPDX-License-Identifier: GPL-3.0-only
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Automation;

internal static class TaskbarPlacement
{
    private const uint GetState = 4;
    private const uint GetPosition = 5;
    private const uint AutoHide = 1;

    public static Rectangle Find()
    {
        var data = new AppBarData { Size = (uint)Marshal.SizeOf(typeof(AppBarData)) };
        if ((SHAppBarMessage(GetState, ref data).ToUInt64() & AutoHide) != 0
            || SHAppBarMessage(GetPosition, ref data) == UIntPtr.Zero)
        {
            return Rectangle.Empty;
        }

        Rectangle bar = Rectangle.FromLTRB(data.Rect.Left, data.Rect.Top, data.Rect.Right, data.Rect.Bottom);
        if (bar.Height < 24 || bar.Width < 4 * bar.Height) return Rectangle.Empty;
        IntPtr taskbar = FindWindow("Shell_TrayWnd", null);
        if (taskbar == IntPtr.Zero) return Rectangle.Empty;

        try
        {
            AutomationElement root = AutomationElement.FromHandle(taskbar);
            var controls = new OrCondition(
                Is(ControlType.Button), Is(ControlType.MenuItem), Is(ControlType.TabItem),
                Is(ControlType.CheckBox), Is(ControlType.RadioButton), Is(ControlType.Hyperlink),
                Is(ControlType.Edit), Is(ControlType.ComboBox), Is(ControlType.SplitButton),
                Is(ControlType.Text));
            var cache = new CacheRequest();
            cache.Add(AutomationElement.BoundingRectangleProperty);
            cache.Add(AutomationElement.IsOffscreenProperty);
            var occupied = new List<Rectangle>();
            using (cache.Activate())
            {
                foreach (AutomationElement element in root.FindAll(TreeScope.Descendants, controls))
                {
                    var bounds = element.Cached.BoundingRectangle;
                    if (element.Cached.IsOffscreen || bounds.IsEmpty) continue;
                    var rect = Rectangle.Intersect(bar, Rectangle.FromLTRB(
                        (int)Math.Floor(bounds.Left), (int)Math.Floor(bounds.Top),
                        (int)Math.Ceiling(bounds.Right), (int)Math.Ceiling(bounds.Bottom)));
                    if (rect.Width > 0 && rect.Height > 0) occupied.Add(rect);
                }
            }
            return occupied.Count == 0 ? Rectangle.Empty : FindGap(bar, occupied);
        }
        catch (ElementNotAvailableException) { return Rectangle.Empty; }
        catch (ArgumentException) { return Rectangle.Empty; }
        catch (COMException) { return Rectangle.Empty; }
        catch (InvalidOperationException) { return Rectangle.Empty; }
    }

    internal static Rectangle FindGap(Rectangle bar, List<Rectangle> occupied)
    {
        int gap = Math.Max(5, bar.Height / 6);
        int cursor = bar.Left + gap;
        var best = Rectangle.Empty;

        // Use the widest measured gap and prefer the rightmost one on a tie.
        occupied.Sort((left, right) => left.Left.CompareTo(right.Left));
        foreach (Rectangle rect in occupied)
        {
            int end = rect.Left - gap;
            if (end > cursor && end - cursor >= best.Width)
            {
                best = Rectangle.FromLTRB(cursor, bar.Top, end, bar.Bottom);
            }
            cursor = Math.Max(cursor, rect.Right + gap);
        }
        int rightEdge = bar.Right - gap;
        if (rightEdge > cursor && rightEdge - cursor >= best.Width)
        {
            best = Rectangle.FromLTRB(cursor, bar.Top, rightEdge, bar.Bottom);
        }
        return best.Width >= Math.Max(40, bar.Height) ? best : Rectangle.Empty;
    }

    public static Rectangle FitAbove(Rectangle area, Rectangle slot, double aspect, double zoom)
    {
        double height = Math.Min(area.Height, area.Width / aspect) * zoom;
        int pixelHeight = Math.Max(1, (int)Math.Round(height));
        int pixelWidth = Math.Max(1, (int)Math.Round(height * aspect));
        int right = Math.Min(area.Right, Math.Max(area.Left + pixelWidth, slot.Right));
        int top = slot.Bottom <= area.Top ? area.Top : area.Bottom - pixelHeight;
        return new Rectangle(right - pixelWidth, top, pixelWidth, pixelHeight);
    }

    private static Condition Is(ControlType type)
    {
        return new PropertyCondition(AutomationElement.ControlTypeProperty, type);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect
    {
        public int Left, Top, Right, Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct AppBarData
    {
        public uint Size;
        public IntPtr Window;
        public uint CallbackMessage, Edge;
        public NativeRect Rect;
        public IntPtr Param;
    }

    [DllImport("shell32.dll")]
    private static extern UIntPtr SHAppBarMessage(uint message, ref AppBarData data);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindow(string className, string name);
}
