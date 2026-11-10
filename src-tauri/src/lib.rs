mod archive;
mod fsops;

use base64::Engine;
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, WebviewWindow};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

// ---------- хранение досок ----------

fn data_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("boards.json"))
}

#[tauri::command]
fn load_data(app: AppHandle) -> Result<String, String> {
    let file = data_file(&app)?;
    match fs::read_to_string(&file) {
        Ok(s) => Ok(s),
        Err(_) => {
            // если основной файл повреждён/отсутствует — пробуем резервную копию
            Ok(fs::read_to_string(file.with_extension("json.bak")).unwrap_or_default())
        }
    }
}

#[tauri::command]
fn save_data(app: AppHandle, json: String) -> Result<(), String> {
    let file = data_file(&app)?;
    let tmp = file.with_extension("json.tmp");
    fs::write(&tmp, json.as_bytes()).map_err(|e| e.to_string())?;
    if file.exists() {
        let _ = fs::copy(&file, file.with_extension("json.bak"));
    }
    fs::rename(&tmp, &file).map_err(|e| e.to_string())
}

// ---------- информация о путях ----------

#[derive(Serialize)]
struct PathInfo {
    exists: bool,
    is_dir: bool,
}

#[tauri::command]
fn path_info(paths: Vec<String>) -> Vec<PathInfo> {
    paths
        .iter()
        .map(|p| {
            let m = fs::metadata(p);
            PathInfo {
                exists: m.is_ok(),
                is_dir: m.map(|m| m.is_dir()).unwrap_or(false),
            }
        })
        .collect()
}

// ---------- открытие / показ в папке ----------

#[cfg(windows)]
fn shell_execute(verb: &str, file: &str, params: Option<&str>) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let verb = HSTRING::from(verb);
    let file_h = HSTRING::from(file);
    let params_h = HSTRING::from(params.unwrap_or(""));
    let r = unsafe {
        ShellExecuteW(
            HWND::default(),
            &verb,
            &file_h,
            &params_h,
            &HSTRING::new(),
            SW_SHOWNORMAL,
        )
    };
    if r.0 as isize > 32 {
        Ok(())
    } else {
        Err(format!("Не удалось открыть (код {})", r.0 as isize))
    }
}

#[tauri::command]
async fn open_path(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err("Файл не найден — возможно, его переместили или удалили".into());
    }
    tauri::async_runtime::spawn_blocking(move || shell_execute("open", &path, None))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn open_url(url: String) -> Result<(), String> {
    let lower = url.to_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:")) {
        return Err("Поддерживаются только ссылки http/https".into());
    }
    tauri::async_runtime::spawn_blocking(move || shell_execute("open", &url, None))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let p = Path::new(&path);
    if p.exists() {
        std::process::Command::new("explorer.exe")
            .raw_arg(format!("/select,\"{}\"", path))
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    // файла нет — открываем ближайшую существующую родительскую папку
    let mut cur = p.parent();
    while let Some(dir) = cur {
        if dir.exists() {
            std::process::Command::new("explorer.exe")
                .arg(dir)
                .spawn()
                .map_err(|e| e.to_string())?;
            return Ok(());
        }
        cur = dir.parent();
    }
    Err("Папка не найдена".into())
}

#[tauri::command]
fn open_with(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err("Файл не найден".into());
    }
    std::process::Command::new("rundll32.exe")
        .arg("shell32.dll,OpenAs_RunDLL")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- иконки и превью ----------

