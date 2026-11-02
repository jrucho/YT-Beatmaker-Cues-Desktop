"""App-scoped stream negotiation/observability for the pinned JUCE 8.0.12 backend.

Keep source reproducible without a binary framework fork. The app supplies a
small POD observer; other projects using the same JUCE checkout are unaffected.
"""
from pathlib import Path
import sys

path = Path(sys.argv[1]) / 'modules/juce_audio_devices/native/juce_Oboe_android.cpp'
marker = 'BEATMAKER_ANDROID_OUTPUT_HOOKS_V1'
original = path.read_bytes()
newline = '\r\n' if b'\r\n' in original else '\n'
text = original.decode().replace('\r\n', '\n')


def limit_experiments(source):
    # Alternate usages/formats are internal comparisons. Published builds keep
    # the original float-first JUCE path and only observe its accepted settings.
    for anchor in ['            builder.setUsage (beatmakerAndroidOutputProfile()',
                   '        int outputRouteScore() const',
                   '    const auto openFloat = [&]()']:
        position = source.find(anchor)
        if position >= 0:
            condition = source.rfind('#if BEATMAKER_ANDROID_OUTPUT_BRIDGE', 0, position)
            end = source.find('\n', condition)
            if condition >= 0 and 'BEATMAKER_ANDROID_LATENCY_PROBE' not in source[condition:end]:
                source = source[:end] + ' && BEATMAKER_ANDROID_LATENCY_PROBE' + source[end:]
    return source


if marker in text:
    updated = limit_experiments(text)
    if updated != text:
        path.write_bytes(updated.replace('\n', newline).encode())
    print('JUCE Android output hooks ready')
    sys.exit(0)


def replace(before, after):
    global text
    if text.count(before) != 1:
        raise RuntimeError('Pinned JUCE Android source changed: output hook anchor missing/ambiguous')
    text = text.replace(before, after, 1)


replace('namespace juce\n{', '''// ''' + marker + '''
#if BEATMAKER_ANDROID_OUTPUT_BRIDGE
 #include "AndroidAudioOutput.h"
 #include "oboe/OboeExtensions.h"
#endif

namespace juce
{''')
replace('            builder.setPerformanceMode (oboe::PerformanceMode::LowLatency);', '''            builder.setPerformanceMode (oboe::PerformanceMode::LowLatency);
           #if BEATMAKER_ANDROID_OUTPUT_BRIDGE
            builder.setUsage (beatmakerAndroidOutputProfile() == 0 ? oboe::Usage::Media : oboe::Usage::Game);
            builder.setContentType (oboe::ContentType::Music);
           #endif''')
replace('''            }
        }

        std::shared_ptr<oboe::AudioStream> getNativeStream() const''', '''               #if BEATMAKER_ANDROID_OUTPUT_BRIDGE
                if (stream->getDirection() == oboe::Direction::Output)
                {
                    AndroidAudioOutputInfo info;
                    info.api = (int) stream->getAudioApi();
                    info.performance = (int) stream->getPerformanceMode();
                    info.sharing = (int) stream->getSharingMode();
                    info.format = (int) stream->getFormat();
                    info.rate = stream->getSampleRate();
                    info.channels = stream->getChannelCount();
                    info.burst = stream->getFramesPerBurst();
                    info.buffer = stream->getBufferSizeInFrames();
                    info.capacity = stream->getBufferCapacityInFrames();
                    info.device = stream->getDeviceId();
                    info.usage = (int) stream->getUsage();
                    info.content = (int) stream->getContentType();
                    info.mmap = oboe::OboeExtensions::isMMapUsed (stream.get());
                    beatmakerAndroidOutputStarted (stream.get(), info);
                }
               #endif
            }
        }

        std::shared_ptr<oboe::AudioStream> getNativeStream() const''')
replace('''                [[maybe_unused]] oboe::Result result = stream->close();''', '''               #if BEATMAKER_ANDROID_OUTPUT_BRIDGE
                beatmakerAndroidOutputStopped (stream.get());
               #endif
                [[maybe_unused]] oboe::Result result = stream->close();''')
replace('''        int getCurrentBitDepth() const noexcept { return bitDepth; }''', '''        int getCurrentBitDepth() const noexcept { return bitDepth; }
       #if BEATMAKER_ANDROID_OUTPUT_BRIDGE
        int outputRouteScore() const
        {
            const auto stream = outputStream != nullptr ? outputStream->getNativeStream() : nullptr;
            if (stream == nullptr) return -1;
            return (stream->getPerformanceMode() == oboe::PerformanceMode::LowLatency ? 100 : 0)
                 + (oboe::OboeExtensions::isMMapUsed (stream.get()) ? 20 : 0)
                 + (stream->getFormat() == oboe::AudioFormat::Float ? 1 : 0);
        }
       #endif''')
begin = text.index('OboeAudioIODevice::OboeSessionBase* OboeAudioIODevice::OboeSessionBase::create (')
body = text.index('\n{', begin) + 2
end = text.index('\n}\n', body)
old_body = text[body:end]
new_body = '''
   #if BEATMAKER_ANDROID_OUTPUT_BRIDGE
    const auto openFloat = [&]() -> std::unique_ptr<OboeSessionBase>
    {
        auto result = std::make_unique<OboeSessionImpl<float>> (owner, inputDeviceId, outputDeviceId,
                              numInputChannels, numOutputChannels, sampleRate, bufferSize);
        if (! result->openedOk()) return {};
        return result;
    };
    const auto openInteger = [&]() -> std::unique_ptr<OboeSessionBase>
    {
        auto result = std::make_unique<OboeSessionImpl<int16>> (owner, inputDeviceId, outputDeviceId,
                              numInputChannels, numOutputChannels, sampleRate, bufferSize);
        if (! result->openedOk()) return {};
        return result;
    };
    const int profile = beatmakerAndroidOutputProfile();
    if (profile == 2)
    {
        auto integer = openInteger();
        if (integer != nullptr) return integer.release();
    }
    auto floating = openFloat();
    if (floating == nullptr) return openInteger().release();
    // Float DSP stays unchanged in either session. If float transport fell back
    // to the mixer, try the device's integer transport before accepting it.
    if (profile == 3 && floating->outputRouteScore() < 100)
    {
        const int score = floating->outputRouteScore();
        floating.reset(); // Release exclusive resources before the alternate open.
        auto integer = openInteger();
        if (integer != nullptr && integer->outputRouteScore() > score) return integer.release();
        integer.reset();
        floating = openFloat();
        if (floating == nullptr) return openInteger().release();
    }
    return floating.release();
   #else
''' + old_body + '''
   #endif'''
text = limit_experiments(text[:body] + new_body + text[end:])
path.write_bytes(text.replace('\n', newline).encode())
print('Applied JUCE Android output negotiation/observer hooks')
