#include <napi.h>
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <avrt.h>
#include <psapi.h>
#include <thread>
#include <atomic>
#include <mutex>
#include <vector>
#include <set>
#include <string>
#include <algorithm>
#include <cmath>
#include <objidl.h>

#include <audioclientactivationparams.h>

#pragma comment(lib, "Mmdevapi.lib")
#pragma comment(lib, "Avrt.lib")
#pragma comment(lib, "Ole32.lib")

using namespace Napi;

// ── Globals ──
static std::atomic<bool> g_isCapturing(false);
static std::thread g_captureThread;
static ThreadSafeFunction g_tsfn;
static std::mutex g_excludeMutex;
static std::set<DWORD> g_excludedPids;
static std::set<DWORD> g_fallbackExcludedPids;
static std::string g_captureMode = "legacy";
static DWORD g_targetPid = 0;
static std::atomic<bool> g_pidsChanged(false);

// ── Helpers ──
static std::string WideToUtf8(const std::wstring& wide) {
    if (wide.empty()) return "";
    int size = WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), (int)wide.size(), nullptr, 0, nullptr, nullptr);
    std::string result(size, 0);
    WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), (int)wide.size(), &result[0], size, nullptr, nullptr);
    return result;
}

static std::string GetProcessName(DWORD pid) {
    if (pid == 0) return "System Idle";
    HANDLE hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!hProc) return "Unknown (" + std::to_string(pid) + ")";
    
    wchar_t path[MAX_PATH] = {};
    DWORD pathLen = MAX_PATH;
    std::string name;
    
    if (QueryFullProcessImageNameW(hProc, 0, path, &pathLen)) {
        std::wstring wpath(path);
        size_t pos = wpath.find_last_of(L"\\/");
        name = WideToUtf8(pos != std::wstring::npos ? wpath.substr(pos + 1) : wpath);
    } else {
        name = "PID " + std::to_string(pid);
    }
    
    CloseHandle(hProc);
    return name;
}

template<typename T>
static void SafeRelease(T*& ptr) {
    if (ptr) { ptr->Release(); ptr = nullptr; }
}

// ── COM Handler for ActivateAudioInterfaceAsync ──
class AudioClientActivationHandler : public IActivateAudioInterfaceCompletionHandler {
    LONG m_cRef;
    HANDLE m_hEvent;
    HRESULT m_hr;
    IAudioClient* m_pAudioClient;

public:
    AudioClientActivationHandler() : m_cRef(1), m_hr(E_FAIL), m_pAudioClient(nullptr) {
        m_hEvent = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    }

    virtual ~AudioClientActivationHandler() {
        if (m_hEvent) CloseHandle(m_hEvent);
        if (m_pAudioClient) m_pAudioClient->Release();
    }

    ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&m_cRef); }
    ULONG STDMETHODCALLTYPE Release() override {
        ULONG ulRef = InterlockedDecrement(&m_cRef);
        if (0 == ulRef) delete this;
        return ulRef;
    }
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void **ppvObject) override {
        if (!ppvObject) return E_POINTER;
        if (riid == IID_IUnknown || riid == __uuidof(IActivateAudioInterfaceCompletionHandler) || riid == IID_IAgileObject) {
            *ppvObject = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
            AddRef();
            return S_OK;
        }
        *ppvObject = nullptr;
        return E_NOINTERFACE;
    }

    HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation *pAsyncOp) override {
        HRESULT hrActivateResult = E_FAIL;
        IUnknown *pUnk = nullptr;
        
        HRESULT hr = pAsyncOp->GetActivateResult(&hrActivateResult, &pUnk);
        if (SUCCEEDED(hr) && SUCCEEDED(hrActivateResult) && pUnk != nullptr) {
            pUnk->QueryInterface(__uuidof(IAudioClient), (void**)&m_pAudioClient);
            pUnk->Release();
        }
        m_hr = hrActivateResult;
        SetEvent(m_hEvent);
        return S_OK;
    }
    
    HRESULT Wait(IAudioClient** ppAudioClient) {
        DWORD res = WaitForSingleObject(m_hEvent, 2000);
        if (res != WAIT_OBJECT_0) return E_FAIL;
        if (SUCCEEDED(m_hr) && m_pAudioClient) {
            *ppAudioClient = m_pAudioClient;
            m_pAudioClient->AddRef();
            return S_OK;
        }
        return FAILED(m_hr) ? m_hr : E_FAIL;
    }
};

