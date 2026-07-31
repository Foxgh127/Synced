using System.Buffers.Binary;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.Marshalling;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;
using NAudio.CoreAudioApi;
using NAudio.CoreAudioApi.Interfaces;
using NAudio.Wave;

namespace Synced.AudioCapture;

internal sealed class StatusPayload
{
    public required string Type { get; init; }
    public string? Message { get; init; }
    public bool? Ok { get; init; }
    public uint? ProcessId { get; init; }
    public int? SampleRate { get; init; }
    public int? Channels { get; init; }
    public int? BitsPerSample { get; init; }
    public int? LatencyMs { get; init; }
    public int? Left { get; init; }
    public int? Top { get; init; }
    public int? Width { get; init; }
    public int? Height { get; init; }
    public bool? Visible { get; init; }
    public bool? Foreground { get; init; }
    public bool? Minimized { get; init; }
    public string? Stage { get; init; }
    public long? DroppedPackets { get; init; }
    public int? QueueDepth { get; init; }
    public int? QueueCapacityPackets { get; init; }
    public int? BlockDurationMs { get; init; }
}

internal sealed record AudioPacket(
    byte[] Pcm,
    long DevicePosition,
    long QpcPosition,
    long Sequence
);

internal sealed class WindowProcessPayload
{
    public required string Handle { get; init; }
    public uint? ProcessId { get; init; }
    public string? ProcessName { get; init; }
    public string? ExecutableName { get; init; }
    public string? ClassName { get; init; }
    public string? OwnerHandle { get; init; }
}

internal sealed class WindowProcessBatchPayload
{
    public required List<WindowProcessPayload> Windows { get; init; }
}

internal sealed class ProcessPayload
{
    public required uint ProcessId { get; init; }
    public string? ProcessName { get; init; }
    public string? ExecutableName { get; init; }
}

internal sealed class ProcessBatchPayload
{
    public required List<ProcessPayload> Processes { get; init; }
}

[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
)]
[JsonSerializable(typeof(StatusPayload))]
[JsonSerializable(typeof(WindowProcessBatchPayload))]
[JsonSerializable(typeof(ProcessBatchPayload))]
internal partial class StatusJsonContext : JsonSerializerContext;

[GeneratedComClass]
internal sealed partial class AudioEndpointNotificationClient : IMMNotificationClient
{
    private readonly string initialDeviceId;
    private readonly Action<string> notifyChanged;

    public AudioEndpointNotificationClient(
        string initialDeviceId,
        Action<string> notifyChanged
    )
    {
        this.initialDeviceId = initialDeviceId;
        this.notifyChanged = notifyChanged;
    }

    public void OnDeviceStateChanged(string deviceId, DeviceState newState)
    {
        if (
            string.Equals(deviceId, initialDeviceId, StringComparison.OrdinalIgnoreCase) &&
            newState != DeviceState.Active
        )
        {
            notifyChanged("当前输出设备已不可用");
        }
    }

    public void OnDeviceAdded(string deviceId) { }

    public void OnDeviceRemoved(string deviceId)
    {
        if (string.Equals(deviceId, initialDeviceId, StringComparison.OrdinalIgnoreCase))
        {
            notifyChanged("当前输出设备已移除");
        }
    }

    public void OnDefaultDeviceChanged(
        DataFlow flow,
        Role role,
        string defaultDeviceId
    )
    {
        if (
            flow == DataFlow.Render &&
            !string.Equals(
                defaultDeviceId,
                initialDeviceId,
                StringComparison.OrdinalIgnoreCase
            )
        )
        {
            notifyChanged("Windows 默认输出设备已切换");
        }
    }

    public void OnPropertyValueChanged(string deviceId, PropertyKey key) { }
}

