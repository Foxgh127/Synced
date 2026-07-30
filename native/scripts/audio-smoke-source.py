import math
import os
import struct
import tempfile
import tkinter as tk
import wave
import winsound


SAMPLE_RATE = 48_000
FREQUENCY = 880
AMPLITUDE = 0.2


def build_wave(path: str) -> None:
    frames = bytearray()
    for index in range(SAMPLE_RATE):
        sample = int(
            32_767
            * AMPLITUDE
            * math.sin(2 * math.pi * FREQUENCY * index / SAMPLE_RATE)
        )
        frames.extend(struct.pack("<hh", sample, sample))
    with wave.open(path, "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        output.writeframes(frames)


wave_path = os.path.join(tempfile.gettempdir(), "synced-process-audio-smoke.wav")
build_wave(wave_path)

root = tk.Tk()
root.title("Synced Native Process Audio Smoke")
root.geometry("640x360")
label = tk.Label(
    root,
    text="进程音频采集测试：880 Hz",
    bg="#10182c",
    fg="white",
    font=("Microsoft YaHei UI", 24),
)
label.pack(fill="both", expand=True)

palette = ("#10182c", "#172554", "#0f3b4c", "#312e81")
animation_frame = 0


def animate_source() -> None:
    global animation_frame
    animation_frame += 1
    position = animation_frame % 60
    label.configure(
        bg=palette[(animation_frame // 15) % len(palette)],
        text=(
            "进程音频采集测试：880 Hz\n"
            f"{'●' * (position // 5 + 1):<12}  帧 {animation_frame}"
        ),
    )
    root.after(33, animate_source)


animate_source()
root.update()

winsound.PlaySound(
    wave_path,
    winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_LOOP,
)
print(f"HANDLE={root.winfo_id()}", flush=True)

try:
    root.mainloop()
finally:
    winsound.PlaySound(None, 0)