// ── GetAudioSessions: enumerate active audio sessions ──
Napi::Value GetAudioSessions(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Array result = Napi::Array::New(env);
    
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    bool needUninit = SUCCEEDED(hr);
    
    IMMDeviceEnumerator* pEnumerator = nullptr;
    IMMDevice* pDevice = nullptr;
    IAudioSessionManager2* pSessionManager = nullptr;
    IAudioSessionEnumerator* pSessionEnum = nullptr;
    
    hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                          __uuidof(IMMDeviceEnumerator), (void**)&pEnumerator);
    if (FAILED(hr)) goto cleanup;
    
    hr = pEnumerator->GetDefaultAudioEndpoint(eRender, eConsole, &pDevice);
    if (FAILED(hr)) goto cleanup;
    
    hr = pDevice->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void**)&pSessionManager);
    if (FAILED(hr)) goto cleanup;
    
    hr = pSessionManager->GetSessionEnumerator(&pSessionEnum);
    if (FAILED(hr)) goto cleanup;
    
    {
        int count = 0;
        pSessionEnum->GetCount(&count);
        uint32_t idx = 0;
        
        for (int i = 0; i < count; i++) {
            IAudioSessionControl* pCtrl = nullptr;
            IAudioSessionControl2* pCtrl2 = nullptr;
            ISimpleAudioVolume* pVolume = nullptr;
            
            hr = pSessionEnum->GetSession(i, &pCtrl);
            if (FAILED(hr) || !pCtrl) continue;
            
            hr = pCtrl->QueryInterface(__uuidof(IAudioSessionControl2), (void**)&pCtrl2);
            if (FAILED(hr) || !pCtrl2) { SafeRelease(pCtrl); continue; }
            
            AudioSessionState state;
            pCtrl->GetState(&state);
            if (state == AudioSessionStateExpired) {
                SafeRelease(pCtrl2);
                SafeRelease(pCtrl);
                continue;
            }
            
            DWORD pid = 0;
            pCtrl2->GetProcessId(&pid);
            
            if (pid == 0 && !pCtrl2->IsSystemSoundsSession()) {
                SafeRelease(pCtrl2);
                SafeRelease(pCtrl);
                continue;
            }
            
            std::string processName = GetProcessName(pid);
            float volume = 1.0f;
            hr = pCtrl->QueryInterface(__uuidof(ISimpleAudioVolume), (void**)&pVolume);
            if (SUCCEEDED(hr) && pVolume) {
                pVolume->GetMasterVolume(&volume);
                SafeRelease(pVolume);
            }
            
            bool isActive = (state == AudioSessionStateActive);
            
            Napi::Object session = Napi::Object::New(env);
            session.Set("pid", Napi::Number::New(env, (double)pid));
            session.Set("name", Napi::String::New(env, processName));
            session.Set("volume", Napi::Number::New(env, (double)volume));
            session.Set("active", Napi::Boolean::New(env, isActive));
            session.Set("isSystem", Napi::Boolean::New(env, pCtrl2->IsSystemSoundsSession() == S_OK));
            
            result.Set(idx++, session);
            
            SafeRelease(pCtrl2);
            SafeRelease(pCtrl);
        }
    }

cleanup:
    SafeRelease(pSessionEnum);
    SafeRelease(pSessionManager);
    SafeRelease(pDevice);
    SafeRelease(pEnumerator);
    if (needUninit) CoUninitialize();
    
    return result;
}

