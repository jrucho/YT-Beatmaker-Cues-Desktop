#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARTIFACTS="$ROOT/build-mac/BeatmakerCues_artefacts/Release"
for ENTRY in "AU/Beatmaker Cues Plug-in.component" "VST3/Beatmaker Cues Plug-in.vst3" "Standalone/Beatmaker Cues Plug-in.app"; do
  test -d "$ARTIFACTS/$ENTRY"
  codesign --force --deep --sign - "$ARTIFACTS/$ENTRY"
  codesign --verify --deep --strict "$ARTIFACTS/$ENTRY"
done
mkdir -p "$HOME/Library/Audio/Plug-Ins/Components" "$HOME/Library/Audio/Plug-Ins/VST3"
ditto "$ARTIFACTS/AU/Beatmaker Cues Plug-in.component" "$HOME/Library/Audio/Plug-Ins/Components/Beatmaker Cues Plug-in.component"
ditto "$ARTIFACTS/VST3/Beatmaker Cues Plug-in.vst3" "$HOME/Library/Audio/Plug-Ins/VST3/Beatmaker Cues Plug-in.vst3"
"$ROOT/build-mac/PluginProbe_artefacts/Release/PluginProbe" "$HOME/Library/Audio/Plug-Ins/Components/Beatmaker Cues Plug-in.component"
auval -v aumu BmCP Owga
