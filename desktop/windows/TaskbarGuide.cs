// SPDX-License-Identifier: GPL-3.0-only
using System;
using System.Drawing;
using System.Windows.Forms;

internal sealed class TaskbarGuide : Form
{
    internal static readonly Color Accent = Color.FromArgb(145, 174, 250);
    private readonly Label progress = new Label();
    private readonly Label title = new Label();
    private readonly Label instructions = new Label();
    private readonly Font titleFont;

    internal TaskbarGuide(Font font, Action skipGuide)
    {
        Text = "任务栏播放引导";
        StartPosition = FormStartPosition.Manual;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        AutoScaleDimensions = new SizeF(96, 96);
        AutoScaleMode = AutoScaleMode.Dpi;
        Font = font;
        ClientSize = new Size(312, 160);
        BackColor = Accent;
        ForeColor = Color.White;
        Padding = new Padding(2);

        var content = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            BackColor = Color.FromArgb(27, 32, 48),
            Padding = new Padding(14, 12, 14, 10),
            ColumnCount = 1,
            RowCount = 4
        };
        content.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        content.RowStyles.Add(new RowStyle(SizeType.Absolute, 22));
        content.RowStyles.Add(new RowStyle(SizeType.Absolute, 27));
        content.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        content.RowStyles.Add(new RowStyle(SizeType.Absolute, 32));

        progress.Dock = title.Dock = instructions.Dock = DockStyle.Fill;
        progress.Margin = title.Margin = instructions.Margin = Padding.Empty;
        progress.ForeColor = Accent;
        titleFont = new Font(Font.FontFamily, 12F, FontStyle.Bold);
        title.Font = titleFont;
        content.Controls.Add(progress, 0, 0);
        content.Controls.Add(title, 0, 1);
        content.Controls.Add(instructions, 0, 2);

        var skip = new Button
        {
            Text = "跳过引导",
            Anchor = AnchorStyles.Right,
            Size = new Size(84, 30),
            Margin = Padding.Empty,
            BackColor = Color.FromArgb(49, 52, 68),
            UseVisualStyleBackColor = false
        };
        skip.Click += delegate { skipGuide(); };
        content.Controls.Add(skip, 0, 3);
        Controls.Add(content);
        CancelButton = skip;
        FormClosing += delegate(object sender, FormClosingEventArgs args)
        {
            if (args.CloseReason != CloseReason.UserClosing) return;
            args.Cancel = true;
            skipGuide();
        };
    }

    protected override bool ShowWithoutActivation { get { return true; } }

    internal void SetStep(int number, string heading, string message)
    {
        progress.Text = "任务栏播放   " + number + " / 4";
        title.Text = heading;
        instructions.Text = message;
    }

    internal void Follow(Form owner, Rectangle anchor, bool beside = false, bool above = false)
    {
        Location = Position(owner, anchor, beside, above);
        if (Visible) return;
        Show(owner);
        Location = Position(owner, anchor, beside, above);
    }

    private Point Position(Form owner, Rectangle anchor, bool beside, bool above)
    {
        Rectangle area = Screen.FromRectangle(anchor).WorkingArea;
        int gap = 8 * owner.DeviceDpi / 96;
        int x = beside ? anchor.Right - Width : anchor.Left;
        int y = anchor.Bottom + gap;
        if (beside && anchor.Right + gap + Width <= area.Right)
        {
            x = anchor.Right + gap;
            y = anchor.Top;
        }
        else if (beside && anchor.Left - gap - Width >= area.Left)
        {
            x = anchor.Left - gap - Width;
            y = anchor.Top;
        }
        else if ((above && anchor.Top - gap - Height >= area.Top) || y + Height > area.Bottom)
        {
            y = anchor.Top - gap - Height;
        }
        return new Point(Math.Max(area.Left, Math.Min(x, area.Right - Width)),
            Math.Max(area.Top, Math.Min(y, area.Bottom - Height)));
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing && titleFont != null) titleFont.Dispose();
    }
}