// ── Capture Thread: WASAPI loopback with PID exclusion ──
static void CaptureAudioLoop() {
    // Elevate thread priority to Pro Audio to avoid stuttering under high CPU load (e.g. gaming)
    DWORD mmcssTask = 0;
    HANDLE hMmcss = AvSetMmThreadCharacteristicsW(L"Pro Audio", &mmcssTask);

    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) {
        if (hMmcss) AvRevertMmThreadCharacteristics(hMmcss);
        return;
    }
    
    IMMDeviceEnumerator* pEnumerator = nullptr;
    IMMDevice* pDevice = nullptr;
    IAudioClient* pAudioClient = nullptr;
    IAudioCaptureClient* pCaptureClient = nullptr;
    IAudioSessionManager2* pSessionManager = nullptr;
    
    std::string currentMode;
    DWORD currentTargetPid = 0;
    std::set<DWORD> localExcluded;
    std::vector<uint8_t> accumulator;
    
    // Initial fetch of variables
    {
        std::lock_guard<std::mutex> lock(g_excludeMutex);
        currentMode = g_captureMode;
        currentTargetPid = g_targetPid;
        localExcluded = g_excludedPids;
    }
    g_pidsChanged = false;

    if (currentMode == "include" && currentTargetPid != 0) {
        // Use Windows 11 Process Loopback API
        AUDIOCLIENT_ACTIVATION_PARAMS params = {};
        params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
        params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
        params.ProcessLoopbackParams.TargetProcessId = currentTargetPid;
        
        PROPVARIANT propVariant = {};
        propVariant.vt = VT_BLOB;
        propVariant.blob.cbSize = sizeof(params);
        propVariant.blob.pBlobData = (BYTE*)&params;
        
        AudioClientActivationHandler* pHandler = new AudioClientActivationHandler();
        pHandler->AddRef();
        IActivateAudioInterfaceAsyncOperation* pOperation = nullptr;
        
        hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &propVariant, pHandler, &pOperation);
        if (SUCCEEDED(hr)) {
            hr = pHandler->Wait(&pAudioClient);
        }
        if (pOperation) pOperation->Release();
        pHandler->Release();
        
        if (!pAudioClient) {
            // Fallback for Windows 10 where Process Loopback API is not available
            currentMode = "legacy";
            localExcluded = g_fallbackExcludedPids;
        }
    }
    
    WAVEFORMATEX format = {};
    if (currentMode != "include") {
        // Use standard system endpoint loopback
        hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                              __uuidof(IMMDeviceEnumerator), (void**)&pEnumerator);
        if (FAILED(hr)) goto done;
        
        hr = pEnumerator->GetDefaultAudioEndpoint(eRender, eConsole, &pDevice);
        if (FAILED(hr)) goto done;
        
        hr = pDevice->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&pAudioClient);
        if (FAILED(hr)) goto done;
        
        // Session manager for muting (legacy mode)
        pDevice->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void**)&pSessionManager);
    }
    
    if (!pAudioClient) goto done;

    format.wFormatTag = WAVE_FORMAT_PCM;
    format.nChannels = 2;
    format.nSamplesPerSec = 48000;
    format.wBitsPerSample = 16;
    format.nBlockAlign = (format.nChannels * format.wBitsPerSample) / 8;
    format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
    format.cbSize = 0;
    
    // Let Windows handle the resampling via AUTOCONVERTPCM
    hr = pAudioClient->Initialize(AUDCLNT_SHAREMODE_SHARED,
                                  AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                                  AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                                  2000000, 0, &format, nullptr);
    if (FAILED(hr)) goto done;

    HANDLE hEvent;
    hEvent = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    if (!hEvent) goto done;

    hr = pAudioClient->SetEventHandle(hEvent);
    if (FAILED(hr)) {
        CloseHandle(hEvent);
        goto done;
    }
    
    hr = pAudioClient->GetService(__uuidof(IAudioCaptureClient), (void**)&pCaptureClient);
    if (FAILED(hr)) {
        CloseHandle(hEvent);
        goto done;
    }
    
    hr = pAudioClient->Start();
    if (FAILED(hr)) {
        CloseHandle(hEvent);
        goto done;
    }
    
    while (g_isCapturing) {
        if (g_pidsChanged.exchange(false)) {
            std::lock_guard<std::mutex> lock(g_excludeMutex);
            if (currentMode != "legacy" || g_captureMode != "include") {
                currentMode = g_captureMode;
                localExcluded = g_excludedPids;
            }
        }
        
        // Wait for the OS to wake us up when audio is ready or timeout to allow checking g_isCapturing
        DWORD waitResult = WaitForSingleObject(hEvent, 100);
        if (waitResult != WAIT_OBJECT_0) {
            continue;
        }

        UINT32 packetLength = 0;
        hr = pCaptureClient->GetNextPacketSize(&packetLength);
        
        while (packetLength != 0 && g_isCapturing) {
            BYTE* pData = nullptr;
            UINT32 numFramesAvailable = 0;
            DWORD flags = 0;
            
            hr = pCaptureClient->GetBuffer(&pData, &numFramesAvailable, &flags, nullptr, nullptr);
            if (SUCCEEDED(hr)) {
                bool isSilent = (flags & AUDCLNT_BUFFERFLAGS_SILENT);
                
                if (numFramesAvailable > 0) {
                    size_t bytesToCopy = numFramesAvailable * format.nBlockAlign;
                    
                    std::vector<uint8_t> convertedBytes(bytesToCopy, 0);
                    if (!isSilent && pData) {
                        memcpy(convertedBytes.data(), pData, bytesToCopy);
                    }
                    
                    accumulator.insert(accumulator.end(), convertedBytes.begin(), convertedBytes.end());

                    // Envia via IPC apenas quando acumular ~50ms de áudio de 48kHz
                    size_t targetBatchSize = (48000 / 20) * format.nBlockAlign;
                    
                    if (accumulator.size() >= targetBatchSize) {
                        auto* buffer = new std::vector<uint8_t>(std::move(accumulator));
                        accumulator.clear();
                        
                        auto callback = [](Napi::Env env, Napi::Function jsCallback, std::vector<uint8_t>* data) {
                            if (env != nullptr && !jsCallback.IsEmpty()) {
                                Napi::Buffer<uint8_t> jsBuffer = Napi::Buffer<uint8_t>::New(
                                    env, data->data(), data->size(), 
                                    [](Napi::Env, uint8_t*, std::vector<uint8_t>* hint) {
                                        delete hint;
                                    }, data);
                                jsCallback.Call({jsBuffer});
                            } else {
                                delete data;
                            }
                        };
                        
                        if (g_tsfn.BlockingCall(buffer, callback) != napi_ok) {
                            delete buffer; // Queue closed or failed
                        }
                    }
                }
                
                pCaptureClient->ReleaseBuffer(numFramesAvailable);
            }
            
            hr = pCaptureClient->GetNextPacketSize(&packetLength);
            if (FAILED(hr)) break;
        }
    }
    
    pAudioClient->Stop();
    CloseHandle(hEvent);

