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
    }
  ]
}