internal static class Program
{
    private const int SampleRate = 48_000;
    private const int Channels = 2;
    private const int BitsPerSample = 16;
    private const ushort AudioPacketVersion = 1;
    private const ushort AudioPacketHeaderBytes = 32;
    private const int AudioBlockDurationMs = 20;
    private const int AudioQueueCapacityPackets = 50;
    private static readonly byte[] AudioPacketMagic = "YQAP"u8.ToArray();
    private static readonly long QpcToUnix100Nanoseconds =
        DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() * 10_000L -
        CurrentQpc100Nanoseconds();
    private static readonly object StatusLock = new();

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativePoint
    {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(nint windowHandle, out uint processId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetClientRect(nint windowHandle, out NativeRect rect);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ClientToScreen(nint windowHandle, ref NativePoint point);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(nint windowHandle);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(nint windowHandle);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsIconic(nint windowHandle);

    [DllImport("user32.dll")]
    private static extern nint GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(
        nint windowHandle,
        StringBuilder className,
        int maximumCount
    );

    [DllImport("user32.dll")]
    private static extern nint GetWindow(nint windowHandle, uint command);

    private static async Task<int> Main(string[] args)
    {
        try
        {
            if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 19041))
            {
                return Fail("需要 Windows 10 2004（内部版本 19041）或更高版本");
            }

            if (
                args.Length != 2 ||
                args[0] is not (
                    "--capture-window" or
                    "--capture-process" or
                    "--probe-window" or
                    "--probe-process" or
                    "--inspect-windows" or
                    "--inspect-processes"
                )
            )
            {
                return Fail(
                    "用法：Synced.AudioCapture --capture-window <窗口句柄> 或 --capture-process <进程 ID>"
                );
            }

            if (args[0] == "--inspect-windows")
            {
                WriteWindowProcessBatch(args[1]);
                return 0;
            }

            if (args[0] == "--inspect-processes")
            {
                WriteProcessBatch(args[1]);
                return 0;
            }

            var processMode =
                args[0] is "--capture-process" or "--probe-process";
            var windowHandle = nint.Zero;
            uint processId;
            if (processMode)
            {
                if (
                    !uint.TryParse(
                        args[1],
                        NumberStyles.Integer,
                        CultureInfo.InvariantCulture,
                        out processId
                    ) ||
                    processId == 0
                )
                {
                    return Fail("进程 ID 格式无效");
                }
                try
                {
                    using var process = Process.GetProcessById(
                        checked((int)processId)
                    );
                    if (process.HasExited)
                    {
                        return Fail("所选音乐应用已经退出");
                    }
                }
                catch (
                    Exception error
                ) when (
                    error is ArgumentException or
                    InvalidOperationException or
                    OverflowException
                )
                {
                    return Fail("所选音乐应用已经退出");
                }
            }
            else
            {
                if (!TryParseWindowHandle(args[1], out windowHandle))
                {
                    return Fail("窗口句柄格式无效");
                }
                if (
                    GetWindowThreadProcessId(windowHandle, out processId) == 0 ||
                    processId == 0
                )
                {
                    return Fail("所选窗口已经关闭，无法定位它的声音进程");
                }
            }

            if (args[0] is "--probe-window" or "--probe-process")
            {
                WriteStatus(new StatusPayload
                {
                    Type = "probe",
                    Ok = true,
                    ProcessId = processId,
                    SampleRate = SampleRate,
                    Channels = Channels,
                    BitsPerSample = BitsPerSample,
                });
                return 0;
            }

            using var endpointEnumerator = new MMDeviceEnumerator();
            using var defaultEndpoint = endpointEnumerator.GetDefaultAudioEndpoint(
                DataFlow.Render,
                Role.Multimedia
            );
            var endpointChanged = new TaskCompletionSource<string>(
                TaskCreationOptions.RunContinuationsAsynchronously
            );
            var endpointNotifications = new AudioEndpointNotificationClient(
                defaultEndpoint.ID,
                reason => endpointChanged.TrySetResult(reason)
            );
            endpointEnumerator.RegisterEndpointNotificationCallback(
                endpointNotifications
            );

            try
            {
                using var recorder = await new WasapiRecorderBuilder()
                    .WithProcessLoopback(processId, ProcessLoopbackMode.IncludeTargetProcessTree)
                    .WithFormat(new WaveFormat(SampleRate, BitsPerSample, Channels))
                    .WithBufferLength(AudioBlockDurationMs)
                    .WithMmcssThreadPriority("Audio")
                    .BuildAsync();

                using var output = Console.OpenStandardOutput();
                var audioQueue = Channel.CreateBounded<AudioPacket>(
                    new BoundedChannelOptions(AudioQueueCapacityPackets)
                    {
                        FullMode = BoundedChannelFullMode.DropOldest,
                        SingleReader = true,
                        SingleWriter = true,
                        AllowSynchronousContinuations = false,
                    }
                );
                var stopped = new TaskCompletionSource(
                    TaskCreationOptions.RunContinuationsAsynchronously
                );
                long packetSequence = 0;
                recorder.DataAvailable += (buffer, _, devicePosition, qpcPosition) =>
                {
                    if (!buffer.IsEmpty)
                    {
                        // The MMCSS capture callback only copies one bounded
                        // block into a fixed-capacity channel. It never
                        // writes to stdout, waits on a lock, or flushes a pipe.
                        audioQueue.Writer.TryWrite(
                            new AudioPacket(
                                buffer.ToArray(),
                                devicePosition,
                                qpcPosition,
                                Interlocked.Increment(ref packetSequence)
                            )
                        );
                    }
                };
                recorder.RecordingStopped += (_, eventArgs) =>
                {
                    if (eventArgs.Exception is not null)
                    {
                        stopped.TrySetException(eventArgs.Exception);
                    }
                    else
                    {
                        stopped.TrySetResult();
                    }
                };

                using var cancellation = new CancellationTokenSource();
                using var writerCancellation =
                    CancellationTokenSource.CreateLinkedTokenSource(
                        cancellation.Token
                    );
                Console.CancelKeyPress += (_, eventArgs) =>
                {
                    eventArgs.Cancel = true;
                    cancellation.Cancel();
                };
                var windowMonitor = MonitorWindowAsync(
                    windowHandle,
                    processId,
                    cancellation.Token
                );
                var writer = WriteAudioPacketsAsync(
                    output,
                    audioQueue.Reader,
                    writerCancellation.Token
                );

                recorder.StartRecording();
                WriteStatus(new StatusPayload
                {
                    Type = "ready",
                    ProcessId = processId,
                    SampleRate = recorder.WaveFormat.SampleRate,
                    Channels = recorder.WaveFormat.Channels,
                    BitsPerSample = recorder.WaveFormat.BitsPerSample,
                    LatencyMs = recorder.LatencyMilliseconds,
                    QueueCapacityPackets = AudioQueueCapacityPackets,
                    BlockDurationMs = AudioBlockDurationMs,
                });

                var cancelled = Task.Delay(Timeout.Infinite, cancellation.Token);
                var completed = await Task.WhenAny(
                    stopped.Task,
                    cancelled,
                    windowMonitor,
                    endpointChanged.Task,
                    writer
                );
                recorder.StopRecording();
                await stopped.Task;
                audioQueue.Writer.TryComplete();
                try
                {
                    await writer.WaitAsync(TimeSpan.FromSeconds(2));
                }
                catch (TimeoutException)
                {
                    writerCancellation.Cancel();
                    await writer.WaitAsync(TimeSpan.FromMilliseconds(500))
                        .ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
                }
                if (completed == endpointChanged.Task)
                {
                    throw new InvalidOperationException(
                        $"{await endpointChanged.Task}，请重新连接影片声音"
                    );
                }
                return 0;
            }
            finally
            {
                endpointEnumerator.UnregisterEndpointNotificationCallback(
                    endpointNotifications
                );
            }
        }
        catch (OperationCanceledException)
        {
            return 0;
        }
        catch (Exception error)
        {
            return Fail(ToFriendlyMessage(error));
        }
    }