done:
    SafeRelease(pCaptureClient);
    SafeRelease(pAudioClient);
    SafeRelease(pSessionManager);
    SafeRelease(pDevice);
    SafeRelease(pEnumerator);
    CoUninitialize();
    if (hMmcss) AvRevertMmThreadCharacteristics(hMmcss);
}

// ── StartCapture ──
Napi::Value StartCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::TypeError::New(env, "Callback function expected").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    if (g_isCapturing) {
        return Napi::Boolean::New(env, true);
    }
    
    {
        std::lock_guard<std::mutex> lock(g_excludeMutex);
        g_captureMode = "legacy";
        g_excludedPids.clear();
        g_targetPid = 0;
        
        if (info.Length() >= 2) {
            if (info[1].IsArray()) {
                Napi::Array arr = info[1].As<Napi::Array>();
                for (uint32_t i = 0; i < arr.Length(); i++) {
                    Napi::Value v = arr.Get(i);
                    if (v.IsNumber()) g_excludedPids.insert(v.As<Napi::Number>().Uint32Value());
                }
            } else if (info[1].IsObject()) {
                Napi::Object opts = info[1].As<Napi::Object>();
                if (opts.Has("mode")) {
                    g_captureMode = opts.Get("mode").As<Napi::String>().Utf8Value();
                }
                if (opts.Has("pids") && opts.Get("pids").IsArray()) {
                    Napi::Array arr = opts.Get("pids").As<Napi::Array>();
                    for (uint32_t i = 0; i < arr.Length(); i++) {
                        Napi::Value v = arr.Get(i);
                        if (v.IsNumber()) {
                            DWORD pid = v.As<Napi::Number>().Uint32Value();
                            if (g_captureMode == "include") {
                                g_targetPid = pid;
                                break; // Only need one for include mode
                            } else {
                                g_excludedPids.insert(pid);
                            }
                        }
                    }
                }
                if (opts.Has("excludePids") && opts.Get("excludePids").IsArray()) {
                    Napi::Array arr = opts.Get("excludePids").As<Napi::Array>();
                    for (uint32_t i = 0; i < arr.Length(); i++) {
                        Napi::Value v = arr.Get(i);
                        if (v.IsNumber()) {
                            g_fallbackExcludedPids.insert(v.As<Napi::Number>().Uint32Value());
                        }
                    }
                }
            }
            if (info[1].IsArray() || info[1].IsObject()) {
                g_pidsChanged = true;
            }
        }
    }
    
    g_tsfn = ThreadSafeFunction::New(env, info[0].As<Napi::Function>(), "CaptureAudio", 0, 1);
    g_isCapturing = true;
    g_captureThread = std::thread(CaptureAudioLoop);
    
    return Napi::Boolean::New(env, true);
}

