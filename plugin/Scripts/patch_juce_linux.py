"""Make JUCE's Linux WebKit child launcher work for plug-ins and executables.

JUCE extracts a helper binary that dlopen()s File::currentExecutableFile and
looks up juce_gtkWebkitMain in it. glibc refuses to dlopen executables
("cannot dynamically load executable"). The failure is silent: the browser
is disabled and every JavaScript callback is dropped.

Use dladdr() to find the module that really defines the entry point. A shared
object (the plug-in module) is passed to the helper as before. When the symbol
lives in the executable, the executable is re-executed directly with
--juce-gtkwebkitfork-child, which is the same mechanism JUCE already uses for
standalone applications.
On Linux, currentExecutableFile may mean the plug-in module itself; only
hostApplicationPath identifies the actual /proc/self/exe process executable.

The pipe transport also needs byte lengths (not Unicode character counts)
and must finish short writes. Otherwise non-ASCII library data is truncated
before it reaches the browser/native callback.
"""
from pathlib import Path
import sys

root = Path(sys.argv[1])
module = root / "modules/juce_gui_extra/native/juce_WebBrowserComponent_linux.cpp"
source = module.read_text()

old_arguments = """            arguments.emplace_back (subprocessFile->getFile().getFullPathName());
            arguments.emplace_back (File::getSpecialLocation (File::currentExecutableFile).getFullPathName());
            arguments.emplace_back ("juce_gtkWebkitMain");"""

new_arguments = """            // dladdr reports the module that actually defines the child entry
            // point. A plug-in shared object can be loaded by the helper; an
            // executable cannot be dlopen()ed at all on glibc, so it is
            // re-executed and handles --juce-gtkwebkitfork-child itself.
            const auto canonicalPath = [] (const File& file)
            {
                char resolved[4096] = {};

                if (realpath (file.getFullPathName().toRawUTF8(), resolved) != nullptr)
                    return String (CharPointer_UTF8 { resolved });

                return file.getFullPathName();
            };

            const auto executable = canonicalPath (File::getSpecialLocation (File::hostApplicationPath));
            auto childModule = executable;

            if (Dl_info moduleInfo {}; dladdr (reinterpret_cast<void*> (&juce_gtkWebkitMain), &moduleInfo) != 0
                                        && moduleInfo.dli_fname != nullptr
                                        && moduleInfo.dli_fname[0] != 0)
                childModule = canonicalPath (File (String (CharPointer_UTF8 { moduleInfo.dli_fname })));

            if (childModule != executable)
            {
                arguments.emplace_back (subprocessFile->getFile().getFullPathName());
                arguments.emplace_back (childModule);
                arguments.emplace_back ("juce_gtkWebkitMain");
            }"""

old_include = """namespace juce
{

//==============================================================================
class WebKitSymbols final : public DeletedAtShutdown"""

new_include = """#include <dlfcn.h>
#include <stdlib.h>

namespace juce
{

//==============================================================================
class WebKitSymbols final : public DeletedAtShutdown"""

old_length = "auto jsonLength = static_cast<size_t> (json.length());"
new_length = "auto jsonLength = json.getNumBytesAsUTF8();"

old_decode = "parseJSON (String (buffer.getData(), bufferLength.len));"
new_decode = "parseJSON (String (CharPointer_UTF8 (buffer.getData()), CharPointer_UTF8 (buffer.getData() + bufferLength.len)));"

old_callback = 'CommandReceiver::sendCommand (outChannel, "invokeCallback", var (s));'
new_callback = 'CommandReceiver::sendCommand (outChannel, "invokeCallback", var (String::fromUTF8 (s)));'

old_write = """        ssize_t ret;

        for (;;)
        {
            ret = write (outChannel, buffer.getData(), len);

            if (ret != -1 || errno != EINTR)
                break;
        }"""

new_write = """        size_t written = 0;

        while (written < len)
        {
            const auto ret = write (outChannel, buffer.getData() + written, len - written);

            if (ret > 0)
                written += static_cast<size_t> (ret);
            else if (ret < 0 && errno == EINTR)
                continue;
            else
                break;
        }"""

changes = []
patches = [
    ("child launcher includes", old_include, new_include),
    ("child module resolution", old_arguments, new_arguments),
    ("UTF-8 frame lengths", old_length, new_length),
    ("UTF-8 frame decoding", old_decode, new_decode),
    ("UTF-8 JavaScript callbacks", old_callback, new_callback),
    ("complete pipe writes", old_write, new_write),
]
# Development symlinks are not installed by the runtime-only Debian packages.
for library, soname in [
    ("libgtk-3.so", "libgtk-3.so.0"),
    ("libglib-2.0.so", "libglib-2.0.so.0"),
    ("libwebkit2gtk-4.1.so", "libwebkit2gtk-4.1.so.0"),
    ("libjavascriptcoregtk-4.1.so", "libjavascriptcoregtk-4.1.so.0"),
    ("libsoup-3.0.so", "libsoup-3.0.so.0"),
    ("libwebkit2gtk-4.0.so", "libwebkit2gtk-4.0.so.37"),
    ("libjavascriptcoregtk-4.0.so", "libjavascriptcoregtk-4.0.so.18"),
    ("libsoup-2.4.so", "libsoup-2.4.so.1"),
]:
    patches.append((library + " runtime SONAME", f'"{library}"', f'"{soname}"'))

for name, old, new in patches:
    if source.count(new) == 1:
        continue
    # Upgrade the first launcher patch when reconfiguring an existing build.
    previous_arguments = new_arguments.replace("File::hostApplicationPath", "File::currentExecutableFile")
    if name == "child module resolution" and source.count(previous_arguments) == 1:
        source = source.replace(previous_arguments, new, 1)
        changes.append(name)
        continue
    if source.count(old) != 1:
        raise SystemExit(f"Unexpected JUCE source for {name}: expected exactly one match for:\n{old}")
    source = source.replace(old, new, 1)
    changes.append(name)

module.write_text(source)
print("Patched Linux WebKit: " + ", ".join(changes) if changes else "Linux WebKit already patched")
