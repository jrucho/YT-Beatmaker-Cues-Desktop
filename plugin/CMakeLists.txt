cmake_minimum_required(VERSION 3.24)
project(BeatmakerCuesPrototype VERSION 1.0.4 LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
include(FetchContent)
FetchContent_Declare(JUCE URL https://github.com/juce-framework/JUCE/archive/29396c22c93392d6738e021b83196283d6e4d850.tar.gz
    DOWNLOAD_EXTRACT_TIMESTAMP FALSE)
FetchContent_MakeAvailable(JUCE)
FetchContent_Declare(SignalsmithStretch URL https://github.com/Signalsmith-Audio/signalsmith-stretch/archive/88061fd4eda56a2353c5d65c74aa3f4ccf76f9da.tar.gz DOWNLOAD_EXTRACT_TIMESTAMP FALSE)
FetchContent_Declare(SignalsmithLinear URL https://github.com/Signalsmith-Audio/linear/archive/7bb1c8f36794d6980080ce817c91f8da8fe56a66.tar.gz DOWNLOAD_EXTRACT_TIMESTAMP FALSE)
FetchContent_MakeAvailable(SignalsmithLinear SignalsmithStretch)
if(CMAKE_SYSTEM_NAME STREQUAL "iOS")
    find_package(Python3 REQUIRED COMPONENTS Interpreter)
    FetchContent_GetProperties(JUCE SOURCE_DIR JUCE_SOURCE_PATH)
    execute_process(COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/Scripts/patch_juce_ios.py" "${JUCE_SOURCE_PATH}"
        COMMAND_ERROR_IS_FATAL ANY)
endif()

if(CMAKE_SYSTEM_NAME STREQUAL "iOS")
    set(PLUGIN_FORMATS AUv3 Standalone)
elseif(APPLE)
    set(PLUGIN_FORMATS VST3 AU Standalone)
else()
    set(PLUGIN_FORMATS VST3 Standalone)
endif()

set(BEATMAKER_BUNDLE_ID "app.owaega.beatmakercuesprototype" CACHE STRING "Apple bundle ID; legacy default preserves existing app data")
option(BEATMAKER_DESKTOP_BETA "Build the separate experimental desktop-layout plug-in" OFF)
set(BEATMAKER_PRODUCT "Beatmaker Cues Plug-in")
set(BEATMAKER_CODE BmCP)
set(BEATMAKER_UI_ARCHIVE Assets/mobile-ui.zip)
if(BEATMAKER_DESKTOP_BETA)
    if(CMAKE_SYSTEM_NAME STREQUAL "iOS")
        message(FATAL_ERROR "The desktop-layout beta is only a desktop target")
    endif()
    set(BEATMAKER_PRODUCT "Beatmaker Cues Desktop Beta")
    set(BEATMAKER_CODE BmDB)
    set(BEATMAKER_BETA_BUNDLE_ID "app.owaega.beatmakercues.desktopbeta" CACHE STRING "Desktop beta identity; separate from the normal plug-in")
    set(BEATMAKER_BUNDLE_ID "${BEATMAKER_BETA_BUNDLE_ID}")
    set(BEATMAKER_UI_ARCHIVE Assets/desktop-beta-ui.zip)
endif()
juce_add_plugin(BeatmakerCues
    COMPANY_NAME "Owaega"
    BUNDLE_ID "${BEATMAKER_BUNDLE_ID}"
    PLUGIN_MANUFACTURER_CODE Owga
    PLUGIN_CODE ${BEATMAKER_CODE}
    PRODUCT_NAME "${BEATMAKER_PRODUCT}"
    ICON_BIG "${CMAKE_CURRENT_SOURCE_DIR}/Assets/PluginIcon.png"
    ICON_SMALL "${CMAKE_CURRENT_SOURCE_DIR}/Assets/PluginIcon.png"
    IS_SYNTH TRUE
    NEEDS_MIDI_INPUT TRUE
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS FALSE
    COPY_PLUGIN_AFTER_BUILD FALSE
    NEEDS_WEBVIEW2 TRUE
    NEEDS_WEB_BROWSER TRUE
    NEEDS_CURL TRUE
    BACKGROUND_AUDIO_ENABLED TRUE
    IPAD_SCREEN_ORIENTATIONS UIInterfaceOrientationPortrait UIInterfaceOrientationPortraitUpsideDown UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight
    FORMATS ${PLUGIN_FORMATS}
    VST3_CATEGORIES Instrument Sampler
    AU_MAIN_TYPE kAudioUnitType_MusicDevice
    MICROPHONE_PERMISSION_ENABLED FALSE)
juce_add_binary_data(MobileWebAssets HEADER_NAME MobileWebAssets.h NAMESPACE MobileWebAssets SOURCES ${BEATMAKER_UI_ARCHIVE} Web/bridge.js)
target_sources(BeatmakerCues PRIVATE Source/Processor.cpp Source/Editor.cpp Source/WebEditor.cpp Source/LibraryStore.cpp Source/TrackResolver.cpp)
if(APPLE)
    target_sources(BeatmakerCues PRIVATE Source/AppleHttp.mm)
endif()
target_include_directories(BeatmakerCues PUBLIC Source)
target_link_libraries(BeatmakerCues PUBLIC signalsmith-stretch)
target_compile_definitions(BeatmakerCues PUBLIC
    JUCE_WEB_BROWSER=1 JUCE_USE_MP3AUDIOFORMAT=1 JUCE_VST3_CAN_REPLACE_VST2=0)
if(BEATMAKER_DESKTOP_BETA)
    target_compile_definitions(BeatmakerCues PUBLIC BEATMAKER_DESKTOP_BETA=1)
endif()
if(WIN32)
    target_compile_definitions(BeatmakerCues PUBLIC JUCE_WEBVIEW2=1 JUCE_USE_WIN_WEBVIEW2_WITH_STATIC_LINKING=1 JUCE_USE_CURL=0)
elseif(APPLE)
    target_compile_definitions(BeatmakerCues PUBLIC JUCE_USE_CURL=0)
else()
    target_compile_definitions(BeatmakerCues PUBLIC JUCE_USE_CURL=1)
endif()
target_link_libraries(BeatmakerCues PUBLIC juce::juce_audio_processors juce::juce_audio_formats
    PRIVATE juce::juce_recommended_config_flags MobileWebAssets)
target_link_libraries(BeatmakerCues_Standalone PRIVATE juce::juce_audio_utils)
set_target_properties(BeatmakerCues_Standalone PROPERTIES XCODE_ATTRIBUTE_SKIP_INSTALL NO XCODE_ATTRIBUTE_INSTALL_PATH "$(LOCAL_APPS_DIR)")
if(CMAKE_SYSTEM_NAME STREQUAL "iOS")
    target_compile_definitions(BeatmakerCues PRIVATE BEATMAKER_AUV3_EXTENSION=1)
    set_target_properties(BeatmakerCues PROPERTIES XCODE_ATTRIBUTE_APPLICATION_EXTENSION_API_ONLY YES)
    target_compile_definitions(BeatmakerCues_AUv3 PRIVATE BEATMAKER_AUV3_EXTENSION=1)
    target_link_libraries(BeatmakerCues_AUv3 PRIVATE "-framework CoreAudioKit")
endif()

if(NOT CMAKE_SYSTEM_NAME STREQUAL "iOS")
    juce_add_console_app(CueTests PRODUCT_NAME "Beatmaker Cues Engine Tests" NEEDS_WEBVIEW2 TRUE NEEDS_WEB_BROWSER TRUE NEEDS_CURL TRUE)
    target_sources(CueTests PRIVATE Tests/EngineTests.cpp)
    target_compile_definitions(CueTests PRIVATE BEATMAKER_TEST_FIXTURES="${CMAKE_CURRENT_SOURCE_DIR}/Tests/fixtures")
    target_link_libraries(CueTests PRIVATE BeatmakerCues)
    enable_testing()
    add_test(NAME CueEngine COMMAND CueTests)
    set_tests_properties(CueEngine PROPERTIES ENVIRONMENT "BEATMAKER_PLUGIN_DATA_DIR=${CMAKE_CURRENT_BINARY_DIR}/test-library-engine")
    juce_add_console_app(StoreTests PRODUCT_NAME "Beatmaker Library Tests")
    target_sources(StoreTests PRIVATE Source/LibraryStore.cpp Tests/StoreTests.cpp)
    target_compile_definitions(StoreTests PRIVATE JUCE_USE_CURL=0)
    target_include_directories(StoreTests PRIVATE Source)
    target_link_libraries(StoreTests PRIVATE juce::juce_core)
    add_test(NAME PersistentLibrary COMMAND StoreTests)
    if(APPLE)
        juce_add_console_app(WebIntegration PRODUCT_NAME "Beatmaker Mobile UI Integration")
        target_sources(WebIntegration PRIVATE Tests/WebIntegration.cpp)
        target_link_libraries(WebIntegration PRIVATE BeatmakerCues "-framework CoreFoundation")
    endif()
    juce_add_console_app(PluginProbe PRODUCT_NAME "Beatmaker Cues Plugin Probe")
    target_sources(PluginProbe PRIVATE Tests/PluginProbe.cpp)
    target_compile_definitions(PluginProbe PRIVATE JUCE_PLUGINHOST_VST3=1 JUCE_PLUGINHOST_AU=1 JUCE_WEB_BROWSER=0 JUCE_USE_CURL=0)
    target_link_libraries(PluginProbe PRIVATE juce::juce_audio_utils)
endif()