// ── SetExcludedPids (Atualiza alvos dinâmicos) ──
Napi::Value SetExcludedPids(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    std::string newMode = "legacy";
    std::set<DWORD> newExcluded;
    DWORD newTargetPid = 0;
    
    if (info.Length() >= 1) {
        if (info[0].IsArray()) {
            Napi::Array arr = info[0].As<Napi::Array>();
            for (uint32_t i = 0; i < arr.Length(); i++) {
                Napi::Value v = arr.Get(i);
                if (v.IsNumber()) newExcluded.insert(v.As<Napi::Number>().Uint32Value());
            }
        } else if (info[0].IsObject()) {
            Napi::Object opts = info[0].As<Napi::Object>();
            if (opts.Has("mode")) newMode = opts.Get("mode").As<Napi::String>().Utf8Value();
            if (opts.Has("pids") && opts.Get("pids").IsArray()) {
                Napi::Array arr = opts.Get("pids").As<Napi::Array>();
                for (uint32_t i = 0; i < arr.Length(); i++) {
                    Napi::Value v = arr.Get(i);
                    if (v.IsNumber()) {
                        DWORD pid = v.As<Napi::Number>().Uint32Value();
                        if (newMode == "include") {
                            newTargetPid = pid;
                            break;
                        } else {
                            newExcluded.insert(pid);
                        }
                    }
                }
            }
        }
    }
    
    {
        std::lock_guard<std::mutex> lock(g_excludeMutex);
        g_captureMode = newMode;
        g_targetPid = newTargetPid;
        g_excludedPids = newExcluded;
        g_pidsChanged = true;
    }
    
    // Em modo legacy (Windows 10), não silenciamos mais no nível do SO
    // pois isso prejudicava o usuário (mutando o app no seu próprio fone de ouvido).
    // O áudio vazará para a transmissão se o isolamento não for possível pelo SO.
    
    return Napi::Boolean::New(env, true);
}

// ── StopCapture ──
Napi::Value StopCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    g_isCapturing = false;
    if (g_captureThread.joinable()) {
        g_captureThread.join();
    }
    // Sem limpeza de legacy mutes, pois não mutamos mais o áudio do SO.
    
    if (g_tsfn) {
        g_tsfn.Release();
        g_tsfn = Napi::ThreadSafeFunction();
    }
    
    return Napi::Boolean::New(env, true);
}

Napi::Value GetPidFromHwnd(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        return Napi::Number::New(env, 0);
    }
    
    std::string hwndStr = info[0].As<Napi::String>().Utf8Value();
    // Extrai o HWND numérico da string, que geralmente vem como "window:HWND:0" do Electron
    size_t colon1 = hwndStr.find(':');
    size_t colon2 = hwndStr.find(':', colon1 != std::string::npos ? colon1 + 1 : 0);
    
    std::string idPart = hwndStr;
    if (colon1 != std::string::npos && colon2 != std::string::npos) {
        idPart = hwndStr.substr(colon1 + 1, colon2 - colon1 - 1);
    } else if (colon1 != std::string::npos) {
        idPart = hwndStr.substr(colon1 + 1);
    }
    
    DWORD pid = 0;
    try {
        HWND hwnd = (HWND)std::stoull(idPart);
        GetWindowThreadProcessId(hwnd, &pid);
    } catch (...) {
        // Ignora erros de conversão
    }
    
    return Napi::Number::New(env, (double)pid);
}

Napi::Value GetWindowHeight(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        return Napi::Number::New(env, 0);
    }
    
    std::string hwndStr = info[0].As<Napi::String>().Utf8Value();
    size_t colon1 = hwndStr.find(':');
    size_t colon2 = hwndStr.find(':', colon1 != std::string::npos ? colon1 + 1 : 0);
    
    std::string idPart = hwndStr;
    if (colon1 != std::string::npos && colon2 != std::string::npos) {
        idPart = hwndStr.substr(colon1 + 1, colon2 - colon1 - 1);
    } else if (colon1 != std::string::npos) {
        idPart = hwndStr.substr(colon1 + 1);
    }
    
    int height = 0;
    try {
        HWND hwnd = (HWND)std::stoull(idPart);
        RECT rect;
        if (GetWindowRect(hwnd, &rect)) {
            height = rect.bottom - rect.top;
        }
    } catch (...) {
        // Ignore conversion errors
    }
    
    return Napi::Number::New(env, (double)height);
}

void Cleanup(void* arg) {
    g_isCapturing = false;
    if (g_captureThread.joinable()) {
        g_captureThread.join();
    }
    if (g_tsfn) {
        g_tsfn.Release();
        g_tsfn = Napi::ThreadSafeFunction();
    }
}

// ── Module Init ──
Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("getAudioSessions", Napi::Function::New(env, GetAudioSessions));
    exports.Set("startCapture", Napi::Function::New(env, StartCapture));
    exports.Set("stopCapture", Napi::Function::New(env, StopCapture));
    exports.Set("setExcludedPids", Napi::Function::New(env, SetExcludedPids));
    exports.Set("getPidFromHwnd", Napi::Function::New(env, GetPidFromHwnd));
    exports.Set("getWindowHeight", Napi::Function::New(env, GetWindowHeight));
    
    napi_status status = napi_add_env_cleanup_hook(env, Cleanup, nullptr);
    return exports;
}

NODE_API_MODULE(audio_mixer, Init)