#[cfg(windows)]
fn shell_image_png(path: &str, size: i32, icon_only: bool) -> Result<Vec<u8>, String> {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
    };
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{
        IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF, SIIGBF_BIGGERSIZEOK,
        SIIGBF_ICONONLY,
    };

    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let factory: IShellItemImageFactory =
            SHCreateItemFromParsingName(&HSTRING::from(path), None).map_err(|e| e.to_string())?;
        let hbmp = factory
            .GetImage(
                SIZE { cx: size, cy: size },
                SIIGBF(SIIGBF_BIGGERSIZEOK.0 | if icon_only { SIIGBF_ICONONLY.0 } else { 0 }),
            )
            .map_err(|e| e.to_string())?;
        let obj = HGDIOBJ(hbmp.0);

        let mut bm = BITMAP::default();
        GetObjectW(obj, std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut _));
        let (w, h) = (bm.bmWidth, bm.bmHeight.abs());
        if w <= 0 || h <= 0 {
            let _ = DeleteObject(obj);
            return Err("empty bitmap".into());
        }

        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // сверху вниз
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut buf = vec![0u8; (w * h * 4) as usize];
        let dc = CreateCompatibleDC(None);
        let lines = GetDIBits(
            dc,
            hbmp,
            0,
            h as u32,
            Some(buf.as_mut_ptr() as *mut _),
            &mut info,
            DIB_RGB_COLORS,
        );
        let _ = DeleteDC(dc);
        let _ = DeleteObject(obj);
        if lines == 0 {
            return Err("GetDIBits failed".into());
        }

        // BGRA (premultiplied) -> RGBA
        let has_alpha = buf.chunks_exact(4).any(|p| p[3] != 0);
        for p in buf.chunks_exact_mut(4) {
            let (b, g, r, a) = (p[0], p[1], p[2], p[3]);
            if !has_alpha {
                p[0] = r;
                p[2] = b;
                p[3] = 255;
            } else if a == 0 {
                p.copy_from_slice(&[0, 0, 0, 0]);
            } else if a == 255 {
                p[0] = r;
                p[2] = b;
            } else {
                let un = |c: u8| ((c as u32 * 255 + a as u32 / 2) / a as u32).min(255) as u8;
                p[0] = un(r);
                p[1] = un(g);
                p[2] = un(b);
            }
        }

        let mut out = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut out, w as u32, h as u32);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            let mut wr = enc.write_header().map_err(|e| e.to_string())?;
            wr.write_image_data(&buf).map_err(|e| e.to_string())?;
        }
        Ok(out)
    }
}

#[tauri::command]
async fn get_icon(
    app: AppHandle,
    path: String,
    size: Option<i32>,
    icon_only: Option<bool>,
) -> Result<String, String> {
    let size = size.unwrap_or(96).clamp(16, 256);
    let icon_only = icon_only.unwrap_or(false);
    let meta = fs::metadata(&path).map_err(|_| "not found".to_string())?;

    // ключ кеша: путь + время изменения + размер
    let mut hasher = DefaultHasher::new();
    path.to_lowercase().hash(&mut hasher);
    if let Ok(m) = meta.modified() {
        m.hash(&mut hasher);
    }
    size.hash(&mut hasher);
    icon_only.hash(&mut hasher);
    let key = format!("{:016x}.png", hasher.finish());

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("icons");
    let cache_file = cache_dir.join(&key);

    if let Ok(bytes) = fs::read(&cache_file) {
        return Ok(format!("data:image/png;base64,{}", B64.encode(bytes)));
    }

    let bytes = tauri::async_runtime::spawn_blocking(move || shell_image_png(&path, size, icon_only))
        .await
        .map_err(|e| e.to_string())??;
    let _ = fs::create_dir_all(&cache_dir);
    let _ = fs::write(&cache_file, &bytes);
    Ok(format!("data:image/png;base64,{}", B64.encode(bytes)))
}

// ---------- перетаскивание наружу ----------

#[tauri::command]
async fn drag_out(
    app: AppHandle,
    window: WebviewWindow,
    paths: Vec<String>,
    icon: Option<String>,
) -> Result<(), String> {
    let files: Vec<PathBuf> = paths
        .into_iter()
        .map(PathBuf::from)
        .filter(|p| p.exists())
        .collect();
    if files.is_empty() {
        return Err("Файлы не найдены".into());
    }
    let image_bytes = icon
        .as_deref()
        .and_then(|s| s.strip_prefix("data:image/png;base64,"))
        .and_then(|b| B64.decode(b).ok())
        .unwrap_or_default();

    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let r = drag::start_drag(
            &window,
            drag::DragItem::Files(files),
            drag::Image::Raw(image_bytes),
            |_result, _pos| {},
            drag::Options::default(),
        );
        let _ = tx.send(r.map_err(|e| e.to_string()));
    })
    .map_err(|e| e.to_string())?;

    tauri::async_runtime::spawn_blocking(move || rx.recv().unwrap_or(Ok(())))
        .await
        .map_err(|e| e.to_string())?
}

// ---------- запуск ----------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            load_data,
            save_data,
            path_info,
            open_path,
            open_url,
            reveal_path,
            open_with,
            get_icon,
            drag_out,
            fsops::list_dir,
            fsops::places,
            fsops::rename_path,
            fsops::create_folder,
            fsops::file_op,
            fsops::clipboard_set_files,
            fsops::clipboard_get_files,
            fsops::clipboard_clear,
            archive::archiver_info,
            archive::archive_pack,
            archive::archive_unpack
        ])
        .run(tauri::generate_context!())
        .expect("error while running FileBoard");
}
