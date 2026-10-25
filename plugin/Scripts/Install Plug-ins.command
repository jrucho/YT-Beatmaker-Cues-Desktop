#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HOME/Library/Audio/Plug-Ins/Components" "$HOME/Library/Audio/Plug-Ins/VST3"
test -d "$HERE/AU/Beatmaker Cues Plug-in.component"
test -d "$HERE/VST3/Beatmaker Cues Plug-in.vst3"
ditto "$HERE/AU/Beatmaker Cues Plug-in.component" "$HOME/Library/Audio/Plug-Ins/Components/Beatmaker Cues Plug-in.component"
ditto "$HERE/VST3/Beatmaker Cues Plug-in.vst3" "$HOME/Library/Audio/Plug-Ins/VST3/Beatmaker Cues Plug-in.vst3"
open "$HERE/Standalone"
