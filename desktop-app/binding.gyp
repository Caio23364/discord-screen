{
  "targets": [
    {
      "target_name": "audio_mixer",
      "sources": [ "native/audio_mixer.cpp" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "AdditionalOptions": [ "-std:c++17" ]
        }
      },
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ]
    },
    {
      "target_name": "video_capture",
      "sources": [ "native/video_capture.cpp" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "AdditionalOptions": [ "-std:c++17", "/await" ]
        }
      },
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ],
      "libraries": [
        "-ld3d11.lib",
        "-ldxgi.lib",
        "-lmfuuid.lib",
        "-lmfplat.lib",
        "-lwindowsapp.lib",
        "-lavrt.lib",
        "-ld2d1.lib"
      ]
    }
  ]
}
