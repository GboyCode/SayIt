//! 录音期间静音系统输出（默认扬声器）——防止外放的声音被麦克风回采。
//!
//! 只在采集期间静音，松开热键立即恢复到用户原本的静音状态：
//! - `mute_system_output`：记录当前默认输出设备的静音状态，然后静音。
//! - `restore_system_output`：恢复到之前记录的状态（若用户本来就是静音，则保持静音）。
//!
//! 用「保存/恢复原状态」而非「无脑取消静音」，避免录完后把用户原本的静音误开成有声。

use serde::Serialize;

#[cfg(windows)]
use once_cell::sync::Lazy;
#[cfg(windows)]
use std::sync::Mutex;

/// 查询麦克风静音状态的结果。
/// - `matched`：是否成功定位到目标设备（默认设备总能定位；指定设备需按名字唯一匹配到）。
///   为 false 时前端不应据此判定，应退回基于音频信号的检测。
/// - `muted`：目标设备在系统层面是否被静音。
#[derive(Debug, Clone, Serialize)]
pub struct MicMuteState {
    pub matched: bool,
    pub muted: bool,
}

/// 保存的「静音前的原始状态」。None 表示当前未处于我们施加的静音中。
#[cfg(windows)]
static SAVED_MUTE_STATE: Lazy<Mutex<Option<bool>>> = Lazy::new(|| Mutex::new(None));

/// 获取默认渲染端点（扬声器）的音量控制接口，并在其上执行闭包。
#[cfg(windows)]
unsafe fn with_endpoint_volume<F, R>(f: F) -> Result<R, String>
where
    F: FnOnce(&windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume) -> Result<R, String>,
{
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };

    let co_init_result = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    let need_co_uninit = co_init_result.is_ok();

    let result = (|| -> Result<R, String> {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("CoCreateInstance MMDeviceEnumerator: {}", e))?;

        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .map_err(|e| format!("GetDefaultAudioEndpoint: {}", e))?;

        let endpoint: IAudioEndpointVolume = device
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| format!("Activate IAudioEndpointVolume: {}", e))?;

        f(&endpoint)
    })();

    if need_co_uninit {
        CoUninitialize();
    }

    result
}

/// 记录当前默认输出设备静音状态并将其静音。
/// 返回 true 表示已处理（Windows），false 表示非 Windows 平台跳过。
#[tauri::command]
pub fn mute_system_output() -> Result<bool, String> {
    #[cfg(windows)]
    unsafe {
        with_endpoint_volume(|ep| {
            let was_muted = ep
                .GetMute()
                .map_err(|e| format!("GetMute: {}", e))?
                .as_bool();

            // 仅在首次静音时保存原状态，避免重复调用覆盖真实原值
            {
                let mut saved = SAVED_MUTE_STATE.lock().unwrap();
                if saved.is_none() {
                    *saved = Some(was_muted);
                }
            }

            if !was_muted {
                ep.SetMute(true, std::ptr::null())
                    .map_err(|e| format!("SetMute(true): {}", e))?;
            }

            crate::commands::system::write_log_line(&format!(
                "[RUST] [audio_mute] muted output (prev_muted={})",
                was_muted
            ));
            Ok(true)
        })
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

/// 恢复到 `mute_system_output` 之前记录的静音状态。
/// 若没有记录（未曾静音），则不做任何操作。
#[tauri::command]
pub fn restore_system_output() -> Result<bool, String> {
    #[cfg(windows)]
    unsafe {
        let saved = {
            let mut s = SAVED_MUTE_STATE.lock().unwrap();
            s.take()
        };

        match saved {
            Some(prev) => with_endpoint_volume(|ep| {
                ep.SetMute(windows::Win32::Foundation::BOOL::from(prev), std::ptr::null())
                    .map_err(|e| format!("SetMute restore: {}", e))?;
                crate::commands::system::write_log_line(&format!(
                    "[RUST] [audio_mute] restored output (mute={})",
                    prev
                ));
                Ok(true)
            }),
            None => Ok(false),
        }
    }
    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

// ─────────────────────────────────────────────────────────────────────────
// 麦克风静音状态查询
// ─────────────────────────────────────────────────────────────────────────

/// 查询采集设备的静音状态。
///
/// 当前实现只可靠支持「系统默认麦克风」（`label` 为 None/空）：直接查默认采集端点的静音开关。
/// 若指定了特定设备名（`label` 非空），由于浏览器 deviceId 与系统设备不易可靠对应（按友好名
/// 匹配在 windows-rs 0.58 上读取属性受限，且同名设备会有歧义），这里返回 `matched=false`，
/// 交由前端基于音频信号的检测兜底，避免误报。后续可在此扩展按名字匹配。
#[cfg(windows)]
unsafe fn query_mic_mute(label: Option<&str>) -> Result<MicMuteState, String> {
    // 指定了特定设备 → 暂不做匹配，交给信号检测
    if label.map(str::trim).filter(|s| !s.is_empty()).is_some() {
        return Ok(MicMuteState { matched: false, muted: false });
    }

    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{eCapture, eConsole, IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };

    let co_init_result = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    let need_co_uninit = co_init_result.is_ok();

    let result = (|| -> Result<MicMuteState, String> {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("CoCreateInstance MMDeviceEnumerator: {}", e))?;
        let device = enumerator
            .GetDefaultAudioEndpoint(eCapture, eConsole)
            .map_err(|e| format!("GetDefaultAudioEndpoint(eCapture): {}", e))?;
        let endpoint: IAudioEndpointVolume = device
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| format!("Activate IAudioEndpointVolume: {}", e))?;
        let muted = endpoint
            .GetMute()
            .map_err(|e| format!("GetMute: {}", e))?
            .as_bool();
        Ok(MicMuteState { matched: true, muted })
    })();

    if need_co_uninit {
        CoUninitialize();
    }

    result
}

/// 查询麦克风是否被系统静音。
/// `device_label`：前端选中麦克风的名字（enumerateDevices 的 label）；传 None/空表示系统默认麦克风。
/// 返回 `matched=false` 时表示无法可靠定位设备（如选了特定设备但同名多个），前端应退回信号检测。
#[tauri::command]
pub fn get_mic_mute_state(device_label: Option<String>) -> MicMuteState {
    #[cfg(windows)]
    unsafe {
        match query_mic_mute(device_label.as_deref()) {
            Ok(state) => state,
            Err(e) => {
                crate::commands::system::write_log_line(&format!(
                    "[RUST] [audio_mute] get_mic_mute_state failed: {}",
                    e
                ));
                MicMuteState { matched: false, muted: false }
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = device_label;
        MicMuteState { matched: false, muted: false }
    }
}
