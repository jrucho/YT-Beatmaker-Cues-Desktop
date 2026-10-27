# Source and binary licensing

The repository's own MIT-licensed application source retains its existing license
and credits in `LICENSE`. It does not relicense third-party dependencies.

## Native plug-ins and plug-in standalone

The public JUCE-based builds use JUCE's **AGPLv3 option**. Distribution of the
combined JUCE-based program is under the applicable AGPLv3 terms; the root MIT
notice alone is not the license statement for those binaries. The complete
plug-in source/dependency ZIP supplies the corresponding application source,
exact dependency sources, patches and build scripts. The release tag identifies
the build commit. Users modifying or redistributing it must comply with the
applicable licenses. Developers choosing a commercial JUCE route must obtain the
appropriate JUCE license themselves.

Pinned dependencies:

| Dependency | Revision | License |
| --- | --- | --- |
| JUCE 8.0.12 | `29396c22c93392d6738e021b83196283d6e4d850` | AGPLv3 / commercial, including the notices for bundled dependencies |
| Signalsmith Stretch | `88061fd4eda56a2353c5d65c74aa3f4ccf76f9da` | MIT |
| Signalsmith Linear | `7bb1c8f36794d6980080ce817c91f8da8fe56a66` | MIT |

Read each dependency's license and notices in the source bundle's `Frameworks/`
directory. JUCE's `LICENSE.md` also inventories the third-party code it contains.
The GNU license text is at <https://www.gnu.org/licenses/agpl-3.0.txt>.

The portable native dynamics processor adapts WebKit's
`DynamicsCompressorKernel`/`DynamicsCompressor` at commit
`df9b1fc2f4973c30fe00df08d255f64b65cb3fc0` (Google Inc., 2011; BSD-3-Clause,
with the associated 2010 audio-utility BSD-2-Clause notice). Full notices and
adaptation details are in `plugin/Source/dsp/WebKit-LICENSE.txt`, included in
native package licenses and Apple bundle resources.

## Main application

Preserve Musike's credits and the existing desktop engine's
`YTbeatmakercues/THIRD_PARTY_NOTICES.md`. JavaScript dependencies are specified in
the workspace manifests and `pnpm-lock.yaml`; their individual licenses apply.
Electron and Capacitor have their own licenses/notices. External yt-dlp, Deno and
FFmpeg downloads are separate components with their own licenses. FFmpeg is not
silently included in the native plug-in ZIP; users must provide it where native
AAC decoding is unavailable. If distributing a bundled FFmpeg build, preserve
and satisfy that build's applicable license and source requirements.

Long lists use TanStack React Virtual and Virtual Core 3.13.12 (MIT, copyright
2021-present Tanner Linsley). Their full license texts are included beside the
bundled web assets as `LICENSE-TANSTACK-react-virtual.txt` and
`LICENSE-TANSTACK-virtual-core.txt`.