    private static bool TryParseWindowHandle(string input, out nint handle)
    {
        var value = input.Trim();
        var style = NumberStyles.Integer;
        if (value.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
        {
            value = value[2..];
            style = NumberStyles.HexNumber;
        }

        if (long.TryParse(value, style, CultureInfo.InvariantCulture, out var parsed) && parsed > 0)
        {
            handle = new nint(parsed);
            return true;
        }

        handle = 0;
        return false;
    }

    private static void WriteWindowProcessBatch(string input)
    {
        var windows = new List<WindowProcessPayload>();
        foreach (
            var requestedHandle in input.Split(
                ',',
                StringSplitOptions.RemoveEmptyEntries |
                    StringSplitOptions.TrimEntries
            )
        )
        {
            if (!TryParseWindowHandle(requestedHandle, out var windowHandle))
            {
                windows.Add(
                    new WindowProcessPayload { Handle = requestedHandle }
                );
                continue;
            }

            if (
                GetWindowThreadProcessId(windowHandle, out var processId) == 0 ||
                processId == 0
            )
            {
                windows.Add(
                    new WindowProcessPayload { Handle = requestedHandle }
                );
                continue;
            }

            string? processName = null;
            string? executableName = null;
            string? className = null;
            string? ownerHandle = null;
            var classNameBuffer = new StringBuilder(256);
            if (
                GetClassName(
                    windowHandle,
                    classNameBuffer,
                    classNameBuffer.Capacity
                ) > 0
            )
            {
                className = classNameBuffer.ToString();
            }
            var ownerWindow = GetWindow(windowHandle, 4);
            if (ownerWindow != nint.Zero)
            {
                ownerHandle = ownerWindow.ToString(
                    "X",
                    CultureInfo.InvariantCulture
                );
            }
            try
            {
                using var process = Process.GetProcessById(
                    checked((int)processId)
                );
                processName = process.ProcessName;
                try
                {
                    executableName = Path.GetFileName(
                        process.MainModule?.FileName
                    );
                }
                catch (
                    Exception error
                ) when (
                    error is System.ComponentModel.Win32Exception or
                    InvalidOperationException or
                    NotSupportedException
                )
                {
                    // ProcessName is sufficient for matching music players
                    // when Windows does not allow reading MainModule.
                }
            }
            catch (
                Exception error
            ) when (
                error is ArgumentException or
                InvalidOperationException
            )
            {
                // The window can disappear between enumeration and inspection.
            }

            windows.Add(
                new WindowProcessPayload
                {
                    Handle = requestedHandle,
                    ProcessId = processId,
                    ProcessName = processName,
                    ExecutableName = executableName,
                    ClassName = className,
                    OwnerHandle = ownerHandle,
                }
            );
        }

        Console.Out.WriteLine(
            JsonSerializer.Serialize(
                new WindowProcessBatchPayload { Windows = windows },
                StatusJsonContext.Default.WindowProcessBatchPayload
            )
        );
        Console.Out.Flush();
    }

    private static void WriteProcessBatch(string input)
    {
        var requestedNames = input
            .Split(
                ',',
                StringSplitOptions.RemoveEmptyEntries |
                    StringSplitOptions.TrimEntries
            )
            .Select(name => Path.GetFileNameWithoutExtension(name))
            .Where(name => !string.IsNullOrWhiteSpace(name))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var candidates = new List<(
            Process Process,
            DateTime StartedAt,
            string ProcessName
        )>();
        foreach (var process in Process.GetProcesses())
        {
            try
            {
                var processName = process.ProcessName;
                if (!requestedNames.Contains(processName))
                {
                    process.Dispose();
                    continue;
                }
                DateTime startedAt;
                try
                {
                    startedAt = process.StartTime;
                }
                catch (
                    Exception error
                ) when (
                    error is System.ComponentModel.Win32Exception or
                    InvalidOperationException or
                    NotSupportedException
                )
                {
                    startedAt = DateTime.MaxValue;
                }
                candidates.Add((process, startedAt, processName));
            }
            catch (
                Exception error
            ) when (
                error is InvalidOperationException or
                System.ComponentModel.Win32Exception
            )
            {
                process.Dispose();
            }
        }

        var processes = new List<ProcessPayload>();
        var selectedCandidates = candidates
                .OrderBy(candidate => candidate.StartedAt)
                .ThenBy(candidate => candidate.Process.Id)
                .GroupBy(
                    candidate => candidate.ProcessName,
                    StringComparer.OrdinalIgnoreCase
                )
                .Select(group => group.First())
                .ToList();
        foreach (var entry in selectedCandidates)
        {
            var process = entry.Process;
            string? executableName = null;
            try
            {
                executableName = Path.GetFileName(process.MainModule?.FileName);
            }
            catch (
                Exception error
            ) when (
                error is System.ComponentModel.Win32Exception or
                InvalidOperationException or
                NotSupportedException
            )
            {
                // ProcessName is sufficient for matching a known music app.
            }
            processes.Add(
                new ProcessPayload
                {
                    ProcessId = checked((uint)process.Id),
                    ProcessName = entry.ProcessName,
                    ExecutableName = executableName,
                }
            );
        }
        foreach (var candidate in candidates)
        {
            candidate.Process.Dispose();
        }

        Console.Out.WriteLine(
            JsonSerializer.Serialize(
                new ProcessBatchPayload { Processes = processes },
                StatusJsonContext.Default.ProcessBatchPayload
            )
        );
        Console.Out.Flush();
    }

    private static long CurrentQpc100Nanoseconds()
    {
        return checked(
            (long)Math.Round(
                Stopwatch.GetTimestamp() *
                (10_000_000d / Stopwatch.Frequency)
            )
        );
    }

    private static async Task WriteAudioPacketsAsync(
        Stream output,
        ChannelReader<AudioPacket> reader,
        CancellationToken cancellationToken
    )
    {
        long expectedSequence = 1;
        long droppedPackets = 0;
        long reportedDroppedPackets = 0;
        var lastOverrunReport = Stopwatch.StartNew();
        try
        {
            await foreach (
                var packet in reader.ReadAllAsync(cancellationToken)
            )
            {
                if (packet.Sequence > expectedSequence)
                {
                    droppedPackets += packet.Sequence - expectedSequence;
                }
                expectedSequence = packet.Sequence + 1;
                await WriteAudioPacketAsync(
                    output,
                    packet.Pcm,
                    packet.DevicePosition,
                    packet.QpcPosition,
                    cancellationToken
                );
                if (
                    droppedPackets > reportedDroppedPackets &&
                    lastOverrunReport.ElapsedMilliseconds >= 1_000
                )
                {
                    reportedDroppedPackets = droppedPackets;
                    lastOverrunReport.Restart();
                    WriteStatus(new StatusPayload
                    {
                        Type = "overrun",
                        Stage = "helper-writer",
                        DroppedPackets = droppedPackets,
                        QueueDepth = reader.CanCount ? reader.Count : null,
                        QueueCapacityPackets = AudioQueueCapacityPackets,
                    });
                }
            }
            if (droppedPackets > reportedDroppedPackets)
            {
                WriteStatus(new StatusPayload
                {
                    Type = "overrun",
                    Stage = "helper-writer",
                    DroppedPackets = droppedPackets,
                    QueueDepth = reader.CanCount ? reader.Count : null,
                    QueueCapacityPackets = AudioQueueCapacityPackets,
                });
            }
            await output.FlushAsync(cancellationToken);
        }
        catch (OperationCanceledException)
        {
            // The process is stopping or stdout stayed blocked after capture
            // ended. Cancellation must never propagate back to the MMCSS
            // callback because that callback owns no pipe operation.
        }
    }

    private static async Task WriteAudioPacketAsync(
        Stream output,
        ReadOnlyMemory<byte> pcm,
        long devicePosition,
        long qpcPosition,
        CancellationToken cancellationToken
    )
    {
        var header = new byte[AudioPacketHeaderBytes];
        AudioPacketMagic.CopyTo(header, 0);
        BinaryPrimitives.WriteUInt16LittleEndian(header.AsSpan(4, 2), AudioPacketVersion);
        BinaryPrimitives.WriteUInt16LittleEndian(header.AsSpan(6, 2), AudioPacketHeaderBytes);
        BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(8, 4), checked((uint)pcm.Length));
        BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(12, 4), SampleRate);
        var safeQpcPosition = qpcPosition > 0
            ? qpcPosition
            : CurrentQpc100Nanoseconds();
        BinaryPrimitives.WriteInt64LittleEndian(
            header.AsSpan(16, 8),
            checked(safeQpcPosition + QpcToUnix100Nanoseconds)
        );
        BinaryPrimitives.WriteUInt64LittleEndian(
            header.AsSpan(24, 8),
            checked((ulong)devicePosition)
        );
        await output.WriteAsync(header, cancellationToken);
        await output.WriteAsync(pcm, cancellationToken);
    }

    private static int Fail(string message)
    {
        WriteStatus(new StatusPayload { Type = "error", Message = message });
        return 1;
    }

    private static void WriteStatus(StatusPayload payload)
    {
        lock (StatusLock)
        {
            Console.Error.WriteLine(
                JsonSerializer.Serialize(payload, StatusJsonContext.Default.StatusPayload)
            );
            Console.Error.Flush();
        }
    }

    private static async Task MonitorWindowAsync(
        nint windowHandle,
        uint targetProcessId,
        CancellationToken cancellationToken
    )
    {
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                var targetProcessAlive = false;
                try
                {
                    using var targetProcess = Process.GetProcessById(checked((int)targetProcessId));
                    targetProcessAlive = !targetProcess.HasExited;
                }
                catch (ArgumentException)
                {
                    targetProcessAlive = false;
                }
                var foregroundWindow = GetForegroundWindow();
                var foregroundProcessId = 0u;
                if (foregroundWindow != nint.Zero)
                {
                    GetWindowThreadProcessId(foregroundWindow, out foregroundProcessId);
                }

                var foregroundBelongsToTarget =
                    foregroundProcessId == targetProcessId &&
                    IsWindow(foregroundWindow) &&
                    IsWindowVisible(foregroundWindow) &&
                    !IsIconic(foregroundWindow);
                // Some players create a separate top-level window for fullscreen.
                // Follow that window while keeping audio scoped to the selected process tree.
                var trackedWindow = foregroundBelongsToTarget
                    ? foregroundWindow
                    : windowHandle;
                var trackedWindowExists = IsWindow(trackedWindow);
                var minimized = trackedWindowExists && IsIconic(trackedWindow);
                var visible =
                    trackedWindowExists &&
                    IsWindowVisible(trackedWindow) &&
                    !minimized;
                var left = 0;
                var top = 0;
                var width = 0;
                var height = 0;

                if (visible && GetClientRect(trackedWindow, out var clientRect))
                {
                    var topLeft = new NativePoint { X = clientRect.Left, Y = clientRect.Top };
                    var bottomRight = new NativePoint { X = clientRect.Right, Y = clientRect.Bottom };
                    if (
                        ClientToScreen(trackedWindow, ref topLeft) &&
                        ClientToScreen(trackedWindow, ref bottomRight)
                    )
                    {
                        left = topLeft.X;
                        top = topLeft.Y;
                        width = Math.Max(0, bottomRight.X - topLeft.X);
                        height = Math.Max(0, bottomRight.Y - topLeft.Y);
                    }
                }

                WriteStatus(new StatusPayload
                {
                    Type = "window",
                    Left = left,
                    Top = top,
                    Width = width,
                    Height = height,
                    Visible = visible && width >= 160 && height >= 90,
                    Foreground = foregroundBelongsToTarget,
                    Minimized = minimized,
                });

                // Fullscreen transitions can destroy and recreate a player's
                // top-level window while its audio process keeps running.
                // Keep process-loopback alive in that case and only stop once
                // the selected process itself has exited.
                if (!targetProcessAlive)
                {
                    return;
                }
                await Task.Delay(200, cancellationToken);
            }
        }
        catch (OperationCanceledException)
        {
            // Normal shutdown.
        }
    }

    private static string ToFriendlyMessage(Exception error)
    {
        var text = error.GetBaseException().Message;
        if (text.Contains("AUDCLNT_E", StringComparison.OrdinalIgnoreCase))
        {
            return $"Windows 音频采集失败：{text}";
        }
        return text;
    }

}
