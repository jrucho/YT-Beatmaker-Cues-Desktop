# Audio fixture

`tone.m4a` is a generated 0.5-second, 440 Hz stereo sine wave at 48 kHz,
encoded as AAC. It contains no recorded or third-party audio.

Regenerate with:

```sh
ffmpeg -nostdin -v error -y -f lavfi \
  -i 'sine=frequency=440:sample_rate=48000:duration=0.5' \
  -ac 2 -c:a aac plugin/Tests/fixtures/tone.m4a
```

The engine test checks actual decoding and the frequency and energy of the
rendered output. Linux/Windows need FFmpeg on PATH when no native reader can
decode AAC.
