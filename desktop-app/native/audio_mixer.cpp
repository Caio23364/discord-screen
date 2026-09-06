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
        WaitForSingleObject(m_hEvent, INFINITE);
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
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) return;
    
    IMMDeviceEnumerator* pEnumerator = nullptr;
    IMMDevice* pDevice = nullptr;
    IAudioClient* pAudioClient = nullptr;
    IAudioCaptureClient* pCaptureClient = nullptr;
    IAudioSessionManager2* pSessionManager = nullptr;
    WAVEFORMATEX* pwfx = nullptr;
    
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

    hr = pAudioClient->GetMixFormat(&pwfx);
    if (FAILED(hr)) goto done;
    
    // Calcule the device's buffer duration to wait dynamically instead of 5ms static
    // By default 10000000 = 1 sec. For low latency we ask 0 or a very short time.
    hr = pAudioClient->Initialize(AUDCLNT_SHAREMODE_SHARED,
                                  AUDCLNT_STREAMFLAGS_LOOPBACK,
                                  0, 0, pwfx, nullptr);
    if (FAILED(hr)) goto done;
    
    hr = pAudioClient->GetService(__uuidof(IAudioCaptureClient), (void**)&pCaptureClient);
    if (FAILED(hr)) goto done;
    
    hr = pAudioClient->Start();
    if (FAILED(hr)) goto done;
    
    while (g_isCapturing) {
        if (g_pidsChanged.exchange(false)) {
            std::lock_guard<std::mutex> lock(g_excludeMutex);
            // If we are falling back, don't overwrite currentMode back to "include"
            // Actually, g_pidsChanged is checked here ONCE. But we already fetched them at the top!
            // This is just for dynamic updates while running.
            if (currentMode != "legacy" || g_captureMode != "include") {
                currentMode = g_captureMode;
                localExcluded = g_excludedPids;
            }
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
                    size_t bytesToCopy = numFramesAvailable * pwfx->nBlockAlign;
                    
                    if (isSilent) {
                        // Se for silêncio, preenche com zeros no lugar de alocar lixo
                        static std::vector<uint8_t> silenceData(bytesToCopy, 0);
                        accumulator.insert(accumulator.end(), silenceData.begin(), silenceData.end());
                    } else {
                        accumulator.insert(accumulator.end(), pData, pData + bytesToCopy);
                    }

                    // Envia via IPC apenas quando acumular ~50ms de áudio (reduz a carga da IPC em 5x)
                    size_t targetBatchSize = (pwfx->nSamplesPerSec / 20) * pwfx->nBlockAlign; // 50ms
                    
                    if (accumulator.size() >= targetBatchSize) {
                        auto* buffer = new std::vector<uint8_t>(std::move(accumulator));
                        accumulator.clear(); // Prepara para a próxima leva
                        
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
        
        Sleep(5); // A low wait is normal for non-event loopback. 5ms is fine if we aren't locking mutexes heavily.
    }
    
    pAudioClient->Stop();

done:
    if (pwfx) CoTaskMemFree(pwfx);
    SafeRelease(pCaptureClient);
    SafeRelease(pAudioClient);
    SafeRelease(pSessionManager);
    SafeRelease(pDevice);
    SafeRelease(pEnumerator);
    CoUninitialize();
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

// ── SetExcludedPids (Mutes excluded apps in legacy mode) ──
const GUID STRAWBERRY_CONTEXT = { 0xdeadbeef, 0xb00b, 0xface, { 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01 } };

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
    
    if (newMode == "legacy") {
        HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        bool needUninit = SUCCEEDED(hr);
        
        IMMDeviceEnumerator* pEnumerator = nullptr;
        IMMDevice* pDevice = nullptr;
        IAudioSessionManager2* pSessionManager = nullptr;
        IAudioSessionEnumerator* pSessionEnum = nullptr;
        
        hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                              __uuidof(IMMDeviceEnumerator), (void**)&pEnumerator);
        if (FAILED(hr)) goto done_update;
        
        hr = pEnumerator->GetDefaultAudioEndpoint(eRender, eConsole, &pDevice);
        if (FAILED(hr)) goto done_update;
        
        hr = pDevice->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void**)&pSessionManager);
        if (FAILED(hr)) goto done_update;
        
        hr = pSessionManager->GetSessionEnumerator(&pSessionEnum);
        if (FAILED(hr)) goto done_update;
        
        {
            int count = 0;
            pSessionEnum->GetCount(&count);
            
            for (int i = 0; i < count; i++) {
                IAudioSessionControl* pCtrl = nullptr;
                IAudioSessionControl2* pCtrl2 = nullptr;
                ISimpleAudioVolume* pVolume = nullptr;
                
                pSessionEnum->GetSession(i, &pCtrl);
                if (!pCtrl) continue;
                
                hr = pCtrl->QueryInterface(__uuidof(IAudioSessionControl2), (void**)&pCtrl2);
                if (FAILED(hr) || !pCtrl2) { SafeRelease(pCtrl); continue; }
                
                DWORD pid = 0;
                pCtrl2->GetProcessId(&pid);
                
                hr = pCtrl->QueryInterface(__uuidof(ISimpleAudioVolume), (void**)&pVolume);
                if (SUCCEEDED(hr) && pVolume) {
                    if (newExcluded.find(pid) != newExcluded.end()) {
                        pVolume->SetMute(TRUE, &STRAWBERRY_CONTEXT);
                    } else {
                        BOOL isMuted = FALSE;
                        pVolume->GetMute(&isMuted);
                        if (isMuted) pVolume->SetMute(FALSE, &STRAWBERRY_CONTEXT);
                    }
                    SafeRelease(pVolume);
                }
                
                SafeRelease(pCtrl2);
                SafeRelease(pCtrl);
            }
        }
        
