"""Make JUCE's Linux WebKit child launcher work for plug-ins and executables.

JUCE extracts a helper binary that dlopen()s File::currentExecutableFile and
looks up juce_gtkWebkitMain in it. glibc refuses to dlopen executables
("cannot dynamically load executable"), and inside a plug-in the "current
executable" is the host application, which never defines that symbol. The
failure is silent: the browser is disabled and every JavaScript callback is
dropped.

Use dladdr() to find the module that really defines the entry point. A shared
object (the plug-in module) is passed to the helper as before. When the symbol
lives in the executable, the executable is re-executed directly with
--juce-gtkwebkitfork-child, which is the same mechanism JUCE already uses for
standalone applications.
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
            const auto executable = File::getSpecialLocation (File::currentExecutableFile).getCanonicalFile();
            auto childModule = executable;

            if (Dl_info moduleInfo {}; dladdr (reinterpret_cast<void*> (&juce_gtkWebkitMain), &moduleInfo) != 0
                                        && moduleInfo.dli_fname != nullptr
                                        && moduleInfo.dli_fname[0] != 0)
                childModule = File (String (CharPointer_UTF8 { moduleInfo.dli_fname })).getCanonicalFile();

            if (childModule != executable)
            {
                arguments.emplace_back (subprocessFile->getFile().getFullPathName());
                arguments.emplace_back (childModule.getFullPathName());
                arguments.emplace_back ("juce_gtkWebkitMain");
            }"""

old_include = """namespace juce
{

//==============================================================================
class WebKitSymbols final : public DeletedAtShutdown"""

new_include = """#include <dlfcn.h>

namespace juce
{

//==============================================================================
class WebKitSymbols final : public DeletedAtShutdown"""

if "Dl_info moduleInfo" in source:
    print("Linux WebKit child launcher already patched")
    sys.exit(0)

for needle in (old_arguments, old_include):
    if source.count(needle) != 1:
        raise SystemExit(f"Unexpected JUCE source: expected exactly one match for:\n{needle}")

source = source.replace(old_include, new_include).replace(old_arguments, new_arguments)
module.write_text(source)
print("Patched Linux WebKit child launcher to resolve the module that owns juce_gtkWebkitMain")