done_update:
        SafeRelease(pSessionEnum);
        SafeRelease(pSessionManager);
        SafeRelease(pDevice);
        SafeRelease(pEnumerator);
        if (needUninit) CoUninitialize();
    }
    
    return Napi::Boolean::New(env, true);
}

// ── StopCapture ──
Napi::Value StopCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    g_isCapturing = false;
    if (g_captureThread.joinable()) {
        g_captureThread.join();
    }
    
    // Unmute everything left over in legacy mode
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    bool needUninit = SUCCEEDED(hr);
    
    IMMDeviceEnumerator* pEnumerator = nullptr;
    IMMDevice* pDevice = nullptr;
    IAudioSessionManager2* pSessionManager = nullptr;
    IAudioSessionEnumerator* pSessionEnum = nullptr;
    
    hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                          __uuidof(IMMDeviceEnumerator), (void**)&pEnumerator);
    if (SUCCEEDED(hr)) hr = pEnumerator->GetDefaultAudioEndpoint(eRender, eConsole, &pDevice);
    if (SUCCEEDED(hr)) hr = pDevice->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void**)&pSessionManager);
    if (SUCCEEDED(hr)) hr = pSessionManager->GetSessionEnumerator(&pSessionEnum);
    
    if (SUCCEEDED(hr)) {
        int count = 0;
        pSessionEnum->GetCount(&count);
        
        for (int i = 0; i < count; i++) {
            IAudioSessionControl* pCtrl = nullptr;
            ISimpleAudioVolume* pVolume = nullptr;
            
            pSessionEnum->GetSession(i, &pCtrl);
            if (!pCtrl) continue;
            
            hr = pCtrl->QueryInterface(__uuidof(ISimpleAudioVolume), (void**)&pVolume);
            if (SUCCEEDED(hr) && pVolume) {
                pVolume->SetMute(FALSE, &STRAWBERRY_CONTEXT);
                SafeRelease(pVolume);
            }
            SafeRelease(pCtrl);
        }
    }
    
    SafeRelease(pSessionEnum);
    SafeRelease(pSessionManager);
    SafeRelease(pDevice);
    SafeRelease(pEnumerator);
    if (needUninit) CoUninitialize();
    
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
